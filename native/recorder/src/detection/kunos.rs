use serde_json::{json, Value};

use super::policy::Sample;

/// Session metadata may be arbitrary JSON on the public packet adapter. Native
/// parser snapshots use scalars/static text, so detection never builds a tree.
#[derive(Clone, Copy)]
pub enum IdentityField<'a> {
    Null,
    Number(f64),
    Text(&'a str),
    Json(&'a Value),
}

impl IdentityField<'_> {
    fn materialize(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Number(value) => json!(value),
            Self::Text(value) => Value::String(value.to_owned()),
            Self::Json(value) => value.clone(),
        }
    }
}

/// All fields consumed by Kunos policy, including missing-field/session
/// metadata semantics. Offset belongs to the encoded source record, not parser.
#[derive(Clone, Copy)]
pub struct KunosSnapshot<'a> {
    pub sample: Sample,
    pub car_ordinal: f64,
    pub track_ordinal: f64,
    pub car_pi: IdentityField<'a>,
    pub session_uid: IdentityField<'a>,
    pub session_type: IdentityField<'a>,
}

impl<'a> KunosSnapshot<'a> {
    pub fn from_value(packet: &'a Value, game: &str) -> Self {
        Self {
            sample: Sample::from_value(packet, 0),
            car_ordinal: n(packet, "CarOrdinal"),
            track_ordinal: n(packet, "TrackOrdinal"),
            car_pi: packet.get("CarPerformanceIndex").map_or(IdentityField::Null, IdentityField::Json),
            session_uid: packet.get("sessionUID").map_or(IdentityField::Null, IdentityField::Json),
            // Public AC Evo presentation nests sessionType inside acc.acEvo;
            // preserve the existing detector's top-level lookup (null).
            session_type: packet.get(if game == "acc" { "acc" } else { "acEvo" })
                .and_then(|value| value.get("sessionType"))
                .map_or(IdentityField::Null, IdentityField::Json),
        }
    }
}

