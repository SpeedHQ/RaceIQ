use serde_json::{Map, Number, Value};

const MAGIC: &[u8;8]=b"RQLMUSF\0";
 const H:usize=28;
use crate::games::generated::layouts as offsets;
fn slice(b:&[u8],o:usize,n:usize)->Result<&[u8],String>{b.get(o..o.checked_add(n).ok_or("LMU offset overflow")?).ok_or_else(||format!("short LMU source at {o}"))}
fn i32v(b:&[u8],o:usize)->i32{i32::from_le_bytes(b[o..o+4].try_into().unwrap())}
fn u32v(b:&[u8],o:usize)->u32{u32::from_le_bytes(b[o..o+4].try_into().unwrap())}
fn i16v(b:&[u8],o:usize)->i16{i16::from_le_bytes(b[o..o+2].try_into().unwrap())}
fn u16v(b:&[u8],o:usize)->u16{u16::from_le_bytes(b[o..o+2].try_into().unwrap())}
fn f64v(b:&[u8],o:usize)->f64{let x=f64::from_bits(u64::from_le_bytes(b[o..o+8].try_into().unwrap()));if x.is_finite(){x}else{0.}}
fn f64v_default(b:&[u8],o:usize,default:f64)->f64{let x=f64::from_bits(u64::from_le_bytes(b[o..o+8].try_into().unwrap()));if x.is_finite(){x}else{default}}
fn f32v(b:&[u8],o:usize)->f64{let x=f32::from_bits(u32v(b,o)) as f64;if x.is_finite(){x}else{0.}}
fn text(b:&[u8],o:usize,n:usize)->std::borrow::Cow<'_,str>{
 let s=&b[o..o+n];let end=s.iter().position(|x|*x==0).unwrap_or(n);
 match String::from_utf8_lossy(&s[..end]){
  std::borrow::Cow::Borrowed(value)=>std::borrow::Cow::Borrowed(value.trim()),
  std::borrow::Cow::Owned(mut value)=>{
   value.truncate(value.trim_end().len());
   let start=value.len()-value.trim_start().len();value.drain(..start);
   std::borrow::Cow::Owned(value)
  },
 }
}
fn strv(b:&[u8],o:usize,n:usize)->String{text(b,o,n).into_owned()}
fn putf(m:&mut Map<String,Value>,k:&str,v:f64){m.insert(k.into(),Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null));}
fn puti(m:&mut Map<String,Value>,k:&str,v:i64){m.insert(k.into(),Value::Number(v.into()));}
fn clamp(v:f64,a:f64,b:f64)->f64{v.max(a).min(b)}
fn time(v:f64)->f64{if v>0.{v}else{0.}}

