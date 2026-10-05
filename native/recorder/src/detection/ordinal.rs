use serde_json::{json, Value};
use super::policy::{lmu_invalid_reason,lmu_lap_time,lmu_pit_reason,number,pit_reason,quality,track_limit};
#[derive(Clone)] struct Sample{packet:Value,offset:u64}
pub struct OrdinalDetector{game:String,session:Option<Value>,lap:Vec<Sample>,lap_number:i64,last_host_ms:u64,last_timestamp:f64,last_last_lap:f64,peak_current:f64,best:f64,completed:u32,valid:bool,invalid:Option<String>,provisional:bool,race_off:bool,race_off_since:Option<u64>,current_pit:Option<&'static str>,next_pit:Option<&'static str>,pending_overrides:Vec<Value>}
impl OrdinalDetector{
 pub fn new(game_id:&str)->Result<Self,String>{if !["fm-2023","f1-2025","lmu","iracing"].contains(&game_id){return Err(format!("unsupported ordinal detector game: {game_id}"));}Ok(Self{game:game_id.into(),session:None,lap:vec![],lap_number:-1,last_host_ms:0,last_timestamp:0.,last_last_lap:0.,peak_current:0.,best:0.,completed:0,valid:true,invalid:None,provisional:false,race_off:false,race_off_since:None,current_pit:None,next_pit:None,pending_overrides:vec![]})}
 pub fn reset(&mut self){if let Ok(next)=Self::new(&self.game){*self=next;}}
 pub fn feed(&mut self,p:Value,offset:u64)->Vec<Value>{let host=p.get("_hostFrameTimeMs").and_then(Value::as_u64).unwrap_or(0);self.feed_at(p,offset,host)}
 pub fn feed_at(&mut self,p:Value,offset:u64,host:u64)->Vec<Value>{let mut out=Vec::new();self.feed_inner(p,offset,host,&mut out);out}
 pub fn set_next_override(&mut self,offset:u64,field:&str,value:Value){self.pending_overrides.push(json!({"offset":offset.to_string(),"fields":{(field):value}}));}
 pub fn finish(&mut self,reason:&str)->Vec<Value>{let mut out=Vec::new();self.finish_session(reason,&mut out);out}
 pub fn snapshot_incomplete_lap(&mut self)->Vec<Value>{let mut out=Vec::new();if self.game=="fm-2023"{self.race_off=true;self.race_off_since.get_or_insert(self.last_host_ms);self.emit_provisional(&mut out);}out}
 pub fn tick(&mut self,host_time_ms:u64)->Vec<Value>{let mut out=Vec::new();if self.game=="fm-2023"{if self.race_off&&!self.provisional&&self.race_off_since.is_some_and(|t|host_time_ms.saturating_sub(t)>=10_000){self.emit_provisional(&mut out);}}else if self.last_host_ms>0&&host_time_ms.saturating_sub(self.last_host_ms)>=10_000&&self.lap.len()>=30{self.flush_stale(&mut out);}out}
 pub fn set_current_lap_offset(&mut self,offset:u64){if let Some(sample)=self.lap.first_mut(){sample.offset=offset;}}
 fn feed_inner(&mut self,p:Value,off:u64,host:u64,out:&mut Vec<Value>){
  let lap=number(&p,"LapNumber") as i64;let dist=number(&p,"DistanceTraveled");let uid=strv(&p,"sessionUID");let last_dist=self.lap.last().map(|s|number(&s.packet,"DistanceTraveled"));
  let boundary=self.session.as_ref().and_then(|s|{let suid=strv(s,"sessionUID");if !uid.is_empty()&&!suid.is_empty()&&uid!=suid{Some("session-uid-changed")}else if self.lap_number>1&&lap==1{Some("lap-number-reset")}else if suid.is_empty()&&last_dist.is_some_and(|d|d>1000.&&dist<500.){Some("distance-reset")}else if self.game=="lmu"&&p.get("lmu").is_some_and(|v|!v.is_null())&&field(&p,"lmu","carId")!=field(s,"lmu","carId"){Some("car-changed")}else if self.game=="lmu"&&p.get("lmu").is_some_and(|v|!v.is_null())&&field(&p,"lmu","trackId")!=field(s,"lmu","trackId"){Some("track-changed")}else if self.game!="lmu"&&number(&p,"CarOrdinal")!=number(s,"CarOrdinal"){Some("car-changed")}else if self.game!="lmu"&&number(&p,"TrackOrdinal")!=0.&&number(&p,"TrackOrdinal")!=number(s,"TrackOrdinal"){Some("track-changed")}else if self.game!="fm-2023"&&suid.is_empty()&&self.last_host_ms>0&&host.saturating_sub(self.last_host_ms)>300_000{Some("silence-timeout")}else{None}});
  if let Some(reason)=boundary {self.finish_session(reason,out);}
  if self.session.is_none(){self.start_session(&p,out);}
  let previous=self.lap.last().map(|s|(number(&s.packet,"CurrentLap"),number(&s.packet,"DistanceTraveled")));
  let race_off_observed=self.race_off;
  let pit_transition=!boundary.is_some()&&self.game=="fm-2023"&&self.lap.last().is_some_and(|s|forza_pit(&s.packet,&p,race_off_observed));
  if self.provisional&&truth(&p,"IsRaceOn"){out.push(json!({"kind":"LAP_RETRACTED","data":{"lapKey":self.lap_number.to_string()}}));self.provisional=false;self.race_off=false;self.race_off_since=None;}
  if pit_transition{self.current_pit=merge_pit(self.current_pit,Some("inlap"));self.next_pit=merge_pit(self.next_pit,Some("outlap"));}
  if self.lap_number>=0&&lap==self.lap_number&&self.lap.len()>30&&previous.is_some_and(|(current,distance)|(current>5.&&number(&p,"CurrentLap")==0.)||distance-dist>500.){if number(&p,"LastLap")>0.&&self.last_last_lap>0.&&number(&p,"LastLap")!=self.last_last_lap{self.complete_lap(&p,off,None,out);}else{self.lap.clear();self.valid=true;self.invalid=None;self.peak_current=0.;}}
  let timestamp=number(&p,"TimestampMS");if self.last_timestamp>0.&&timestamp<self.last_timestamp&&lap==self.lap_number{self.invalidate("rewind");}
  if self.lap_number>=0&&lap!=self.lap_number{if lap<self.lap_number{self.lap.clear();self.lap_number=lap;self.valid=true;self.invalid=None;self.peak_current=0.;}else if lap>self.lap_number+1{self.invalidate(&format!("lap skip ({} → {})",self.lap_number,lap));self.complete_lap(&p,off,None,out);}else{self.complete_lap(&p,off,None,out);}}
  self.last_last_lap=number(&p,"LastLap");if self.lap_number<0{self.lap_number=lap;}self.pending_overrides.clear();self.peak_current=self.peak_current.max(number(&p,"CurrentLap"));self.last_timestamp=timestamp;
  if self.game=="fm-2023"&&!truth(&p,"IsRaceOn"){if !self.race_off{self.race_off_since=Some(host);}self.race_off=true;}else{self.race_off=false;self.race_off_since=None;}self.last_host_ms=host;self.lap.push(Sample{packet:p,offset:off});
 }
 fn complete_lap(&mut self,boundary:&Value,_off:u64,force:Option<&str>,out:&mut Vec<Value>){
  if self.lap.is_empty(){self.lap_number=number(boundary,"LapNumber") as i64;return;}
  let raw_samples=Self::samples(&self.lap);
  let t=if self.game=="lmu"{lmu_lap_time(&raw_samples,boundary)}else if number(boundary,"LastLap")>0.{number(boundary,"LastLap")}else{0.};
  self.trim_running_start();
  let samples=Self::samples(&self.lap);
  if t>=10.{
   let policy=if self.game=="lmu"{lmu_invalid_reason(&samples)}else{None};
   let pit=if self.game=="lmu"{lmu_pit_reason(&samples,self.completed)}else{merge_pit(self.current_pit,pit_reason(&samples))};
   let q=quality(&samples,t);
   let track_limited=self.game=="lmu"&&track_limit(&samples);
   drop(samples);
   let invalid=self.invalid.take();
   let reason=force.or(invalid.as_deref()).or(policy).or(pit).or(q).or(track_limited.then_some("track limits"));
   self.emit_lap(t,reason,false,out);
   self.completed+=1;
  }
  self.lap.clear();self.lap_number=number(boundary,"LapNumber") as i64;self.valid=true;self.invalid=None;self.peak_current=0.;self.current_pit=self.next_pit.take();
 }
 fn flush_stale(&mut self,out:&mut Vec<Value>){self.trim_running_start();if self.lap.len()<30{return;}let last=self.lap.last().unwrap().packet.clone();let fresh=number(&last,"LastLap")>0.&&number(&last,"LastLap")!=self.last_last_lap;let t=if fresh{number(&last,"LastLap")}else{number(&last,"CurrentLap")};if t>=10.{let invalid=self.invalid.take();self.emit_lap(t,if fresh{invalid.as_deref()}else{Some("incomplete")},false,out);self.invalid=invalid;}self.lap.clear();self.lap_number=-1;self.last_host_ms=0;}
 fn emit_provisional(&mut self,out:&mut Vec<Value>){if self.lap.is_empty(){return;}let t=number(&self.lap.last().unwrap().packet,"CurrentLap");if t>=10.{self.emit_lap(t,self.current_pit.or(Some("incomplete")),true,out);self.provisional=true;}}
 fn emit_lap(&mut self,time:f64,forced:Option<&str>,provisional:bool,out:&mut Vec<Value>){if self.lap.is_empty(){return;}let reason=forced.map(str::to_owned);let valid=!provisional&&reason.is_none()&&time>=10.;if valid{self.best=if self.best==0.{time}else{self.best.min(time)};}let ranges=self.lap.iter().map(|s|json!({"offset":s.offset.to_string(),"count":1})).collect::<Vec<_>>();let offset=self.lap.first().map(|s|s.offset.to_string());out.push(json!({"kind":"LAP_RECORDED","data":{"lapKey":self.lap_number.to_string(),"lapNumber":self.lap_number,"lapTime":time,"isValid":valid,"invalidReason":reason,"provisional":provisional,"rawByteOffset":offset,"rawFrameCount":self.lap.len(),"sessionBestLapTime":self.best,"analysisRecipe":{"ranges":ranges,"contextOffset":null,"appendPackets":[],"overrides":self.pending_overrides}}}));}
 fn start_session(&mut self,p:&Value,out:&mut Vec<Value>){self.session=Some(p.clone());self.lap.clear();self.lap_number=-1;self.valid=true;self.invalid=None;self.best=0.;self.completed=0;self.provisional=false;self.race_off=false;self.race_off_since=None;self.current_pit=None;self.next_pit=None;let session_type=p.get("f1").and_then(|v|v.get("sessionType")).or_else(||p.get("lmu").and_then(|v|v.get("sessionType"))).cloned().unwrap_or(Value::Null);out.push(json!({"kind":"SESSION_STARTED","data":{"gameId":self.game,"carOrdinal":number(p,"CarOrdinal"),"trackOrdinal":number(p,"TrackOrdinal"),"carPerformanceIndex":number(p,"CarPerformanceIndex"),"carClass":p.get("CarClass").cloned().unwrap_or(Value::Null),"carId":field(p,"lmu","carId"),"trackId":field(p,"lmu","trackId"),"sessionUID":p.get("sessionUID").cloned().unwrap_or(Value::Null),"sessionType":session_type,"detectorVersion":"rust-recorder_v1"}}));}
 fn finish_session(&mut self,reason:&str,out:&mut Vec<Value>){if self.session.is_none(){return;}if !(self.game=="fm-2023"&&self.provisional)&&!self.lap.is_empty(){let t=number(&self.lap.last().unwrap().packet,"CurrentLap");if t>=10.{self.emit_lap(t,self.current_pit.or(Some("incomplete")),false,out);}}out.push(json!({"kind":"RECORDING_COMPLETED","data":{"reason":reason}}));self.session=None;self.lap.clear();self.lap_number=-1;self.last_host_ms=0;self.provisional=false;self.race_off=false;self.race_off_since=None;self.current_pit=None;self.next_pit=None;}
 fn trim_running_start(&mut self){if self.lap.len()<=1{return;}let mut reset=0;for i in 1..self.lap.len(){if number(&self.lap[i-1].packet,"CurrentLap")>5.&&number(&self.lap[i].packet,"CurrentLap")<1.{reset=i;}}if reset>0&&(reset as f64)<self.lap.len() as f64/2.{self.lap.drain(0..reset);}}
 fn samples(lap:&[Sample])->Vec<&Value>{lap.iter().map(|s|&s.packet).collect()}
 fn invalidate(&mut self,r:&str){self.valid=false;self.invalid=Some(r.into());}
}
fn strv(p:&Value,k:&str)->String{p.get(k).and_then(Value::as_str).unwrap_or("").to_owned()}
fn field(p:&Value,o:&str,k:&str)->Value{p.get(o).and_then(|v|v.get(k)).cloned().unwrap_or(Value::Null)}
fn truth(p:&Value,k:&str)->bool{p.get(k).and_then(Value::as_bool).unwrap_or(false)}
fn merge_pit(a:Option<&'static str>,b:Option<&'static str>)->Option<&'static str>{match(a,b){(None,x)=>x,(x,None)=>x,(Some(x),Some(y))if x==y=>Some(x),_=>Some("pit lap")}}
fn forza_pit(a:&Value,b:&Value,race_off:bool)->bool{if strv(a,"gameId")!="fm-2023"||strv(b,"gameId")!="fm-2023"||number(b,"LapNumber")<=number(a,"LapNumber"){return false;}let timing=number(a,"CurrentLap").is_finite()&&number(b,"LastLap").is_finite()&&number(a,"CurrentLap").is_finite()&&number(b,"CurrentLap")>=2.&&number(b,"LastLap")-number(a,"CurrentLap")>=2.;let fuel=number(a,"Fuel").is_finite()&&number(b,"Fuel").is_finite()&&number(a,"Fuel")>=0.&&number(b,"Fuel")-number(a,"Fuel")>=0.005;let keys=["TireWearFL","TireWearFR","TireWearRL","TireWearRR"];let available=keys.iter().all(|k|number(a,k).is_finite()&&number(b,k).is_finite()&&number(a,k)>=0.&&number(b,k)>=0.);let before=keys.iter().map(|k|number(a,k)).sum::<f64>()/4.;let after=keys.iter().map(|k|number(b,k)).sum::<f64>()/4.;let wear=available&&before-after>=0.005;race_off||timing||fuel||wear}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lmu_records_first_completed_lap() {
        let packet = |time: f64, lap: i64, current: f64, last: f64| json!({
            "gameId": "lmu", "sessionUID": "first-lap",
            "CarOrdinal": 0, "TrackOrdinal": 0, "IsRaceOn": true,
            "LapNumber": lap, "CurrentLap": current, "LastLap": last,
            "TimestampMS": time * 1000., "Speed": 40., "DistanceTraveled": time * 40.
        });
        let mut detector = OrdinalDetector::new("lmu").unwrap();
        for index in 0..750 {
            let time = index as f64 / 50.;
            detector.feed(packet(time, 1, time, 0.), index);
        }
        let events = detector.feed(packet(15., 2, 0., 15.), 750);
        let lap = events.iter().find(|event| event["kind"] == "LAP_RECORDED").expect("first completed lap must be recorded");
        assert_eq!(lap["data"]["lapNumber"], 1);
        assert_eq!(lap["data"]["lapTime"], 15.);
        assert_eq!(lap["data"]["provisional"], false);
    }
}
