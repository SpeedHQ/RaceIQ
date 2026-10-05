use serde_json::{json, Map, Number, Value};
use std::collections::HashMap;

const MAGIC: u32 = 0x51495249;
const HEADER: usize = 12;
const MAX_FRAME: usize = 16 * 1024 * 1024;
const SESSION_MAX: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
enum Scalar { Bool(bool), Num(f64), Str(String), Bools(Vec<bool>), Nums(Vec<f64>) }
#[derive(Clone, Debug)] struct Var { name: String, ty: u8 }
#[derive(Clone, Debug)] struct Session {
    sid:f64, sub:f64, num:f64, driver:f64, track:f64, track_name:String, length:f64,
    sectors:Option<Vec<f64>>, car:f64, car_name:String, class:f64, class_name:String,
    idle:f64, redline:f64, cylinders:f64,
}
pub struct Parser { schema:u16, vars:Vec<Var>, values:HashMap<String,Scalar>, session:Option<Session>, yaml:Option<String>, revision:i32, key:Option<String>, raw_lap:Option<i64>, lap_start:f64 }
impl Default for Parser { fn default()->Self{Self::new()} }
impl Parser {
 pub fn new()->Self{Self{schema:0,vars:vec![],values:HashMap::new(),session:None,yaml:None,revision:0,key:None,raw_lap:None,lap_start:0.}}
 pub fn reset(&mut self){*self=Self::new()}
 pub fn feed(&mut self, frame:&[u8], _time_ms:u64)->Result<Option<Value>,String>{
  if frame.len()<HEADER || u32le(frame,0)?!=MAGIC { return Ok(None); }
  let schema=u16le(frame,4)?; let kind=frame[6];
  if (schema!=2&&schema!=3)||(kind!=1&&kind!=2) {return Ok(None)}
  let len=u32le(frame,8)? as usize;
  if len==0 || frame.len()!=HEADER+len || frame.len()>MAX_FRAME || (schema==2&&len>256*1024){return Err("invalid iRacing source frame length".into())}
  let mut r=Reader{b:frame,p:HEADER};
  if kind==1 { self.read_session(&mut r,schema)?; } else {
   if self.schema!=schema || self.session.is_none(){return Err("iRacing delta without session frame".into())}
   let count=r.u16()? as usize;
   if count>self.vars.len(){return Err("invalid iRacing delta count".into())}
   for _ in 0..count {let i=r.u16()? as usize;let var=self.vars.get(i).ok_or("invalid iRacing variable index")?;let val=r.value(var.ty)?; self.values.insert(var.name.clone(),val);}
  }
  if r.p!=frame.len(){return Err("trailing bytes in iRacing source frame".into())}
  let s=self.session.as_ref().unwrap();
  let n=|name:&str, default:f64| self.values.get(name).and_then(Scalar::number).filter(|v|v.is_finite()).unwrap_or(default);
  let b=|name:&str| self.values.get(name).map(Scalar::truth).unwrap_or(false);
  let lap=n("Lap",0.).trunc().max(0.) as i64;let st=n("SessionTime",0.).max(0.);let sdk=n("LapCurrentLapTime",0.).max(0.);
  let key=format!("{}:{}:{}",s.sub,s.sid,s.num);
  if self.key.as_deref()!=Some(&key)||self.raw_lap.is_none(){self.key=Some(key.clone());self.raw_lap=Some(lap);self.lap_start=st-sdk;}else if self.raw_lap!=Some(lap){self.raw_lap=Some(lap);self.lap_start=st;}
  let curr=(st-self.lap_start).max(0.); let dist=n("LapDist",0.).max(0.);let pct=n("LapDistPct",0.).clamp(0.,1.);
  let mut p=Map::new();
  p.insert("gameId".into(),json!("iracing"));
  p.insert("iracing".into(),json!({"sessionTick":n("SessionTick",0.).trunc(),"sessionNum":s.num,"driverCarIdx":s.driver,"trackLengthM":s.length.max(0.),"lapDistanceM":dist,"lapDistancePct":pct,"sdkCurrentLapTime":sdk,"sectorStarts":valid_sectors(s.sectors.as_deref()),"onPitRoad":b("OnPitRoad"),"playerTrackSurface":n("PlayerTrackSurface",0.).trunc(),"incidents":n("PlayerIncidents",0.).trunc(),"trackWetness":n("TrackWetness",0.).clamp(0.,7.).trunc(),"pitTireTemperatureAvailable":(["LF","RF","LR","RR"].iter().all(|c|n(&format!("{c}tempCM"),f64::NAN).is_finite())),"pitTireWearAvailable":(["LF","RF","LR","RR"].iter().all(|c|["wearL","wearM","wearR"].iter().all(|x|n(&format!("{c}{x}"),f64::NAN).is_finite()))),"carName":s.car_name,"carClassName":s.class_name,"trackName":s.track_name}));
  p.insert("sessionUID".into(),json!(key));
  macro_rules! put {($k:expr,$v:expr)=>{{p.insert(($k).into(),number($v));}};}
  put!("IsRaceOn",if b("IsOnTrack"){1.}else{0.});put!("TimestampMS",(st*1000.).round());put!("EngineMaxRpm",s.redline);put!("EngineIdleRpm",s.idle);put!("CurrentEngineRpm",n("RPM",0.));put!("AccelerationX",-n("LatAccel",0.));put!("AccelerationY",n("VertAccel",0.));put!("AccelerationZ",n("LongAccel",0.));
  for (out,src,sign) in [("VelocityX","VelocityX",1.),("VelocityY","VelocityY",1.),("VelocityZ","VelocityZ",1.),("AngularVelocityX","PitchRate",1.),("AngularVelocityY","YawRate",-1.),("AngularVelocityZ","RollRate",1.),("Yaw","Yaw",-1.),("Pitch","Pitch",1.),("Roll","Roll",1.)]{put!(out,n(src,0.)*sign)}
  for k in ["NormSuspensionTravelFL","NormSuspensionTravelFR","NormSuspensionTravelRL","NormSuspensionTravelRR","TireSlipRatioFL","TireSlipRatioFR","TireSlipRatioRL","TireSlipRatioRR","WheelRotationSpeedFL","WheelRotationSpeedFR","WheelRotationSpeedRL","WheelRotationSpeedRR","WheelOnRumbleStripFL","WheelOnRumbleStripFR","WheelOnRumbleStripRL","WheelOnRumbleStripRR","WheelInPuddleDepthFL","WheelInPuddleDepthFR","WheelInPuddleDepthRL","WheelInPuddleDepthRR","SurfaceRumbleFL_2","SurfaceRumbleFR_2","SurfaceRumbleRL_2","SurfaceRumbleRR_2","TireSlipCombinedFL_2","Boost","Power","Torque","NormDrivingLine","NormAIBrakeDiff","HandBrake","CarPerformanceIndex"]{put!(k,0.)}
  for (out,corner) in [("FL","LF"),("FR","RF"),("RL","LR"),("RR","RR")]{
   let bands=[("Left","L"),("Middle","M"),("Right","R")];for (band,bcode) in bands {let v=n(&format!("{corner}tempC{bcode}"),f64::NAN);p.insert(format!("TireCarcassTemp{band}{out}"),if v.is_finite(){number(v)}else{Value::Null});}
   put!(&format!("TireTemp{out}"),n(&format!("{corner}tempCM"),0.));let rem=["L","M","R"].iter().map(|x|n(&format!("{corner}wear{x}"),f64::NAN)).filter(|x|x.is_finite()).fold(f64::INFINITY,f64::min);put!(&format!("TireWear{out}"),if rem.is_finite(){1.-rem.clamp(0.,1.)}else{0.});
   let pressure=n(&format!("{corner}coldPressure"),f64::NAN);p.insert(format!("TirePressure{}",match out{"FL"=>"FrontLeft","FR"=>"FrontRight","RL"=>"RearLeft",_=>"RearRight"}),if pressure.is_finite()&&pressure>0.{number(pressure*0.1450377377)}else{Value::Null});
   put!(&format!("SuspensionTravelM{out}"),n(&format!("{corner}shockDefl"),0.));put!(&format!("SurfaceRumble{out}"),0.);put!(&format!("TireSlipAngle{out}"),0.);put!(&format!("TireCombinedSlip{out}"),0.);
  }
  put!("Fuel",n("FuelLevel",0.).max(0.));if let Some(cap)=self.yaml.as_deref().and_then(fuel_capacity){p.insert("FuelCapacity".into(),number(cap));}
  put!("DistanceTraveled",if s.length>0.{lap as f64*s.length+dist}else{dist});put!("BestLap",n("LapBestLapTime",0.).max(0.));put!("LastLap",n("LapLastLapTime",0.).max(0.));put!("CurrentLap",curr);put!("CurrentRaceTime",st);
  put!("LapNumber",lap as f64);put!("RacePosition",n("PlayerCarPosition",0.).trunc().max(0.));for (out,src) in [("Accel","Throttle"),("Brake","Brake"),("Clutch","Clutch")]{put!(out,(n(src,0.).clamp(0.,1.)*255.).round());}let gear=n("Gear",0.).trunc();put!("Gear",if gear<0.{0.}else if gear==0.{11.}else{gear});let max=n("SteeringWheelAngleMax",0.).abs();put!("Steer",if max>0.{((-n("SteeringWheelAngle",0.)/max).clamp(-1.,1.)*127.).round()}else{0.});
  put!("CarOrdinal",s.car.max(0.).trunc());put!("CarClass",s.class.max(0.).trunc());put!("DrivetrainType",1.);put!("NumCylinders",s.cylinders.max(0.).trunc());put!("PositionX",0.);put!("PositionY",0.);put!("PositionZ",0.);put!("Speed",n("Speed",0.).max(0.));put!("TrackOrdinal",s.track.max(0.).trunc());put!("TrackTemp",n("TrackTemp",0.));put!("AirTemp",n("AirTemp",0.));put!("RainPercent",(n("Precipitation",0.).clamp(0.,1.)*100.).round());
  Ok(Some(Value::Object(p)))
 }
 fn read_session(&mut self,r:&mut Reader<'_>,schema:u16)->Result<(),String>{
  let s=Session{sid:r.f64()?,sub:r.f64()?,num:r.f64()?,driver:r.f64()?,track:r.f64()?,track_name:r.string()?,length:r.f64()?,sectors:{let n=r.u16()?;if n==0xffff{None}else{if n>4096{return Err("invalid iRacing sector count".into())}let mut v=vec![];for _ in 0..n{v.push(r.f64()?)}Some(v)}},car:r.f64()?,car_name:r.string()?,class:r.f64()?,class_name:r.string()?,idle:r.f64()?,redline:r.f64()?,cylinders:r.f64()?};
  let n=r.u16()? as usize;if n==0||n>4096{return Err("invalid iRacing variable count".into())}let mut vars=Vec::with_capacity(n);let mut vals=HashMap::with_capacity(n);for _ in 0..n{let name=r.string()?;let ty=r.u8()?;let value=r.value(ty)?;if vals.insert(name.clone(),value).is_some(){return Err("duplicate iRacing variable".into())}vars.push(Var{name,ty});}
  let (yaml,rev)=if schema==3{let rev=r.i32()?;let n=r.u32()? as usize;if n>SESSION_MAX{return Err("iRacing SessionInfo too large".into())}(Some(r.utf8(n)?),rev)}else{(None,0)};
  self.schema=schema;self.vars=vars;self.values=vals;self.session=Some(s);self.yaml=yaml;self.revision=rev;Ok(())
 }
}