#[derive(Default)]
struct IdentityCache {
 inputs: [String;4],
 car_id: Option<&'static str>,
 track_id: Option<&'static str>,
}
impl IdentityCache {
 fn resolve<'a>(&mut self,inputs:[&'a str;4])->(&'a str,&'a str){
  if self.inputs.iter().zip(inputs).any(|(cached,input)|cached!=input){
   self.car_id=crate::games::catalog::resolve_lmu_car(inputs[0],inputs[1])
    .and_then(|value|value.get("id").and_then(Value::as_str));
   self.track_id=crate::games::catalog::resolve_lmu_track(&inputs[2..])
    .and_then(|value|value.get("id").and_then(Value::as_str));
   for (cached,input) in self.inputs.iter_mut().zip(inputs){
    cached.clear();cached.push_str(input);
   }
  }
  (self.car_id.unwrap_or(inputs[0]),self.track_id.unwrap_or(if inputs[2].is_empty(){inputs[3]}else{inputs[2]}))
 }
}
struct LmuFrame<'a> { game_version:i32,session_event:u32,timestamp_ms:f64,telemetry:&'a [u8],scoring_info:&'a [u8],player_scoring:Option<&'a [u8]> }
 fn player_offset(raw:&[u8],vehicle_id:i32)->Option<usize>{let info=offsets::LMU_LMU_SCORING_INFO_OFFSET as usize;let vehicle=offsets::LMU_LMU_SCORING_VEHICLE_SIZE as usize;let n=(i32v(raw,info+offsets::LMU_LMU_SCORING_INFO_NUMBER_OF_VEHICLES)).clamp(0,offsets::LMU_LMU_MAX_VEHICLES as i32) as usize;let mut player=None;for i in 0..n{let o=offsets::LMU_LMU_SCORING_VEHICLES_OFFSET as usize+i*vehicle;if i32v(raw,o)==vehicle_id{return Some(o)}if raw[o+offsets::LMU_LMU_SCORING_VEHICLE_IS_PLAYER]!=0{player=Some(o)}}player}
 fn decode_lmu_source_frame(b:&[u8])->Result<Option<LmuFrame<'_>>,String>{
  let (tele,scoring,vehicle)=(offsets::LMU_LMU_TELEMETRY_INFO_SIZE as usize,offsets::LMU_LMU_SCORING_INFO_SIZE as usize,offsets::LMU_LMU_SCORING_VEHICLE_SIZE as usize);if b.len()<12||b.get(..8)!=Some(MAGIC){return Ok(None)}let schema=u16v(b,8);let expected=match schema{1=>H+tele+scoring+vehicle,2=>H+offsets::LMU_LMU_SHARED_MEMORY_SIZE as usize,_=>return Ok(None)};if b.len()!=expected{return Ok(None)}
  let stamp=f64::from_bits(u64::from_le_bytes(slice(b,20,8)?.try_into().unwrap()));if !stamp.is_finite()||stamp<0.{return Ok(None)}let raw=if schema==2{Some(&b[H..])}else{None};
  let (telemetry,scoring_info,player_scoring)=if let Some(r)=raw{let header=offsets::LMU_LMU_TELEMETRY_HEADER_OFFSET as usize;let count=r[header].min(offsets::LMU_LMU_MAX_VEHICLES as u8);let idx=r[header+1];if idx>=count{return Ok(None)}let to=offsets::LMU_LMU_TELEMETRY_INFO_OFFSET as usize+idx as usize*tele;let p=player_offset(r,i32v(r,to+offsets::LMU_LMU_TELEMETRY_ID));(&r[to..to+tele],&r[offsets::LMU_LMU_SCORING_INFO_OFFSET as usize..offsets::LMU_LMU_SCORING_INFO_OFFSET as usize+scoring],p.map(|o|&r[o..o+vehicle]))}else{let t=&b[H..H+tele];let s=&b[H+tele..H+tele+scoring];let p=if u16v(b,10)&1!=0{Some(&b[H+tele+scoring..])}else{None};(t,s,p)};
  Ok(Some(LmuFrame{game_version:i32v(b,12),session_event:u32v(b,16),timestamp_ms:stamp,telemetry,scoring_info,player_scoring}))
 }
 pub fn encode_lmu_source_payload(game_version:i32,session_event:u32,capture_timestamp_ms:f64,telemetry:&[u8],scoring_info:&[u8],player_scoring:Option<&[u8]>)->Result<Vec<u8>,String>{let (ts,ss,sv)=(offsets::LMU_LMU_TELEMETRY_INFO_SIZE as usize,offsets::LMU_LMU_SCORING_INFO_SIZE as usize,offsets::LMU_LMU_SCORING_VEHICLE_SIZE as usize);if telemetry.len()!=ts||scoring_info.len()!=ss||player_scoring.is_some_and(|p|p.len()!=sv)||!capture_timestamp_ms.is_finite()||capture_timestamp_ms<0.{return Err("invalid LMU source payload structure/timestamp".into())}let mut b=vec![0;H+ts+ss+sv];b[..8].copy_from_slice(MAGIC);b[8..10].copy_from_slice(&1u16.to_le_bytes());b[10..12].copy_from_slice(&(if player_scoring.is_some(){1u16}else{0}).to_le_bytes());b[12..16].copy_from_slice(&game_version.to_le_bytes());b[16..20].copy_from_slice(&session_event.to_le_bytes());b[20..28].copy_from_slice(&capture_timestamp_ms.to_le_bytes());b[H..H+ts].copy_from_slice(telemetry);b[H+ts..H+ts+ss].copy_from_slice(scoring_info);if let Some(p)=player_scoring{b[H+ts+ss..].copy_from_slice(p)}Ok(b)}
 pub fn encode_lmu_source_frame(shared_memory:&[u8],capture_timestamp_ms:f64)->Option<Vec<u8>>{let size=offsets::LMU_LMU_SHARED_MEMORY_SIZE as usize;if shared_memory.len()<size||!capture_timestamp_ms.is_finite()||capture_timestamp_ms<0.{return None}let header=offsets::LMU_LMU_TELEMETRY_HEADER_OFFSET as usize;let active=shared_memory[header].min(offsets::LMU_LMU_MAX_VEHICLES as u8);let idx=shared_memory[header+1];if shared_memory[header+2]==0||active==0||idx>=active{return None}let to=offsets::LMU_LMU_TELEMETRY_INFO_OFFSET as usize+idx as usize*offsets::LMU_LMU_TELEMETRY_INFO_SIZE as usize;let off=player_offset(shared_memory,i32v(shared_memory,to+offsets::LMU_LMU_TELEMETRY_ID));let mut b=vec![0;H+size];b[..8].copy_from_slice(MAGIC);b[8..10].copy_from_slice(&2u16.to_le_bytes());b[10..12].copy_from_slice(&(if off.is_some(){1u16}else{0}).to_le_bytes());b[12..16].copy_from_slice(&i32v(shared_memory,offsets::LMU_LMU_GAME_VERSION_OFFSET as usize).to_le_bytes());b[16..20].copy_from_slice(&u32v(shared_memory,offsets::LMU_LMU_SESSION_EVENT_OFFSET as usize).to_le_bytes());b[20..28].copy_from_slice(&capture_timestamp_ms.to_le_bytes());b[H..].copy_from_slice(&shared_memory[..size]);Some(b)}

