use serde_json::{json, Value};

#[derive(Clone)]
struct Sample {
    packet: Value,
    offset: u64,
}

/// ACC and AC Evo timer-reset detector. `offset` is the actual encoded record prefix.
pub struct KunosDetector {
    game: String,
    session: Option<Value>,
    lap: Vec<Sample>,
    lap_number: i64,
    peak_current: f64,
    best: f64,
    first_partial: bool,
    last_emitted: i64,
    last_active_ms: Option<u64>,
}

impl KunosDetector {
    pub fn new(game_id: &str) -> Result<Self, String> {
        if game_id != "acc" && game_id != "ac-evo" {
            return Err(format!("unsupported Kunos game: {game_id}"));
        }
        Ok(Self {
            game: game_id.to_owned(), session: None, lap: Vec::new(), lap_number: -1,
            peak_current: 0.0, best: 0.0, first_partial: false, last_emitted: -1,
            last_active_ms: None,
        })
    }

    pub fn feed(&mut self, packet: Value, offset: u64) -> Result<Vec<Value>, String> {
        self.feed_at(packet, offset, 0)
    }

    pub fn feed_at(&mut self, packet: Value, offset: u64, host_time_ms: u64) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        self.last_active_ms = Some(host_time_ms);
        if self.session.is_none() {
            self.start_session(&packet, &mut out);
            self.lap_number = if n(&packet, "LapNumber") > 0.0 { n(&packet, "LapNumber") as i64 } else { 1 };
            self.first_partial = n(&packet, "CurrentLap") > 5.0;
            self.lap.push(Sample { packet: packet.clone(), offset });
            self.peak_current = n(&packet, "CurrentLap");
            return Ok(out);
        }

        let prev = self.lap.last().map(|s| s.packet.clone());
        if prev.as_ref().is_some_and(|p| n(p, "DistanceTraveled") - n(&packet, "DistanceTraveled") > 100.0) {
            self.lap.clear();
            self.peak_current = 0.0;
            self.first_partial = false;
            self.lap.push(Sample { packet: packet.clone(), offset });
            self.peak_current = n(&packet, "CurrentLap");
            return Ok(out);
        }

        let reset = prev.as_ref().is_some_and(|p| n(p, "CurrentLap") >= 5.0 && n(&packet, "CurrentLap") <= 2.0);
        let advanced = n(&packet, "LapNumber") > self.lap_number as f64;
        let fresh_last = n(&packet, "LastLap") > 0.0
            && prev.as_ref().is_some_and(|p| n(p, "LastLap") != n(&packet, "LastLap"));

        // First ACC pit-lane timer can reset before completed-lap/LastLap changes.
        if reset && prev.as_ref().is_some_and(|p| n(p, "CurrentLap") < 30.0) && !advanced && !fresh_last {
            self.lap = vec![Sample { packet: packet.clone(), offset }];
            self.peak_current = n(&packet, "CurrentLap");
            self.first_partial = false;
            return Ok(out);
        }