/// ACC and AC Evo timer-reset detector. `offset` is the actual encoded record prefix.
pub struct KunosDetector {
    game: String,
    session_active: bool,
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
            game: game_id.to_owned(), session_active: false, lap: Vec::new(), lap_number: -1,
            peak_current: 0.0, best: 0.0, first_partial: false, last_emitted: -1,
            last_active_ms: None,
        })
    }

    pub fn feed(&mut self, packet: Value, offset: u64) -> Result<Vec<Value>, String> {
        self.feed_at(packet, offset, 0)
    }

    pub fn feed_at(&mut self, packet: Value, offset: u64, host_time_ms: u64) -> Result<Vec<Value>, String> {
        self.feed_ref_at(&packet, offset, host_time_ms)
    }

    pub fn feed_ref_at(&mut self, packet: &Value, offset: u64, host_time_ms: u64) -> Result<Vec<Value>, String> {
        let snapshot = KunosSnapshot::from_value(packet, &self.game);
        self.feed_typed(snapshot, offset, host_time_ms, || packet.clone())
    }

    pub fn feed_typed(
        &mut self, snapshot: KunosSnapshot<'_>, offset: u64, host_time_ms: u64,
        materialize: impl FnOnce() -> Value,
    ) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        self.last_active_ms = Some(host_time_ms);
        let mut sample = snapshot.sample;
        sample.offset = offset;
        let current = sample.current_lap;
        let lap_num = sample.lap_number;
        let last_lap = sample.last_lap;
        let distance = sample.distance;
        if !self.session_active {
            self.start_session(snapshot, &mut out);
            self.lap_number = if lap_num > 0.0 { lap_num as i64 } else { 1 };
            self.first_partial = current > 5.0;
            self.lap.push(sample);
            self.peak_current = current;
            return Ok(out);
        }

        let prev = self.lap.last().map(|s| (s.distance, s.current_lap, s.last_lap));
        if prev.is_some_and(|p| p.0 - distance > 100.0) {
            self.lap.clear();
            self.peak_current = 0.0;
            self.first_partial = false;
            self.lap.push(sample);
            self.peak_current = current;
            return Ok(out);
        }

        let reset = prev.is_some_and(|p| p.1 >= 5.0 && current <= 2.0);
        let advanced = lap_num > self.lap_number as f64;
        let fresh_last = last_lap > 0.0 && prev.is_some_and(|p| p.2 != last_lap);

        if reset && prev.is_some_and(|p| p.1 < 30.0) && !advanced && !fresh_last {
            self.lap.clear();
            self.lap.push(sample);
            self.peak_current = current;
            self.first_partial = false;
            return Ok(out);
        }

        let real_reset = reset && (prev.is_some_and(|p| p.1 >= 30.0) || advanced || fresh_last);
        if real_reset {
            if self.first_partial {
                let distance = self.lap.last().map_or(0.0, |s| s.distance)
                    - self.lap.first().map_or(0.0, |s| s.distance);
                if distance < 100.0 || classify_pit(&self.lap, None) == Some("pit lap") {
                    self.lap.clear();
                    self.peak_current = 0.0;
                    self.first_partial = false;
                    self.lap.push(sample);
                    self.peak_current = current;
                    return Ok(out);
                }
                self.first_partial = false;
            }
            self.complete(sample, materialize, &mut out);
        }
        self.lap.push(sample);
        self.peak_current = self.peak_current.max(current);
        Ok(out)
    }

    pub fn tick(&mut self, host_time_ms: u64) -> Vec<Value> {
        if self.session_active && self.last_active_ms.is_some_and(|last| host_time_ms.saturating_sub(last) >= 10_000) {
            return self.finish("stale");
        }
        Vec::new()
    }

    pub fn finish(&mut self, reason: &str) -> Vec<Value> {
        let mut out = Vec::new();
        if self.session_active && self.lap.len() >= 10 {
            self.emit_lap(self.peak_current, Some("incomplete"), None, None, &mut out);
        }
        if self.session_active {
            out.push(json!({"kind":"RECORDING_COMPLETED", "data":{"reason":reason}}));
        }
        self.clear_session();
        out
    }

    pub fn reset(&mut self) {
        if let Ok(next) = Self::new(&self.game) { *self = next; }
    }

    fn start_session(&mut self, snapshot: KunosSnapshot<'_>, out: &mut Vec<Value>) {
        self.session_active = true;
        self.lap.clear();
        self.best = 0.0;
        self.last_emitted = -1;
        out.push(json!({"kind":"SESSION_STARTED","data":{
            "gameId":self.game,"carOrdinal":snapshot.car_ordinal,"trackOrdinal":snapshot.track_ordinal,
            "carPI":snapshot.car_pi.materialize(),"sessionUID":snapshot.session_uid.materialize(),
            "sessionType":snapshot.session_type.materialize(),
            "detectorVersion":"rust-recorder_v1"
        }}));
    }

    fn complete(&mut self, sample: Sample, materialize: impl FnOnce() -> Value, out: &mut Vec<Value>) {
        let fresh = sample.last_lap > 0.0
            && self.lap.last().is_some_and(|s| s.last_lap != sample.last_lap);
        let time = if fresh { sample.last_lap } else { self.peak_current };
        if self.lap.len() >= 10 && time >= 10.0 {
            let distance = self.lap.last().map_or(0.0, |s| s.distance)
                - self.lap.first().map_or(0.0, |s| s.distance);
            if distance >= 100.0 && self.lap_number != self.last_emitted {
                self.emit_lap(time, None, Some(sample), Some(materialize()), out);
            }
        }
        self.lap.clear();
        // Boundary appears twice in existing source recipes: completion seeds
        // next lap, then feed retains the same source record. Copy scalars only.
        self.lap.push(sample);
        self.peak_current = 0.0;
    }
    fn emit_lap(&mut self, time: f64, forced: Option<&str>, append_sample: Option<Sample>, append: Option<Value>, out: &mut Vec<Value>) {

        if self.lap.is_empty() || self.lap_number == self.last_emitted { return; }
        self.last_emitted = self.lap_number;
        let mut reason = forced.map(str::to_owned);
        let acc_valid = if self.game == "acc" {
            self.lap.last().and_then(|s| s.acc_valid)
        } else { None };
        if reason.is_none() {
            if acc_valid == Some(false) { reason = Some("game reported invalid".into()); }
            else if acc_valid != Some(true) {
                reason = quality(&self.lap, append_sample.as_ref(), time).map(str::to_owned)
                    .or_else(|| classify_pit(&self.lap, append_sample.as_ref()).map(str::to_owned));
                if reason.is_none() && self.game == "ac-evo" && track_limit(&self.lap, append_sample.as_ref()) { reason=Some("track limits".into()); }
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
        self.session_active=false; self.lap.clear(); self.lap_number=-1; self.peak_current=0.0;
        self.best=0.0; self.first_partial=false; self.last_emitted=-1; self.last_active_ms=None;
    }
}

fn n(p:&Value,k:&str)->f64 { p.get(k).and_then(Value::as_f64).unwrap_or(0.0) }
fn classify_pit(samples:&[Sample], append:Option<&Sample>)->Option<&'static str> {
    let first=samples.first()?;
    let last=append.or_else(||samples.last()).unwrap();
    let start=first.pit_state; let end=last.pit_state;
    let any=samples.iter().any(|s|s.pit_state==Some(true)) || append.is_some_and(|p|p.pit_state==Some(true));
    if start==Some(true)&&end==Some(true){Some("pit lap")} else if end==Some(true){Some("inlap")} else if any{Some("outlap")}else{None}
}
fn quality(samples:&[Sample],append:Option<&Sample>,time:f64)->Option<&'static str>{
    let len=samples.len()+usize::from(append.is_some());
    if len<30{return Some("too few telemetry packets");}
    let first=&samples[0];
    let last=append.unwrap_or(&samples[samples.len()-1]);
    if last.distance-first.distance<100.0{return Some("telemetry distance too short");}
    let peak=samples.iter().map(|s|s.current_lap)
        .chain(append.map(|p|p.current_lap)).fold(f64::NEG_INFINITY,f64::max);
    if peak>0.0&&(peak-time).abs()>2.0{return Some("telemetry lap time mismatch");}
    if first.is_acc&&first.lap_number==0.0&&time<30.0{return Some("starting lap");}
    if !first.is_acc {
        let dx=last.position_x-first.position_x; let dz=last.position_z-first.position_z;
        if (dx*dx+dz*dz).sqrt()>20.0{return Some("start/end positions too far apart");}
    }
    None
}
fn track_limit(samples:&[Sample],append:Option<&Sample>)->bool{
    if samples.is_empty() || samples[0].acc_valid==Some(false){return false;}
    let mut run=0;
    for valid in samples.iter().map(|s|s.acc_valid)
        .chain(append.map(|p|p.acc_valid)) {
        if valid==Some(false){run+=1;if run>=2{return true;}}else{run=0;}
    }
    false
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    fn packet(game: &str, lap: i64, current: f64, last: f64, distance: f64, valid: Option<bool>) -> Value {
        json!({
            "gameId": game, "LapNumber": lap, "CurrentLap": current,
            "LastLap": last, "DistanceTraveled": distance,
            "CarOrdinal": 1, "TrackOrdinal": 2,
            "PositionX": 0, "PositionZ": 0,
            "acc": {"isValidLap": valid, "pitStatus": "out"},
            "fullTelemetry": {"wheelData": [1, 2, 3, 4]}
        })
    }

    #[test]
    fn typed_materializer_runs_only_for_emitted_boundary_and_adapters_share_transitions() {
        for game in ["acc", "ac-evo"] {
            let mut full = KunosDetector::new(game).unwrap();
            let mut typed = KunosDetector::new(game).unwrap();
            let calls = std::cell::Cell::new(0);
            let mut offset = 0;
            let mut feed = |packet: Value| {
                offset += 10;
                let events = typed.feed_typed(KunosSnapshot::from_value(&packet, game), offset, offset, || {
                    calls.set(calls.get() + 1);
                    packet.clone()
                }).unwrap();
                assert_eq!(events, full.feed_ref_at(&packet, offset, offset).unwrap());
                events
            };
            let mut initial = packet(game, 1, 0.0, 0.0, 0.0, Some(true));
            initial["CarPerformanceIndex"] = json!({"rating": [1, 2]});
            initial["sessionUID"] = json!(["arbitrary", "metadata"]);
            initial[if game == "acc" { "acc" } else { "acEvo" }]["sessionType"] = json!(["race", 3]);
            let started = feed(initial.clone());
            assert_eq!(started[0]["data"]["carPI"], initial["CarPerformanceIndex"]);
            assert_eq!(started[0]["data"]["sessionUID"], initial["sessionUID"]);
            assert_eq!(started[0]["data"]["sessionType"], json!(["race", 3]));
            for i in 10..20 {
                feed(packet(game, 1, i as f64, 0.0, i as f64 * 10.0, Some(true)));
            }
            // Timer reset below 30 seconds without authoritative advancement.
            assert!(feed(packet(game, 1, 0.0, 0.0, 200.0, Some(true))).is_empty());
            assert_eq!(calls.get(), 0);
            for i in 1..31 {
                feed(packet(game, 1, i as f64, 0.0, 200.0 + i as f64 * 20.0, Some(true)));
            }
            let boundary = packet(game, 2, 0.0, 31.0, 820.0, Some(false));
            let events = feed(boundary.clone());
            assert_eq!(calls.get(), 1);
            assert_eq!(events[0]["data"]["analysisRecipe"]["appendPackets"], json!([boundary]));
            // Distance reset discards current collection, not session identity.
            assert!(feed(packet(game, 2, 1.0, 31.0, 0.0, Some(true))).is_empty());
            for i in 2..10 {
                feed(packet(game, 2, i as f64, 31.0, i as f64 * 20.0, Some(true)));
            }
            // Real advancement with too few samples must not build append JSON.
            assert!(feed(packet(game, 3, 0.0, 32.0, 200.0, Some(true))).is_empty());
            assert_eq!(calls.get(), 1);
            drop(feed);
            assert_eq!(typed.tick(offset + 10_000), full.tick(offset + 10_000));
            assert_eq!(calls.get(), 1);
            assert_eq!(typed.finish("import-eof"), full.finish("import-eof"));
        }
    }

    #[test]
    fn typed_partial_pit_and_short_distance_resets_do_not_materialize() {
        for game in ["acc", "ac-evo"] {
            for pit in [false, true] {
                let mut detector = KunosDetector::new(game).unwrap();
                for i in 0..30 {
                    let mut packet = packet(game, 1, 10.0 + i as f64, 0.0,
                        i as f64 * if pit { 20.0 } else { 2.0 }, Some(true));
                    if pit { packet["acc"]["pitStatus"] = json!("in_pit"); }
                    detector.feed_typed(KunosSnapshot::from_value(&packet, game), i * 10, 0,
                        || panic!("partial collection cannot append presentation")).unwrap();
                }
                let boundary = packet(game, 2, 0.0, 40.0, if pit { 600.0 } else { 60.0 }, Some(true));
                let events = detector.feed_typed(KunosSnapshot::from_value(&boundary, game), 300, 0,
                    || panic!("discarded partial lap cannot append presentation")).unwrap();
                assert!(events.is_empty());
                assert_eq!(detector.lap.len(), 1);
                assert_eq!(detector.lap[0].offset, 300);
                assert!(!detector.first_partial);
            }
        }
    }

    #[test]
    fn boundary_append_preserves_full_packet_and_next_lap_source_offset() {
        let mut detector = KunosDetector::new("acc").unwrap();
        for i in 0..30 {
            detector.feed(packet("acc", 1, i as f64, 0.0, i as f64 * 20.0, Some(true)), i * 10).unwrap();
        }
        let trigger = packet("acc", 2, 0.0, 30.0, 600.0, Some(false));
        let events = detector.feed(trigger.clone(), 300).unwrap();
        let lap = &events.iter().find(|e| e["kind"] == "LAP_RECORDED").unwrap()["data"];
        assert_eq!(lap["isValid"], true);
        assert_eq!(lap["rawFrameCount"], 30);
        assert_eq!(lap["analysisRecipe"]["appendPackets"], json!([trigger]));
        assert_eq!(lap["analysisRecipe"]["ranges"][29], json!({"offset": "290", "count": 1}));
        for i in 1..30 {
            detector.feed(packet("acc", 2, i as f64, 30.0, 600.0 + i as f64 * 20.0, Some(true)), 300 + i * 10).unwrap();
        }
        let events = detector.feed(packet("acc", 3, 0.0, 31.0, 1200.0, Some(true)), 600).unwrap();
        let lap = &events.iter().find(|e| e["kind"] == "LAP_RECORDED").unwrap()["data"];
        assert_eq!(lap["lapNumber"], 2);
        assert_eq!(lap["rawByteOffset"], "300");
        assert_eq!(lap["rawFrameCount"], 31);
        let expected_ranges = std::iter::once(300).chain((300..600).step_by(10))
            .map(|offset| json!({"offset": offset.to_string(), "count": 1})).collect::<Vec<_>>();
        assert_eq!(lap["analysisRecipe"]["ranges"], json!(expected_ranges));
    }

    #[test]
    fn appended_boundary_counts_for_quality_and_consecutive_track_limits() {
        let mut detector = KunosDetector::new("ac-evo").unwrap();
        for i in 0..29 {
            detector.feed(packet("ac-evo", 1, i as f64, 0.0, i as f64 * 20.0,
                Some(i != 28)), i * 10).unwrap();
        }
        let events = detector.feed(packet("ac-evo", 2, 0.0, 29.0, 600.0, Some(false)), 290).unwrap();
        let lap = &events.iter().find(|e| e["kind"] == "LAP_RECORDED").unwrap()["data"];
        assert_eq!(lap["invalidReason"], "track limits");
        assert_eq!(lap["rawFrameCount"], 29);
        assert_eq!(lap["analysisRecipe"]["ranges"][28], json!({"offset": "280", "count": 1}));
    }
}