fn valid_sectors(v:Option<&[f64]>)->Vec<f64>{let Some(v)=v else{return vec![]};let mut x=v.to_vec();x.sort_by(f64::total_cmp);if x.len()>=2&&x[0]<1e-6&&x.iter().all(|n|n.is_finite()&&*n>=0.&&*n<1.)&&x.windows(2).all(|w|w[0]<w[1]){x}else{vec![]}}
fn number(n:f64)->Value{Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null)}
fn fuel_capacity(y:&str)->Option<f64>{for l in y.lines(){if let Some(v)=l.trim().strip_prefix("DriverCarFuelMaxLtr:"){let n=v.trim().trim_matches(['"','\'']).parse::<f64>().ok()?;return (n.is_finite()&&n>0.).then_some(n)}}None}
impl Scalar{fn number(&self)->Option<f64>{match self{Self::Num(x)=>Some(*x),Self::Bool(x)=>Some(if *x{1.}else{0.}),_=>None}}fn truth(&self)->bool{match self{Self::Bool(x)=>*x,Self::Num(x)=>*x!=0.,_=>false}}}
struct Reader<'a>{b:&'a[u8],p:usize}
impl<'a> Reader<'a>{fn take(&mut self,n:usize)->Result<&'a[u8],String>{let e=self.p.checked_add(n).ok_or("iRacing frame offset overflow")?;let s=self.b.get(self.p..e).ok_or("truncated iRacing source frame")?;self.p=e;Ok(s)}fn u8(&mut self)->Result<u8,String>{Ok(self.take(1)?[0])}fn boolean(&mut self)->Result<bool,String>{match self.u8()?{0=>Ok(false),1=>Ok(true),_=>Err("invalid boolean in iRacing source frame".into())}}fn u16(&mut self)->Result<u16,String>{Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))}fn u32(&mut self)->Result<u32,String>{Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))}fn i32(&mut self)->Result<i32,String>{Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))}fn f64(&mut self)->Result<f64,String>{let x=f64::from_le_bytes(self.take(8)?.try_into().unwrap());if !x.is_finite(){return Err("non-finite number in iRacing source frame".into())}Ok(x)}fn string(&mut self)->Result<String,String>{let n=self.u16()? as usize;String::from_utf8(self.take(n)?.to_vec()).map_err(|_|"invalid iRacing UTF-8".into())}fn utf8(&mut self,n:usize)->Result<String,String>{String::from_utf8(self.take(n)?.to_vec()).map_err(|_|"invalid iRacing UTF-8".into())}fn value(&mut self,t:u8)->Result<Scalar,String>{Ok(match t{1=>Scalar::Bool(self.boolean()?),2=>Scalar::Num(self.f64()?),3=>Scalar::Str(self.string()?),4=>{let n=self.u16()? as usize;let mut v=Vec::with_capacity(n);for _ in 0..n{v.push(self.boolean()?)}Scalar::Bools(v)},5=>{let n=self.u16()? as usize;let mut v=Vec::with_capacity(n);for _ in 0..n{v.push(self.f64()?)}Scalar::Nums(v)},_=>return Err("invalid iRacing value type".into())})}}
fn u16le(b:&[u8],o:usize)->Result<u16,String>{Ok(u16::from_le_bytes(b.get(o..o+2).ok_or("truncated iRacing header")?.try_into().unwrap()))}fn u32le(b:&[u8],o:usize)->Result<u32,String>{Ok(u32::from_le_bytes(b.get(o..o+4).ok_or("truncated iRacing header")?.try_into().unwrap()))}

/// Encoder entry point used by native readers and IBT import conversion.
fn field<'a>(v:&'a Value,k:&str)->Result<&'a Value,String>{v.get(k).ok_or_else(||format!("missing iRacing frame field {k}"))}
fn num(v:&Value,k:&str)->Result<f64,String>{field(v,k)?.as_f64().ok_or_else(||format!("invalid iRacing number {k}"))}
fn text(v:&Value,k:&str)->Result<String,String>{field(v,k)?.as_str().map(str::to_owned).ok_or_else(||format!("invalid iRacing string {k}"))}
fn push_u16(b:&mut Vec<u8>,n:usize)->Result<(),String>{let n=u16::try_from(n).map_err(|_|"iRacing value too large")?;b.extend_from_slice(&n.to_le_bytes());Ok(())}
fn push_str(b:&mut Vec<u8>,s:&str)->Result<(),String>{push_u16(b,s.len())?;b.extend_from_slice(s.as_bytes());Ok(())}
fn parse_scalar(v:&Value)->Result<(u8,Vec<u8>),String>{let mut b=vec![];let t=match v{Value::Bool(x)=>{b.push(u8::from(*x));1},Value::Number(n)=>{let f=n.as_f64().filter(|x|x.is_finite()).ok_or("invalid iRacing numeric value")?;b.extend_from_slice(&f.to_le_bytes());2},Value::String(s)=>{push_str(&mut b,s)?;3},Value::Array(a)=>{let is_bool=a.iter().all(Value::is_boolean);push_u16(&mut b,a.len())?;if is_bool{for x in a{b.push(u8::from(x.as_bool().unwrap()))}4}else{for x in a{let f=x.as_f64().filter(|n|n.is_finite()).ok_or("invalid iRacing array value")?;b.extend_from_slice(&f.to_le_bytes())}5}},_=>return Err("unsupported iRacing value".into())};Ok((t,b))}
fn build_header(schema:u16,kind:u8,payload:Vec<u8>)->Result<Vec<u8>,String>{if payload.is_empty()||payload.len()+HEADER>MAX_FRAME{return Err("invalid iRacing encoded frame size".into())}let mut b=Vec::with_capacity(HEADER+payload.len());b.extend_from_slice(&MAGIC.to_le_bytes());b.extend_from_slice(&schema.to_le_bytes());b.push(kind);b.push(0);b.extend_from_slice(&(payload.len() as u32).to_le_bytes());b.extend_from_slice(&payload);Ok(b)}
/// Encode complete versioned iRacing session/context frame.
pub fn encode_session(frame:&Value)->Result<Vec<u8>,String>{
 let schema=field(frame,"schemaVersion")?.as_u64().ok_or("invalid iRacing schema")? as u16;if schema!=2&&schema!=3{return Err("invalid iRacing schema".into())}
 let s=field(frame,"session")?;let mut p=vec![];for k in ["sessionId","subSessionId","sessionNum","driverCarIdx","trackId"]{p.extend_from_slice(&num(s,k)?.to_le_bytes())}
 push_str(&mut p,&text(s,"trackName")?)?;p.extend_from_slice(&num(s,"trackLengthM")?.to_le_bytes());
 let sectors=s.get("sectorStarts");if sectors.is_none()||sectors==Some(&Value::Null){p.extend_from_slice(&0xffffu16.to_le_bytes())}else{let a=sectors.unwrap().as_array().ok_or("invalid iRacing sectors")?;push_u16(&mut p,a.len())?;for x in a{p.extend_from_slice(&x.as_f64().filter(|n|n.is_finite()).ok_or("invalid iRacing sector")?.to_le_bytes())}}
 for k in ["carId"]{p.extend_from_slice(&num(s,k)?.to_le_bytes())}push_str(&mut p,&text(s,"carName")?)?;p.extend_from_slice(&num(s,"carClassId")?.to_le_bytes());push_str(&mut p,&text(s,"carClassName")?)?;for k in ["engineIdleRpm","engineRedlineRpm","engineCylinderCount"]{p.extend_from_slice(&num(s,k)?.to_le_bytes())}
 let values=field(frame,"values")?.as_object().ok_or("invalid iRacing values")?;if values.is_empty()||values.len()>4096{return Err("invalid iRacing variable count".into())}push_u16(&mut p,values.len())?;for(k,v)in values{let(t,b)=parse_scalar(v)?;push_str(&mut p,k)?;p.push(t);p.extend_from_slice(&b)}
 if schema==3{let rev=field(frame,"sessionInfoUpdate")?.as_i64().filter(|x|*x>=i32::MIN as i64&&*x<=i32::MAX as i64).ok_or("invalid iRacing SessionInfo revision")? as i32;let yaml=text(frame,"sessionInfo")?;if yaml.len()>SESSION_MAX{return Err("iRacing SessionInfo too large".into())}p.extend_from_slice(&rev.to_le_bytes());p.extend_from_slice(&(yaml.len() as u32).to_le_bytes());p.extend_from_slice(yaml.as_bytes())}
 build_header(schema,1,p)
}
/// Encode typed changed values against prior complete state.
pub fn encode_delta(frame:&Value)->Result<Vec<u8>,String>{
 let schema=field(frame,"schemaVersion")?.as_u64().ok_or("invalid iRacing schema")? as u16;if schema!=2&&schema!=3{return Err("invalid iRacing schema".into())}let values=field(frame,"values")?.as_object().ok_or("invalid iRacing values")?;let prev=field(frame,"previousValues")?.as_object().ok_or("missing previous iRacing values")?;
 let mut changes=vec![];for(k,v)in values{if prev.get(k)==Some(v){continue}let(_,b)=parse_scalar(v)?;let i=values.keys().position(|name|name==k).unwrap();let i=u16::try_from(i).map_err(|_|"too many iRacing variables")?;changes.push((i,b));}let mut p=vec![];push_u16(&mut p,changes.len())?;for(i,b)in changes{p.extend_from_slice(&i.to_le_bytes());p.extend_from_slice(&b)}build_header(schema,2,p)
}
