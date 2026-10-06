use serde_json::{json, Value};
use super::policy::{lmu_invalid_reason,lmu_lap_time,lmu_pit_reason,number,pit_reason,quality,track_limit,Sample};
use super::iracing::{IRacingInput, IRacingUid};

/// F1 parser projection. Identity remains scalar until a session event is emitted.
#[derive(Clone, Copy, Debug)]
pub struct F1Snapshot {
    pub sample: Sample,
    pub timestamp: f64,
    pub session_uid: u64,
    pub car_ordinal: f64,
    pub track_ordinal: f64,
    pub session_type: &'static str,
}

enum Identity<'a> { Packet(&'a Value), F1(&'a F1Snapshot), IRacing(&'a IRacingInput) }
enum SessionUid { Text(String), F1(u64), IRacing(IRacingUid) }
struct Session { uid: SessionUid, car: f64, track: f64, lmu_car: Value, lmu_track: Value }
struct Input<'a> { sample: Sample, timestamp: f64, race_on: bool, identity: Identity<'a> }
impl Identity<'_> {
    fn car(&self)->f64 { match self { Self::Packet(p)=>number(p,"CarOrdinal"),Self::F1(p)=>p.car_ordinal,Self::IRacing(p)=>p.car_ordinal } }
    fn track(&self)->f64 { match self { Self::Packet(p)=>number(p,"TrackOrdinal"),Self::F1(p)=>p.track_ordinal,Self::IRacing(p)=>p.track_ordinal } }
    fn uid_empty(&self)->bool { match self { Self::Packet(p)=>p.get("sessionUID").and_then(Value::as_str).unwrap_or("").is_empty(),Self::F1(_)=>false,Self::IRacing(p)=>p.uid.is_empty() } }
    fn same_uid(&self,uid:&SessionUid)->bool {
        match (self,uid) {
            (Self::F1(p),SessionUid::F1(v))=>p.session_uid==*v,
            (Self::Packet(p),SessionUid::Text(v))=>p.get("sessionUID").and_then(Value::as_str).unwrap_or("")==v.as_str(),
            (Self::F1(p),SessionUid::Text(v))=>canonical_uid(v,p.session_uid),
            (Self::Packet(p),SessionUid::F1(v))=>canonical_uid(p.get("sessionUID").and_then(Value::as_str).unwrap_or(""),*v),
            (Self::IRacing(p),SessionUid::IRacing(v))=>p.uid.same(v),
            (Self::IRacing(p),SessionUid::Text(v))=>p.uid.matches_text(v),
            (Self::Packet(p),SessionUid::IRacing(v))=>v.matches_text(p.get("sessionUID").and_then(Value::as_str).unwrap_or("")),
            (Self::F1(p),SessionUid::IRacing(IRacingUid::Text(v)))=>canonical_uid(v,p.session_uid),
            (Self::IRacing(p),SessionUid::F1(v))=>match &p.uid { IRacingUid::Text(text)=>canonical_uid(text,*v),IRacingUid::Numeric(_)=>false },
            (Self::F1(_),SessionUid::IRacing(IRacingUid::Numeric(_)))=>false,
        }
    }
    fn lmu(&self)->Option<&Value> { match self { Self::Packet(p)=>p.get("lmu").filter(|v|!v.is_null()),Self::F1(_)|Self::IRacing(_)=>None } }
    fn lmu_field(&self,k:&str)->&Value { self.lmu().and_then(|v|v.get(k)).unwrap_or(&Value::Null) }
    fn session(&self)->Session {
        let uid=match self { Self::Packet(p)=>SessionUid::Text(p.get("sessionUID").and_then(Value::as_str).unwrap_or("").into()),Self::F1(p)=>SessionUid::F1(p.session_uid),Self::IRacing(p)=>SessionUid::IRacing(p.uid.clone()) };
        Session {uid,car:self.car(),track:self.track(),lmu_car:self.lmu_field("carId").clone(),lmu_track:self.lmu_field("trackId").clone()}
    }
    fn event(&self,game:&str)->Value {
        match self {
            Self::Packet(p)=>{
                let session_type=p.get("f1").and_then(|v|v.get("sessionType")).or_else(||p.get("lmu").and_then(|v|v.get("sessionType"))).unwrap_or(&Value::Null);
                json!({"kind":"SESSION_STARTED","data":{"gameId":game,"carOrdinal":self.car(),"trackOrdinal":self.track(),"carPerformanceIndex":number(p,"CarPerformanceIndex"),"carClass":p.get("CarClass").unwrap_or(&Value::Null),"carId":self.lmu_field("carId"),"trackId":self.lmu_field("trackId"),"sessionUID":p.get("sessionUID").unwrap_or(&Value::Null),"sessionType":session_type,"detectorVersion":"rust-recorder_v1"}})
            }
            Self::F1(p)=>json!({"kind":"SESSION_STARTED","data":{"gameId":game,"carOrdinal":p.car_ordinal,"trackOrdinal":p.track_ordinal,"carPerformanceIndex":0.0,"carClass":0.0,"carId":null,"trackId":null,"sessionUID":p.session_uid.to_string(),"sessionType":p.session_type,"detectorVersion":"rust-recorder_v1"}}),
            Self::IRacing(p)=>p.event(game),
        }
    }
}
impl SessionUid { fn is_empty(&self)->bool { match self { Self::Text(v)=>v.is_empty(),Self::F1(_)=>false,Self::IRacing(v)=>v.is_empty() } } }
fn canonical_uid(text:&str,uid:u64)->bool {
    (text=="0"||!text.starts_with('0'))&&text.bytes().all(|b|b.is_ascii_digit())&&text.parse::<u64>().ok()==Some(uid)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GameKind { Forza, Lmu, Other }

pub struct OrdinalDetector {
    game:String, kind:GameKind, session:Option<Session>, lap:Vec<Sample>, lap_number:i64,
    last_host_ms:u64, last_timestamp:f64, last_last_lap:f64, best:f64, completed:u32,
    invalid:Option<String>, provisional:bool, race_off:bool, race_off_since:Option<u64>,
    current_pit:Option<&'static str>, next_pit:Option<&'static str>, pending_overrides:Vec<Value>,
}
impl OrdinalDetector {
    pub fn new(game_id:&str)->Result<Self,String> {
        if !["fm-2023","f1-2025","lmu","iracing"].contains(&game_id) {return Err(format!("unsupported ordinal detector game: {game_id}"));}
        let kind=match game_id {"fm-2023"=>GameKind::Forza,"lmu"=>GameKind::Lmu,_=>GameKind::Other};
        Ok(Self {game:game_id.into(),kind,session:None,lap:vec![],lap_number:-1,last_host_ms:0,last_timestamp:0.,last_last_lap:0.,best:0.,completed:0,invalid:None,provisional:false,race_off:false,race_off_since:None,current_pit:None,next_pit:None,pending_overrides:vec![]})
    }
    pub fn reset(&mut self) {if let Ok(next)=Self::new(&self.game){*self=next;}}
    pub fn feed(&mut self,p:Value,offset:u64)->Vec<Value> {self.feed_ref(&p,offset)}
    pub fn feed_ref(&mut self,p:&Value,offset:u64)->Vec<Value> {
        let host=p.get("_hostFrameTimeMs").and_then(Value::as_u64).unwrap_or(0);
        self.feed_ref_at(p,offset,host)
    }
    pub fn feed_at(&mut self,p:Value,offset:u64,host:u64)->Vec<Value> {self.feed_ref_at(&p,offset,host)}
    pub fn feed_ref_at(&mut self,p:&Value,offset:u64,host:u64)->Vec<Value> {
        let input=Input {sample:Sample::from_value(p,offset),timestamp:number(p,"TimestampMS"),race_on:p.get("IsRaceOn").and_then(Value::as_bool).unwrap_or(false),identity:Identity::Packet(p)};
        let mut out=Vec::new();self.feed_inner(input,host,&mut out);out
    }
    pub fn feed_f1(&mut self,p:F1Snapshot,offset:u64)->Vec<Value> {
        let mut sample=p.sample;sample.offset=offset;
        let input=Input {sample,timestamp:p.timestamp,race_on:false,identity:Identity::F1(&p)};
        let mut out=Vec::new();self.feed_inner(input,0,&mut out);out
    }
    pub fn feed_iracing_at(&mut self,p:&IRacingInput,offset:u64,host:u64)->Vec<Value> {
        let mut sample=p.sample;sample.offset=offset;
        let input=Input {sample,timestamp:p.timestamp,race_on:p.race_on,identity:Identity::IRacing(p)};
        let mut out=Vec::new();self.feed_inner(input,host,&mut out);out
    }
    pub fn set_next_override(&mut self,offset:u64,field:&str,value:Value){self.pending_overrides.push(json!({"offset":offset.to_string(),"fields":{(field):value}}));}
    pub fn finish(&mut self,reason:&str)->Vec<Value>{let mut out=Vec::new();self.finish_session(reason,&mut out);out}
    pub fn snapshot_incomplete_lap(&mut self)->Vec<Value>{let mut out=Vec::new();if self.kind==GameKind::Forza{self.race_off=true;self.race_off_since.get_or_insert(self.last_host_ms);self.emit_provisional(&mut out);}out}
    pub fn tick(&mut self,host_time_ms:u64)->Vec<Value>{let mut out=Vec::new();if self.kind==GameKind::Forza{if self.race_off&&!self.provisional&&self.race_off_since.is_some_and(|t|host_time_ms.saturating_sub(t)>=10_000){self.emit_provisional(&mut out);}}else if self.last_host_ms>0&&host_time_ms.saturating_sub(self.last_host_ms)>=10_000&&self.lap.len()>=30{self.flush_stale(&mut out);}out}
    pub fn set_current_lap_offset(&mut self,offset:u64){if let Some(sample)=self.lap.first_mut(){sample.offset=offset;}}
    fn feed_inner(&mut self,p:Input<'_>,host:u64,out:&mut Vec<Value>) {
        let sample=p.sample;let lap=sample.lap_number as i64;let dist=sample.distance;
        let last_dist=self.lap.last().map(|s|s.distance);
        let boundary=self.session.as_ref().and_then(|s| {
            if !p.identity.uid_empty()&&!s.uid.is_empty()&&!p.identity.same_uid(&s.uid){Some("session-uid-changed")}
            else if self.lap_number>1&&lap==1{Some("lap-number-reset")}
            else if s.uid.is_empty()&&last_dist.is_some_and(|d|d>1000.&&dist<500.){Some("distance-reset")}
            else if self.kind==GameKind::Lmu&&p.identity.lmu().is_some()&&p.identity.lmu_field("carId")!=&s.lmu_car{Some("car-changed")}
            else if self.kind==GameKind::Lmu&&p.identity.lmu().is_some()&&p.identity.lmu_field("trackId")!=&s.lmu_track{Some("track-changed")}
            else if self.kind!=GameKind::Lmu&&p.identity.car()!=s.car{Some("car-changed")}
            else if self.kind!=GameKind::Lmu&&p.identity.track()!=0.&&p.identity.track()!=s.track{Some("track-changed")}
            else if self.kind!=GameKind::Forza&&s.uid.is_empty()&&self.last_host_ms>0&&host.saturating_sub(self.last_host_ms)>300_000{Some("silence-timeout")}
            else{None}
        });
        if let Some(reason)=boundary {self.finish_session(reason,out);}
        if self.session.is_none(){self.start_session(&p.identity,out);}
        let previous=self.lap.last().map(|s|(s.current_lap,s.distance));
        let pit_transition=boundary.is_none()&&self.kind==GameKind::Forza&&self.lap.last().is_some_and(|s|forza_pit(s,&sample,self.race_off));
        if self.provisional&&p.race_on{out.push(json!({"kind":"LAP_RETRACTED","data":{"lapKey":self.lap_number.to_string()}}));self.provisional=false;self.race_off=false;self.race_off_since=None;}
        if pit_transition{self.current_pit=merge_pit(self.current_pit,Some("inlap"));self.next_pit=merge_pit(self.next_pit,Some("outlap"));}
        if self.lap_number>=0&&lap==self.lap_number&&self.lap.len()>30&&previous.is_some_and(|(current,distance)|(current>5.&&sample.current_lap==0.)||distance-dist>500.){
            if sample.last_lap>0.&&self.last_last_lap>0.&&sample.last_lap!=self.last_last_lap{self.complete_lap(&sample,None,out);}else{self.lap.clear();self.invalid=None;}
        }
        if self.last_timestamp>0.&&p.timestamp<self.last_timestamp&&lap==self.lap_number{self.invalidate("rewind");}
        if self.lap_number>=0&&lap!=self.lap_number{
            if lap<self.lap_number{self.lap.clear();self.lap_number=lap;self.invalid=None;}
            else if lap>self.lap_number+1{self.invalidate(&format!("lap skip ({} → {})",self.lap_number,lap));self.complete_lap(&sample,None,out);}
            else{self.complete_lap(&sample,None,out);}
        }
        self.last_last_lap=sample.last_lap;if self.lap_number<0{self.lap_number=lap;}
        self.pending_overrides.clear();self.last_timestamp=p.timestamp;
        if self.kind==GameKind::Forza&&!p.race_on{if !self.race_off{self.race_off_since=Some(host);}self.race_off=true;}else{self.race_off=false;self.race_off_since=None;}
        self.last_host_ms=host;self.lap.push(sample);
    }
    fn complete_lap(&mut self,boundary:&Sample,force:Option<&str>,out:&mut Vec<Value>){
        if self.lap.is_empty(){self.lap_number=boundary.lap_number as i64;return;}
        let t=if self.kind==GameKind::Lmu{lmu_lap_time(&self.lap,boundary)}else if boundary.last_lap>0.{boundary.last_lap}else{0.};
        self.trim_running_start();
        if t>=10.{
            let policy=if self.kind==GameKind::Lmu{lmu_invalid_reason(&self.lap)}else{None};
            let pit=if self.kind==GameKind::Lmu{lmu_pit_reason(&self.lap,self.completed)}else{merge_pit(self.current_pit,pit_reason(&self.lap))};
            let q=quality(&self.lap,t);let track_limited=self.kind==GameKind::Lmu&&track_limit(&self.lap);
            let invalid=self.invalid.take();let reason=force.or(invalid.as_deref()).or(policy).or(pit).or(q).or(track_limited.then_some("track limits"));
            self.emit_lap(t,reason,false,out);self.completed+=1;
        }
        self.lap.clear();self.lap_number=boundary.lap_number as i64;self.invalid=None;self.current_pit=self.next_pit.take();
    }
    fn flush_stale(&mut self,out:&mut Vec<Value>){self.trim_running_start();if self.lap.len()<30{return;}let last=*self.lap.last().unwrap();let fresh=last.last_lap>0.&&last.last_lap!=self.last_last_lap;let t=if fresh{last.last_lap}else{last.current_lap};if t>=10.{let invalid=self.invalid.take();self.emit_lap(t,if fresh{invalid.as_deref()}else{Some("incomplete")},false,out);self.invalid=invalid;}self.lap.clear();self.lap_number=-1;self.last_host_ms=0;}
    fn emit_provisional(&mut self,out:&mut Vec<Value>){if self.lap.is_empty(){return;}let t=self.lap.last().unwrap().current_lap;if t>=10.{self.emit_lap(t,self.current_pit.or(Some("incomplete")),true,out);self.provisional=true;}}
    fn emit_lap(&mut self,time:f64,forced:Option<&str>,provisional:bool,out:&mut Vec<Value>){if self.lap.is_empty(){return;}let reason=forced.map(str::to_owned);let valid=!provisional&&reason.is_none()&&time>=10.;if valid{self.best=if self.best==0.{time}else{self.best.min(time)};}let ranges=self.lap.iter().map(|s|json!({"offset":s.offset.to_string(),"count":1})).collect::<Vec<_>>();let offset=self.lap.first().map(|s|s.offset.to_string());out.push(json!({"kind":"LAP_RECORDED","data":{"lapKey":self.lap_number.to_string(),"lapNumber":self.lap_number,"lapTime":time,"isValid":valid,"invalidReason":reason,"provisional":provisional,"rawByteOffset":offset,"rawFrameCount":self.lap.len(),"sessionBestLapTime":self.best,"analysisRecipe":{"ranges":ranges,"contextOffset":null,"appendPackets":[],"overrides":self.pending_overrides}}}));}
    fn start_session(&mut self,p:&Identity<'_>,out:&mut Vec<Value>){self.session=Some(p.session());self.lap.clear();self.lap_number=-1;self.invalid=None;self.best=0.;self.completed=0;self.provisional=false;self.race_off=false;self.race_off_since=None;self.current_pit=None;self.next_pit=None;out.push(p.event(&self.game));}
    fn finish_session(&mut self,reason:&str,out:&mut Vec<Value>){if self.session.is_none(){return;}if !(self.kind==GameKind::Forza&&self.provisional)&&!self.lap.is_empty(){let t=self.lap.last().unwrap().current_lap;if t>=10.{self.emit_lap(t,self.current_pit.or(Some("incomplete")),false,out);}}out.push(json!({"kind":"RECORDING_COMPLETED","data":{"reason":reason}}));self.session=None;self.lap.clear();self.lap_number=-1;self.last_host_ms=0;self.provisional=false;self.race_off=false;self.race_off_since=None;self.current_pit=None;self.next_pit=None;}
    fn trim_running_start(&mut self){if self.lap.len()<=1{return;}let mut reset=0;for i in 1..self.lap.len(){if self.lap[i-1].current_lap>5.&&self.lap[i].current_lap<1.{reset=i;}}if reset>0&&(reset as f64)<self.lap.len() as f64/2.{self.lap.drain(0..reset);}}
    fn invalidate(&mut self,r:&str){self.invalid=Some(r.into());}
}
fn merge_pit(a:Option<&'static str>,b:Option<&'static str>)->Option<&'static str>{match(a,b){(None,x)=>x,(x,None)=>x,(Some(x),Some(y))if x==y=>Some(x),_=>Some("pit lap")}}
fn forza_pit(a:&Sample,b:&Sample,race_off:bool)->bool{
    if !a.is_forza||!b.is_forza||b.lap_number<=a.lap_number{return false;}
    let timing=a.current_lap.is_finite()&&b.last_lap.is_finite()&&a.current_lap.is_finite()&&b.current_lap>=2.&&b.last_lap-a.current_lap>=2.;
    let fuel=a.fuel.is_finite()&&b.fuel.is_finite()&&a.fuel>=0.&&b.fuel-a.fuel>=0.005;
    let available=a.tire_wear.iter().zip(&b.tire_wear).all(|(a,b)|a.is_finite()&&b.is_finite()&&*a>=0.&&*b>=0.);
    let before=a.tire_wear.iter().sum::<f64>()/4.;let after=b.tire_wear.iter().sum::<f64>()/4.;
    let wear=available&&before-after>=0.005;race_off||timing||fuel||wear
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lmu_records_first_completed_lap() {
        let packet=|time:f64,lap:i64,current:f64,last:f64|json!({"gameId":"lmu","sessionUID":"first-lap","CarOrdinal":0,"TrackOrdinal":0,"IsRaceOn":true,"LapNumber":lap,"CurrentLap":current,"LastLap":last,"TimestampMS":time*1000.,"Speed":40.,"DistanceTraveled":time*40.});
        let mut detector=OrdinalDetector::new("lmu").unwrap();
        for index in 0..750{let time=index as f64/50.;detector.feed(packet(time,1,time,0.),index);}
        let events=detector.feed(packet(15.,2,0.,15.),750);
        let lap=events.iter().find(|event|event["kind"]=="LAP_RECORDED").expect("first completed lap must be recorded");
        assert_eq!(lap["data"]["lapNumber"],1);assert_eq!(lap["data"]["lapTime"],15.);assert_eq!(lap["data"]["provisional"],false);
    }
    #[test]
    fn forza_pit_thresholds() {
        let a=Sample {is_forza:true,lap_number:1.,current_lap:10.,fuel:0.5,tire_wear:[0.1;4],..Sample::default()};
        let mut b=Sample {lap_number:2.,..a};
        assert!(!forza_pit(&a,&b,false));assert!(forza_pit(&a,&b,true));
        b.current_lap=2.;b.last_lap=12.;assert!(forza_pit(&a,&b,false));
        b.current_lap=1.999;assert!(!forza_pit(&a,&b,false));
        b.fuel=0.506;assert!(forza_pit(&a,&b,false));
        b.fuel=0.504;b.tire_wear=[0.094;4];assert!(forza_pit(&a,&b,false));
        b.tire_wear=[-1.;4];assert!(!forza_pit(&a,&b,false));
    }
    #[test]
    fn lmu_identity_types_and_source_offsets_remain_exact() {
        let mut detector=OrdinalDetector::new("lmu").unwrap();
        let mut packet=json!({"gameId":"lmu","LapNumber":1,"CurrentLap":15.,"lmu":{"carId":7,"trackId":"spa","sessionType":"race"}});
        let start=detector.feed_ref(&packet,101);
        assert_eq!(start[0]["data"]["carId"],7);
        assert_eq!(start[0]["data"]["trackId"],"spa");
        assert_eq!(start[0]["data"]["sessionType"],"race");
        packet["lmu"]["carId"]=json!("7");
        let events=detector.feed_ref(&packet,202);
        assert_eq!(events[0]["kind"],"LAP_RECORDED");
        assert_eq!(events[0]["data"]["rawByteOffset"],"101");
        assert_eq!(events[0]["data"]["analysisRecipe"]["ranges"],json!([{"offset":"101","count":1}]));
        assert_eq!(events[1]["data"]["reason"],"car-changed");
        assert_eq!(events[2]["data"]["carId"],"7");
        assert_eq!(detector.lap[0].offset,202);
    }

    #[test]
    fn mixed_typed_full_uid_comparison_keeps_decimal_identity() {
        assert!(canonical_uid("0",0));
        assert!(canonical_uid("18446744073709551615",u64::MAX));
        assert!(!canonical_uid("01",1));
        assert!(!canonical_uid("+1",1));
        assert!(!canonical_uid("",0));
        assert!(!canonical_uid("18446744073709551616",u64::MAX));
    }
}