pub struct LmuParser { identity: IdentityCache }
impl LmuParser{
 pub fn new()->Self{Self{identity:IdentityCache::default()}}
 pub fn reset(&mut self){self.identity=IdentityCache::default();}
 pub fn feed(&mut self,frame:&[u8],_time_ms:u64)->Result<Option<Value>,String>{
  let Some(f)=decode_lmu_source_frame(frame)? else{return Ok(None)};
  Ok(Some(normalize(&f,&mut self.identity)))
 }
}
fn normalize(f:&LmuFrame<'_>,identity:&mut IdentityCache)->Value{
 let t=f.telemetry;let s=f.scoring_info;let p=f.player_scoring;
 let session=i32v(s,offsets::LMU_LMU_SCORING_INFO_SESSION);
 let car_name=text(t,offsets::LMU_LMU_TELEMETRY_VEHICLE_NAME,64);
 let car_model=text(t,offsets::LMU_LMU_TELEMETRY_VEHICLE_MODEL,30);
 let score_track=text(s,offsets::LMU_LMU_SCORING_INFO_TRACK_NAME,64);
 let tele_track=text(t,offsets::LMU_LMU_TELEMETRY_TRACK_NAME,64);
 let car_key=if car_model.is_empty(){car_name.as_ref()}else{car_model.as_ref()};
 let track_key=if score_track.is_empty(){tele_track.as_ref()}else{score_track.as_ref()};
 let (car_id,track_id)=identity.resolve([car_key,&car_name,&score_track,&tele_track]);
 let mut l=Map::new();for (k,v) in [("carId",Value::String(car_id.to_owned())),("trackId",Value::String(track_id.to_owned())),("gameVersion",Value::Number(f.game_version.into())),("sessionTypeOrdinal",Value::Number(session.into())),("vehicleId",Value::Number(i32v(t,offsets::LMU_LMU_TELEMETRY_ID).into())),("driverName",Value::String(p.map_or_else(||strv(s,offsets::LMU_LMU_SCORING_INFO_PLAYER_NAME,32),|q|strv(q,offsets::LMU_LMU_SCORING_VEHICLE_DRIVER_NAME,32)))),("carName",Value::String(car_name.as_ref().to_owned())),("carModel",Value::String(car_model.as_ref().to_owned())),("trackName",Value::String(track_key.to_owned())),("vehicleClass",Value::Number((t[offsets::LMU_LMU_TELEMETRY_VEHICLE_CLASS] as i64).into())),("lapInvalidated",Value::Bool(t[offsets::LMU_LMU_TELEMETRY_LAP_INVALIDATED]!=0)),("inPits",Value::Bool(p.is_some_and(|q|q[offsets::LMU_LMU_SCORING_VEHICLE_IN_PITS]!=0))),("rearFlapActivated",Value::Bool(t[offsets::LMU_LMU_TELEMETRY_REAR_FLAP_ACTIVATED]!=0)),("speedLimiterActive",Value::Bool(t[offsets::LMU_LMU_TELEMETRY_SPEED_LIMITER_ACTIVE]!=0)),("tcActive",Value::Bool(t[offsets::LMU_LMU_TELEMETRY_TC_ACTIVE]!=0)),("absActive",Value::Bool(t[offsets::LMU_LMU_TELEMETRY_ABS_ACTIVE]!=0)),("pitState",Value::Number(p.map_or(0,|q|q[offsets::LMU_LMU_SCORING_VEHICLE_PIT_STATE] as i64).into())),("frontTireCompound",Value::String(strv(t,offsets::LMU_LMU_TELEMETRY_FRONT_TIRE_COMPOUND_NAME,18))),("rearTireCompound",Value::String(strv(t,offsets::LMU_LMU_TELEMETRY_REAR_TIRE_COMPOUND_NAME,18))) ]{l.insert(k.into(),v);}
 let types=["test-day","practice-1","practice-2","practice-3","practice-4","qualifying-1","qualifying-2","qualifying-3","qualifying-4","warmup","race","race-2","race-3","race-4"];
 let track_len=f64v(s,offsets::LMU_LMU_SCORING_INFO_LAP_DISTANCE).max(0.);let distance=p.map_or(0.,|q|f64v(q,offsets::LMU_LMU_SCORING_VEHICLE_LAP_DISTANCE).max(0.));let elapsed=f64v(t,offsets::LMU_LMU_TELEMETRY_ELAPSED_TIME).max(0.);let start=f64v(t,offsets::LMU_LMU_TELEMETRY_LAP_START_ELAPSED_TIME).max(0.);let lapnum=i32v(t,offsets::LMU_LMU_TELEMETRY_LAP_NUMBER);let sector=i32v(t,offsets::LMU_LMU_TELEMETRY_CURRENT_SECTOR)&0x7fffffff;let rain=clamp(f64v(s,offsets::LMU_LMU_SCORING_INFO_RAINING),0.,1.);let cloud=s[offsets::LMU_LMU_SCORING_INFO_CLOUD_COVERAGE];let weather=if rain>=0.66{4}else if rain>0.{3}else if cloud>=4{2}else if cloud>0{1}else{0};
 l.insert("sessionType".into(),Value::String(types.get(session as usize).unwrap_or(&"unknown").to_string()));putf(&mut l,"deltaBest",f64v(t,offsets::LMU_LMU_TELEMETRY_DELTA_BEST));putf(&mut l,"trackLengthM",track_len);putf(&mut l,"lapDistanceM",distance);puti(&mut l,"currentSectorIndex",sector as i64);
 if let Some(q)=p{for (key,o) in [("bestSector1",offsets::LMU_LMU_SCORING_VEHICLE_BEST_SECTOR1),("bestSector2",offsets::LMU_LMU_SCORING_VEHICLE_BEST_SECTOR2),("lastSector1",offsets::LMU_LMU_SCORING_VEHICLE_LAST_SECTOR1),("lastSector2",offsets::LMU_LMU_SCORING_VEHICLE_LAST_SECTOR2),("currentSector1",offsets::LMU_LMU_SCORING_VEHICLE_CURRENT_SECTOR1),("currentSector2",offsets::LMU_LMU_SCORING_VEHICLE_CURRENT_SECTOR2)]{putf(&mut l,key,time(f64v(q,o)));}}
 for(k,o)in[("rearFlapLegalStatus",offsets::LMU_LMU_TELEMETRY_REAR_FLAP_LEGAL_STATUS),("tcLevel",offsets::LMU_LMU_TELEMETRY_TC),("tcCutLevel",offsets::LMU_LMU_TELEMETRY_TC_CUT),("absLevel",offsets::LMU_LMU_TELEMETRY_ABS),("motorMap",offsets::LMU_LMU_TELEMETRY_MOTOR_MAP),("migration",offsets::LMU_LMU_TELEMETRY_MIGRATION),("frontAntiSway",offsets::LMU_LMU_TELEMETRY_FRONT_ANTI_SWAY),("rearAntiSway",offsets::LMU_LMU_TELEMETRY_REAR_ANTI_SWAY),("trackLimitsSteps",offsets::LMU_LMU_TELEMETRY_TRACK_LIMITS_STEPS)]{puti(&mut l,k,t[o] as i64)}putf(&mut l,"batteryChargeFraction",clamp(f64v(t,offsets::LMU_LMU_TELEMETRY_BATTERY_CHARGE_FRACTION),0.,1.));putf(&mut l,"stateOfCharge",f32v(t,offsets::LMU_LMU_TELEMETRY_STATE_OF_CHARGE));putf(&mut l,"virtualEnergy",f32v(t,offsets::LMU_LMU_TELEMETRY_VIRTUAL_ENERGY));putf(&mut l,"regenKw",f32v(t,offsets::LMU_LMU_TELEMETRY_REGEN_KW));puti(&mut l,"trackGripLevel",s[offsets::LMU_LMU_SCORING_INFO_TRACK_GRIP_LEVEL] as i64);puti(&mut l,"cloudCoverage",cloud as i64);
 let mut out=Map::new();out.insert("gameId".into(),Value::String("lmu".into()));out.insert("lmu".into(),Value::Object(l));out.insert("sessionUID".into(),Value::String(serde_json::json!([f.game_version,f.session_event,session,car_id,track_id]).to_string()));puti(&mut out,"IsRaceOn",if s[offsets::LMU_LMU_SCORING_INFO_IN_REALTIME]!=0{1}else{0});puti(&mut out,"TimestampMS",f.timestamp_ms.round() as i64);
 for k in ["NormSuspensionTravelFL","NormSuspensionTravelFR","NormSuspensionTravelRL","NormSuspensionTravelRR","TireSlipRatioFL","TireSlipRatioFR","TireSlipRatioRL","TireSlipRatioRR","WheelRotationSpeedFL","WheelRotationSpeedFR","WheelRotationSpeedRL","WheelRotationSpeedRR","WheelOnRumbleStripFL","WheelOnRumbleStripFR","WheelOnRumbleStripRL","WheelOnRumbleStripRR","WheelInPuddleDepthFL","WheelInPuddleDepthFR","WheelInPuddleDepthRL","WheelInPuddleDepthRR","SurfaceRumbleFL_2","SurfaceRumbleFR_2","SurfaceRumbleRL_2","SurfaceRumbleRR_2","TireSlipCombinedFL_2","TireTempFL","TireTempFR","TireTempRL","TireTempRR","Boost","Fuel","FuelCapacity","BestLap","LastLap","CurrentLap","CurrentRaceTime","LapNumber","RacePosition","Accel","Brake","Clutch","HandBrake","Gear","Steer","NormDrivingLine","NormAIBrakeDiff","TireWearFL","TireWearFR","TireWearRL","TireWearRR","SurfaceRumbleFL","SurfaceRumbleFR","SurfaceRumbleRL","SurfaceRumbleRR","TireSlipAngleFL","TireSlipAngleFR","TireSlipAngleRL","TireSlipAngleRR","TireCombinedSlipFL","TireCombinedSlipFR","TireCombinedSlipRL","TireCombinedSlipRR","SuspensionTravelMFL","SuspensionTravelMFR","SuspensionTravelMRL","SuspensionTravelMRR","CarOrdinal","CarClass","CarPerformanceIndex","DrivetrainType","NumCylinders","PositionX","PositionY","PositionZ","Speed","Power","Torque","TrackOrdinal"] { putf(&mut out,k,0.); }
 let vels=[f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_VELOCITY),f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_VELOCITY+8),-f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_VELOCITY+16)];let acc=[f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_ACCELERATION),f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_ACCELERATION+8),-f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_ACCELERATION+16)];let pos=[f64v(t,offsets::LMU_LMU_TELEMETRY_POSITION),f64v(t,offsets::LMU_LMU_TELEMETRY_POSITION+8),f64v(t,offsets::LMU_LMU_TELEMETRY_POSITION+16)];let orientation=offsets::LMU_LMU_TELEMETRY_ORIENTATION;let o1=orientation+24;let o2=orientation+48;let forward=[-f64v(t,orientation+16),-f64v(t,o1+16),-f64v(t,o2+16)];let motor_rpm=f64v(t,offsets::LMU_LMU_TELEMETRY_ELECTRIC_BOOST_MOTOR_RPM);let motor_torque=f64v(t,offsets::LMU_LMU_TELEMETRY_ELECTRIC_BOOST_MOTOR_TORQUE);
 for(k,v)in[("EngineMaxRpm",f64v(t,offsets::LMU_LMU_TELEMETRY_ENGINE_MAX_RPM).max(0.)),("EngineIdleRpm",0.),("CurrentEngineRpm",f64v(t,offsets::LMU_LMU_TELEMETRY_ENGINE_RPM).max(0.)),("AccelerationX",acc[0]),("AccelerationY",acc[1]),("AccelerationZ",acc[2]),("VelocityX",vels[0]),("VelocityY",vels[1]),("VelocityZ",vels[2]),("AngularVelocityX",f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_ROTATION)),("AngularVelocityY",f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_ROTATION+8)),("AngularVelocityZ",f64v(t,offsets::LMU_LMU_TELEMETRY_LOCAL_ROTATION+16)),("Yaw",forward[0].atan2(forward[2])),("Pitch",forward[1].clamp(-1.,1.).asin()),("Roll",(-f64v(t,o1)).atan2(f64v(t,o1+8))),("Fuel",f64v(t,offsets::LMU_LMU_TELEMETRY_FUEL).max(0.)),("FuelCapacity",f64v(t,offsets::LMU_LMU_TELEMETRY_FUEL_CAPACITY).max(0.)),("DistanceTraveled",(if let Some(q)=p{i16v(q,offsets::LMU_LMU_SCORING_VEHICLE_TOTAL_LAPS).max(0) as f64}else{(lapnum-1).max(0) as f64})*track_len+distance),("CurrentLap",(elapsed-start).max(0.)),("CurrentRaceTime",elapsed),("Power",f64v(t,offsets::LMU_LMU_TELEMETRY_ENGINE_TORQUE)*f64v(t,offsets::LMU_LMU_TELEMETRY_ENGINE_RPM)*std::f64::consts::TAU/60.+motor_torque*motor_rpm*std::f64::consts::TAU/60.),("Torque",f64v(t,offsets::LMU_LMU_TELEMETRY_ENGINE_TORQUE)+motor_torque),("PositionX",pos[0]),("PositionY",pos[1]),("PositionZ",pos[2]),("Speed",vels[0].hypot(vels[1]).hypot(vels[2])),("TrackTemp",f64v(s,offsets::LMU_LMU_SCORING_INFO_TRACK_TEMPERATURE)),("AirTemp",f64v(s,offsets::LMU_LMU_SCORING_INFO_AMBIENT_TEMPERATURE)),("RainPercent",(rain*100.).round()),("WeatherType",weather as f64)]{putf(&mut out,k,v)}
 putf(&mut out,"BestLap",p.map_or(0.,|q|time(f64v(q,offsets::LMU_LMU_SCORING_VEHICLE_BEST_LAP_TIME))));putf(&mut out,"LastLap",p.map_or(0.,|q|time(f64v(q,offsets::LMU_LMU_SCORING_VEHICLE_LAST_LAP_TIME))));
 puti(&mut out,"LapNumber",(lapnum+1).max(1) as i64);puti(&mut out,"RacePosition",p.map_or(0,|q|q[offsets::LMU_LMU_SCORING_VEHICLE_PLACE]) as i64);for(k,o)in[("Accel",offsets::LMU_LMU_TELEMETRY_THROTTLE),("Brake",offsets::LMU_LMU_TELEMETRY_BRAKE),("Clutch",offsets::LMU_LMU_TELEMETRY_CLUTCH)]{puti(&mut out,k,(clamp(f64v(t,o),0.,1.)*255.).round() as i64)}puti(&mut out,"HandBrake",0);puti(&mut out,"Gear",{let g=i32v(t,offsets::LMU_LMU_TELEMETRY_GEAR);if g<0{0}else if g==0{11}else{g}} as i64);puti(&mut out,"Steer",(clamp(f64v(t,offsets::LMU_LMU_TELEMETRY_STEERING),-1.,1.)*127.).round() as i64);
 let names=["FL","FR","RL","RR"];for(i,n)in names.iter().enumerate(){let o=offsets::LMU_LMU_TELEMETRY_WHEELS+i*offsets::LMU_LMU_WHEEL_SIZE as usize;let patch=f64v(t,o+offsets::LMU_LMU_WHEEL_LONGITUDINAL_PATCH_VELOCITY);let ground=f64v(t,o+offsets::LMU_LMU_WHEEL_LONGITUDINAL_GROUND_VELOCITY);let lat=f64v(t,o+offsets::LMU_LMU_WHEEL_LATERAL_PATCH_VELOCITY);let slip=patch/ground.abs().max(1.);let angle=lat.atan2(ground.abs().max(0.1));let base=o+offsets::LMU_LMU_WHEEL_TEMPERATURE;let temp=[f64v(t,base)-273.15,f64v(t,base+8)-273.15,f64v(t,base+16)-273.15];let temps=[temp[2],temp[1],temp[0]];let side=match i{0=>"FrontLeft",1=>"FrontRight",2=>"RearLeft",_=>"RearRight"};let fields=[(format!("TireSlipRatio{n}"),slip),(format!("WheelRotationSpeed{n}"),f64v(t,o+offsets::LMU_LMU_WHEEL_ROTATION)),(format!("TireSlipAngle{n}"),angle),(format!("TireCombinedSlip{n}"),slip.hypot(angle.tan())),(format!("SuspensionTravelM{n}"),f64v(t,o+offsets::LMU_LMU_WHEEL_SUSPENSION_DEFLECTION)),(format!("BrakeTemp{side}"),f64v(t,o+offsets::LMU_LMU_WHEEL_BRAKE_TEMPERATURE)),(format!("TirePressure{side}"),f64v(t,o+offsets::LMU_LMU_WHEEL_PRESSURE_KPA)*0.1450377377),(format!("TireTemp{n}"),(temp[0]+temp[1]+temp[2])/3.),(format!("TireCarcassAverageTemp{n}"),f64v(t,o+offsets::LMU_LMU_WHEEL_TIRE_CARCASS_TEMPERATURE)-273.15),(format!("TireSurfaceTempInner{n}"),temps[0]),(format!("TireSurfaceTempMiddle{n}"),temp[1]),(format!("TireSurfaceTempOuter{n}"),temps[2]),(format!("TireWear{n}"),1.-clamp(f64v(t,o+offsets::LMU_LMU_WHEEL_WEAR),0.,1.))];for(k,v)in fields{putf(&mut out,&k,v)}puti(&mut out,&format!("WheelOnRumbleStrip{n}"),if t[o+offsets::LMU_LMU_WHEEL_SURFACE_TYPE]==5{1}else{0});for prefix in ["NormSuspensionTravel","WheelInPuddleDepth","SurfaceRumble","SurfaceRumble_2"]{puti(&mut out,&format!("{prefix}{n}"),0)} }
 for(i,n)in names.iter().enumerate(){let o=offsets::LMU_LMU_TELEMETRY_WHEELS+i*offsets::LMU_LMU_WHEEL_SIZE as usize;let base=o+offsets::LMU_LMU_WHEEL_TEMPERATURE;let (inner,outer)=if i%2==0{(base+16,base)}else{(base,base+16)};putf(&mut out,&format!("TireSurfaceTempInner{n}"),f64v_default(t,inner,273.15)-273.15);putf(&mut out,&format!("TireSurfaceTempOuter{n}"),f64v_default(t,outer,273.15)-273.15);out.remove(&format!("SurfaceRumble_2{n}"));}
 putf(&mut out,"TireSlipCombinedFL_2",{let o=offsets::LMU_LMU_TELEMETRY_WHEELS;let patch=f64v(t,o+offsets::LMU_LMU_WHEEL_LONGITUDINAL_PATCH_VELOCITY);let ground=f64v(t,o+offsets::LMU_LMU_WHEEL_LONGITUDINAL_GROUND_VELOCITY);let lateral=f64v(t,o+offsets::LMU_LMU_WHEEL_LATERAL_PATCH_VELOCITY);let slip=patch/ground.abs().max(1.);slip.hypot(lateral.atan2(ground.abs().max(0.1)).tan())});
 for(k,v)in[("Boost",0), ("CarOrdinal",-1),("CarClass",t[offsets::LMU_LMU_TELEMETRY_VEHICLE_CLASS] as i64),("CarPerformanceIndex",0),("DrivetrainType",1),("NumCylinders",0),("TrackOrdinal",-1),("NormDrivingLine",0),("NormAIBrakeDiff",0),("DrsActive",if t[offsets::LMU_LMU_TELEMETRY_REAR_FLAP_ACTIVATED]!=0{1}else{0})]{puti(&mut out,k,v)}
 out.into()
}