        let real_reset = reset && (prev.as_ref().is_some_and(|p| n(p, "CurrentLap") >= 30.0) || advanced || fresh_last);
        if real_reset {
            if self.first_partial {
                let distance = self.lap.last().map_or(0.0, |s| n(&s.packet, "DistanceTraveled"))
                    - self.lap.first().map_or(0.0, |s| n(&s.packet, "DistanceTraveled"));
                if distance < 100.0 || classify_pit(&self.lap) == Some("pit lap") {
                    self.lap.clear();
                    self.peak_current = 0.0;
                    self.first_partial = false;
                    self.lap.push(Sample { packet: packet.clone(), offset });
                    self.peak_current = n(&packet, "CurrentLap");
                    return Ok(out);
                }
                self.first_partial = false;
            }
            self.complete(&packet, offset, &mut out);
        }
        self.lap.push(Sample { packet: packet.clone(), offset });
        self.peak_current = self.peak_current.max(n(&packet, "CurrentLap"));
        Ok(out)
    }

    pub fn tick(&mut self, host_time_ms: u64) -> Vec<Value> {
        if self.session.is_some() && self.last_active_ms.is_some_and(|last| host_time_ms.saturating_sub(last) >= 10_000) {
            return self.finish("stale");
        }
        Vec::new()
    }

    pub fn finish(&mut self, reason: &str) -> Vec<Value> {
        let mut out = Vec::new();
        if self.session.is_some() && self.lap.len() >= 10 {
            self.emit_lap(self.peak_current, Some("incomplete"), None, &mut out);
        }
        if self.session.is_some() {
            out.push(json!({"kind":"RECORDING_COMPLETED", "data":{"reason":reason}}));
        }
        self.clear_session();
        out
    }

    pub fn reset(&mut self) {
        if let Ok(next) = Self::new(&self.game) { *self = next; }
    }

    fn start_session(&mut self, p: &Value, out: &mut Vec<Value>) {
        self.session = Some(p.clone());
        self.lap.clear();
        self.best = 0.0;
        self.last_emitted = -1;
        out.push(json!({"kind":"SESSION_STARTED","data":{
            "gameId":self.game,"carOrdinal":n(p,"CarOrdinal"),"trackOrdinal":n(p,"TrackOrdinal"),
            "carPI":get(p,"CarPerformanceIndex"),"sessionUID":get(p,"sessionUID"),
            "sessionType":p.get(if self.game=="acc"{"acc"}else{"acEvo"}).and_then(|v|v.get("sessionType")).cloned().unwrap_or(Value::Null),
            "detectorVersion":"rust-recorder_v1"
        }}));
    }

    fn complete(&mut self, trigger: &Value, trigger_offset: u64, out: &mut Vec<Value>) {
        let fresh = n(trigger, "LastLap") > 0.0
            && self.lap.last().is_some_and(|s| n(&s.packet, "LastLap") != n(trigger, "LastLap"));
        let time = if fresh { n(trigger, "LastLap") } else { self.peak_current };
        if self.lap.len() >= 10 && time >= 10.0 {
            let distance = self.lap.last().map_or(0.0, |s| n(&s.packet, "DistanceTraveled"))
                - self.lap.first().map_or(0.0, |s| n(&s.packet, "DistanceTraveled"));
            if distance >= 100.0 {
                self.emit_lap(time, None, Some((trigger.clone(), trigger_offset)), out);
            }
        }
        self.lap.clear();
        self.lap.push(Sample { packet: trigger.clone(), offset: trigger_offset });
        self.peak_current = 0.0;
    }
    fn emit_lap(&mut self, time: f64, forced: Option<&str>, trigger: Option<(Value, u64)>, out: &mut Vec<Value>) {

        if self.lap.is_empty() || self.lap_number == self.last_emitted { return; }
        self.last_emitted = self.lap_number;
        let mut recipe_samples = self.lap.clone();
        let append = trigger.map(|(p, _)| p);
        if let Some(p) = append.as_ref() { recipe_samples.push(Sample { packet:p.clone(), offset:0 }); }
        let mut reason = forced.map(str::to_owned);
        let acc_valid = if self.game == "acc" {
            recipe_samples.get(recipe_samples.len().saturating_sub(if append.is_some(){2}else{1}))
                .and_then(|s|s.packet.get("acc")).and_then(|a|a.get("isValidLap")).and_then(Value::as_bool)
        } else { None };
        if reason.is_none() {
            if acc_valid == Some(false) { reason = Some("game reported invalid".into()); }
            else if acc_valid != Some(true) {
                reason = quality(&recipe_samples, time).map(str::to_owned)
                    .or_else(|| classify_pit(&recipe_samples).map(str::to_owned));
                if reason.is_none() && self.game == "ac-evo" && track_limit(&recipe_samples) { reason=Some("track limits".into()); }
            }
        }
        let valid = reason.is_none() && time >= 10.0;
        if valid { self.best = if self.best == 0.0 {time} else {self.best.min(time)}; }
        let ranges: Vec<Value> = self.lap.iter().map(|s|json!({"offset":s.offset.to_string(),"count":1})).collect();
        let offset = self.lap.first().map(|s|s.offset.to_string());
        out.push(json!({"kind":"LAP_RECORDED","data":{
            "lapKey":self.lap_number.to_string(),"lapNumber":self.lap_number,"lapTime":time,
            "isValid":valid,"invalidReason":reason,"provisional":false,
            "rawByteOffset":offset,"rawFrameCount":self.lap.len(),"sessionBestLapTime":self.best,
            "analysisRecipe":{"ranges":ranges,"contextOffset":offset,"appendPackets":append.into_iter().collect::<Vec<_>>(),"overrides":[]}
        }}));
        self.lap.clear();
        self.peak_current = 0.0;
        self.lap_number += 1;
    }

    fn clear_session(&mut self) {
        self.session=None; self.lap.clear(); self.lap_number=-1; self.peak_current=0.0;
        self.best=0.0; self.first_partial=false; self.last_emitted=-1; self.last_active_ms=None;
    }
}

fn n(p:&Value,k:&str)->f64 { p.get(k).and_then(Value::as_f64).unwrap_or(0.0) }
fn get(p:&Value,k:&str)->Value { p.get(k).cloned().unwrap_or(Value::Null) }
fn classify_pit(samples:&[Sample])->Option<&'static str> {
    if samples.is_empty(){return None;}
    let state=|p:&Value| p.get("acc").and_then(|v|v.get("pitStatus")).and_then(Value::as_str).map(|s|s!="out");
    let start=state(&samples[0].packet); let end=state(&samples[samples.len()-1].packet);
    let any=samples.iter().any(|s|state(&s.packet)==Some(true));
    if start==Some(true)&&end==Some(true){Some("pit lap")} else if end==Some(true){Some("inlap")} else if any{Some("outlap")}else{None}
}
fn quality(samples:&[Sample],time:f64)->Option<&'static str>{
    if samples.len()<30{return Some("too few telemetry packets");}
    let first=&samples[0].packet; let last=&samples[samples.len()-1].packet;
    if n(last,"DistanceTraveled")-n(first,"DistanceTraveled")<100.0{return Some("telemetry distance too short");}
    let peak=samples.iter().map(|s|n(&s.packet,"CurrentLap")).fold(f64::NEG_INFINITY,f64::max);
    if peak>0.0&&(peak-time).abs()>2.0{return Some("telemetry lap time mismatch");}
    if first.get("gameId").and_then(Value::as_str)==Some("acc")&&n(first,"LapNumber")==0.0&&time<30.0{return Some("starting lap");}
    if first.get("gameId").and_then(Value::as_str)!=Some("acc") {
        let dx=n(last,"PositionX")-n(first,"PositionX"); let dz=n(last,"PositionZ")-n(first,"PositionZ");
        if (dx*dx+dz*dz).sqrt()>20.0{return Some("start/end positions too far apart");}
    }
    None
}
fn track_limit(samples:&[Sample])->bool{
    if samples.is_empty() || samples[0].packet.get("acc").and_then(|a|a.get("isValidLap")).and_then(Value::as_bool)==Some(false){return false;}
    let mut run=0;
    for s in samples {if s.packet.get("acc").and_then(|a|a.get("isValidLap")).and_then(Value::as_bool)==Some(false){run+=1;if run>=2{return true;}}else{run=0;}}
    false
}