#[cfg(test)]
mod tests {
 use super::*;

 fn expected_identity(inputs:[&str;4])->(&str,&str){
  let car=crate::games::catalog::resolve_lmu_car(inputs[0],inputs[1])
   .and_then(|value|value["id"].as_str()).unwrap_or(inputs[0]);
  let fallback=if inputs[2].is_empty(){inputs[3]}else{inputs[2]};
  let track=crate::games::catalog::resolve_lmu_track(&inputs[2..])
   .and_then(|value|value["id"].as_str()).unwrap_or(fallback);
  (car,track)
 }

 #[test]
 fn identity_cache_invalidates_each_independent_input(){
  let catalog=crate::games::catalog::game("lmu").unwrap();
  let cars=catalog["cars"].as_array().unwrap();
  let tracks=catalog["tracks"].as_array().unwrap();
  let base=["unknown model",cars[0]["vehicleNames"][0].as_str().unwrap(),
   tracks[0]["layout"].as_str().unwrap(),tracks[0]["layout"].as_str().unwrap()];
  let replacements=[cars[1]["id"].as_str().unwrap(),
   cars[1]["vehicleNames"][0].as_str().unwrap(),
   tracks[1]["layout"].as_str().unwrap(),tracks[1]["layout"].as_str().unwrap()];
  for index in 0..4{
   let mut cache=IdentityCache::default();
   let before=cache.resolve(base);
   assert_eq!(before,expected_identity(base));
   let mut changed=base;changed[index]=replacements[index];
   let after=cache.resolve(changed);
   assert_eq!(after,expected_identity(changed),"input {index}");
   assert_ne!(after,before,"input {index} must affect this fixture");
   assert_eq!(cache.resolve(base),before,"restore input {index}");
  }
 }


 #[test]
 fn identity_fallbacks_preserve_empty_and_unknown_inputs(){
  let mut cache=IdentityCache::default();
  assert_eq!(cache.resolve(["","","",""]),("",""));
  assert_eq!(cache.resolve(["unknown","unknown name","","unknown telemetry"]),("unknown","unknown telemetry"));
  assert_eq!(cache.resolve(["unknown","unknown name","unknown scoring","unknown telemetry"]),("unknown","unknown scoring"));
  assert_eq!(cache.resolve(["unknown","unknown name"," ","unknown telemetry"]),("unknown"," "));
 }


 #[test]
 fn identity_text_preserves_utf8_and_lossy_trim_semantics(){
  assert_eq!(text(b"  Car \0ignored",0,14),"Car");
  let invalid=b" \xff Car \0ignored";
  assert_eq!(text(invalid,0,invalid.len()),String::from_utf8_lossy(&invalid[..7]).trim());
  assert_eq!(text(b" \t ",0,3),"");
 }

 #[test]
 fn parser_materializes_full_identity_and_telemetry_across_identity_changes(){
  fn put_text(bytes:&mut [u8],offset:usize,size:usize,value:&str){
   bytes[offset..offset+size].fill(0);
   bytes[offset..offset+value.len()].copy_from_slice(value.as_bytes());
  }
  fn put_double(bytes:&mut [u8],offset:usize,value:f64){
   bytes[offset..offset+8].copy_from_slice(&value.to_le_bytes());
  }
  let mut telemetry=vec![0;offsets::LMU_LMU_TELEMETRY_INFO_SIZE as usize];
  let mut scoring=vec![0;offsets::LMU_LMU_SCORING_INFO_SIZE as usize];
  put_text(&mut telemetry,offsets::LMU_LMU_TELEMETRY_VEHICLE_MODEL,30,"911gt3r_2024");
  put_text(&mut telemetry,offsets::LMU_LMU_TELEMETRY_VEHICLE_NAME,64,"Unknown team");
  put_text(&mut telemetry,offsets::LMU_LMU_TELEMETRY_TRACK_NAME,64,"BahrainWEC");
  put_text(&mut scoring,offsets::LMU_LMU_SCORING_INFO_TRACK_NAME,64,"BahrainWEC");
  scoring[offsets::LMU_LMU_SCORING_INFO_IN_REALTIME]=1;
  scoring[offsets::LMU_LMU_SCORING_INFO_SESSION..offsets::LMU_LMU_SCORING_INFO_SESSION+4]
   .copy_from_slice(&10i32.to_le_bytes());
  put_double(&mut telemetry,offsets::LMU_LMU_TELEMETRY_LOCAL_VELOCITY,3.);
  put_double(&mut telemetry,offsets::LMU_LMU_TELEMETRY_LOCAL_VELOCITY+16,4.);
  put_double(&mut telemetry,offsets::LMU_LMU_TELEMETRY_ENGINE_RPM,6000.);
  put_double(&mut telemetry,offsets::LMU_LMU_TELEMETRY_ENGINE_TORQUE,100.);
  put_double(&mut telemetry,offsets::LMU_LMU_TELEMETRY_THROTTLE,0.5);
  put_double(&mut telemetry,offsets::LMU_LMU_TELEMETRY_ELAPSED_TIME,20.);
  put_double(&mut telemetry,offsets::LMU_LMU_TELEMETRY_LAP_START_ELAPSED_TIME,5.);
  put_double(&mut scoring,offsets::LMU_LMU_SCORING_INFO_RAINING,0.75);
  for wheel in 0..4{
   let base=offsets::LMU_LMU_TELEMETRY_WHEELS+wheel*offsets::LMU_LMU_WHEEL_SIZE as usize;
   for index in 0..3{
    put_double(&mut telemetry,base+offsets::LMU_LMU_WHEEL_TEMPERATURE+index*8,300.+index as f64);
   }
  }
  let mut parser=LmuParser::new();
  let source=encode_lmu_source_payload(7,42,1000.,&telemetry,&scoring,None).unwrap();
  let first=parser.feed(&source,0).unwrap().unwrap();
  assert_eq!(parser.feed(&source,0).unwrap().unwrap(),first);
  assert_eq!(first["lmu"]["carId"],"911gt3r_2024");
  assert_eq!(first["lmu"]["trackId"],"bahrainwec_2023/bahrainwec");
  assert_eq!(first["lmu"]["sessionType"],"race");
  assert_eq!(first["IsRaceOn"],1);
  assert_eq!(first["Speed"],5.);
  assert_eq!(first["VelocityZ"],-4.);
  assert_eq!(first["CurrentEngineRpm"],6000.);
  assert_eq!(first["Accel"],128);
  assert_eq!(first["CurrentLap"],15.);
  assert_eq!(first["RainPercent"],75.);
  assert_eq!(first["WeatherType"],4.);
  assert!((first["TireSurfaceTempInnerFL"].as_f64().unwrap()-28.85).abs()<1e-9);
  assert!((first["TireSurfaceTempInnerFR"].as_f64().unwrap()-26.85).abs()<1e-9);
  assert_eq!(serde_json::from_str::<Value>(first["sessionUID"].as_str().unwrap()).unwrap(),
   serde_json::json!([7,42,10,"911gt3r_2024","bahrainwec_2023/bahrainwec"]));
  put_text(&mut telemetry,offsets::LMU_LMU_TELEMETRY_VEHICLE_MODEL,30,"992s_pc_2023");
  let source=encode_lmu_source_payload(7,42,1000.,&telemetry,&scoring,None).unwrap();
  let changed=parser.feed(&source,0).unwrap().unwrap();
  assert_eq!(changed["lmu"]["carId"],"992s_pc_2023");
  assert_ne!(changed["sessionUID"],first["sessionUID"]);
  for key in ["Speed","Power","CurrentEngineRpm","Accel","CurrentLap","RainPercent","TireTempFL"]{
   assert_eq!(changed[key],first[key],"{key}");
  }
 }
}
