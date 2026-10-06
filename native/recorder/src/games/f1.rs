use serde_json::{json, Map, Number, Value};
use crate::games::generated::layouts::*;
use crate::detection::{ordinal::F1Snapshot, policy::Sample};
use super::DetectionPacket;

const HEADER: usize = crate::games::generated::layouts::F1_F1_HEADER_SIZE as usize;
/// Stateful F1 2025 datagram accumulator. Context packets update caches but only
/// motion+telemetry+lap+session together can produce canonical telemetry.
pub struct Parser {
    uid: u64,
    player: usize,
    motion: Option<[f64; 12]>,
    telemetry: Option<Vec<f64>>,
    lap: Option<Vec<f64>>,
    lap_cars: Vec<[f64; 11]>,
    status_cars: Vec<[f64; 3]>,
    session: Option<Vec<f64>>,
    status: Option<Vec<f64>>,
    damage: Option<Vec<f64>>,
    setup: Option<Vec<f64>>,
    motion_ex: Option<Vec<f64>>,
    participants: Vec<Value>,
    classification: Option<Vec<f64>>,
    history_by_car: Vec<Value>,
}
impl Parser {
    pub fn new() -> Self { Self { uid: 0, player: 0, motion: None, telemetry: None, lap: None, lap_cars:Vec::new(), status_cars:Vec::new(), session: None, status: None, damage: None, setup: None, motion_ex: None, participants: Vec::new(), classification: None, history_by_car: Vec::new() } }
    pub fn reset(&mut self) { *self=Self::new(); }
    pub fn feed(&mut self, b: &[u8]) -> Result<Option<Value>, String> {
        self.feed_mode(b, true).map(|packet|packet.map(|packet|match packet {
            DetectionPacket::Full(value)=>value,
            _=>unreachable!("full F1 parser mode"),
        }))
    }
    pub fn feed_for_detection(&mut self, b: &[u8]) -> Result<Option<DetectionPacket<'static>>, String> {
        self.feed_mode(b, false)
    }
    fn feed_mode(&mut self, b: &[u8], full: bool) -> Result<Option<DetectionPacket<'static>>, String> {
        if b.len() < HEADER { return Err(format!("short F1 packet header: {} bytes", b.len())); }
        let format = u16le(b, 0)?; let id = b[6] as usize;
        if format != 2025 { return Err(format!("unexpected F1 packet format {format}")); }
        let uid = u64le(b, 7)?; let player = b[27] as usize;
        if uid != self.uid { self.reset(); self.uid = uid; }
        self.player = player;
        let d = &b[HEADER..];
        let incomplete = match id {
            F1_F1_PACKET_IDS_MOTION => d.len() < (player + 1) * F1_DECODERS_MOTION_SIZE,
            F1_F1_PACKET_IDS_SESSION => d.len() < 8,
            F1_F1_PACKET_IDS_LAP_DATA => d.len() < (player + 1) * F1_DECODERS_LAP_DATA_SIZE,
            F1_F1_PACKET_IDS_PARTICIPANTS => false,
            F1_F1_PACKET_IDS_CAR_SETUP => d.len() < (player + 1) * F1_DECODERS_CAR_SETUP_SIZE,
            F1_F1_PACKET_IDS_CAR_TELEMETRY => d.len() < (player + 1) * F1_DECODERS_CAR_TELEMETRY_SIZE,
            F1_F1_PACKET_IDS_CAR_STATUS => d.len() < (player + 1) * F1_DECODERS_CAR_STATUS_SIZE,
            F1_F1_PACKET_IDS_FINAL_CLASSIFICATION => d.is_empty() || player >= d[0] as usize || d.len() < 1 + (player + 1) * F1_DECODERS_FINAL_CLASSIFICATION_SIZE,
            F1_F1_PACKET_IDS_CAR_DAMAGE => d.len() < (player + 1) * F1_DECODERS_CAR_DAMAGE_SIZE,
            F1_F1_PACKET_IDS_SESSION_HISTORY => d.len() < 7,
            F1_F1_PACKET_IDS_MOTION_EX => false,
            _ => false,
        };
        if incomplete { return Ok(None); }
        match id {
            F1_F1_PACKET_IDS_MOTION => { self.motion=Some(floats(d,player*F1_DECODERS_MOTION_SIZE,&[F1_DECODERS_MOTION_POS_X,F1_DECODERS_MOTION_POS_Y,F1_DECODERS_MOTION_POS_Z,F1_DECODERS_MOTION_VEL_X,F1_DECODERS_MOTION_VEL_Y,F1_DECODERS_MOTION_VEL_Z,F1_DECODERS_MOTION_G_FORCE_X,F1_DECODERS_MOTION_G_FORCE_Y,F1_DECODERS_MOTION_G_FORCE_Z,F1_DECODERS_MOTION_YAW,F1_DECODERS_MOTION_PITCH,F1_DECODERS_MOTION_ROLL])?); }
            F1_F1_PACKET_IDS_SESSION => { let g=|o:usize| d.get(o).copied().unwrap_or(0) as f64; if d.len()<8{return Ok(None)} self.session=Some(vec![g(F1_DECODERS_SESSION_WEATHER),i8v(d,F1_DECODERS_SESSION_TRACK_TEMP)? as f64,i8v(d,F1_DECODERS_SESSION_AIR_TEMP)? as f64,g(F1_DECODERS_SESSION_TOTAL_LAPS),u16le(d,F1_DECODERS_SESSION_TRACK_LENGTH)? as f64,g(F1_DECODERS_SESSION_SESSION_TYPE),i8v(d,F1_DECODERS_SESSION_TRACK_ID)? as f64,g(F1_DECODERS_SESSION_FORMULA),g(13),g(124),if d.len()>=135&&d[126]>0{g(134)}else{0.},g(645),g(646)]); }
            F1_F1_PACKET_IDS_LAP_DATA => { let mut cars=Vec::with_capacity(22);for i in 0..22 {let o=i*57;if d.len()<o+57{break} cars.push([u32le(d,o)? as f64/1000.,u32le(d,o+4)? as f64/1000.,0.,u8v(d,o+32)? as f64,f32le(d,o+24)? as f64,f32le(d,o+20)? as f64,u8v(d,o+36)? as f64,(u8v(d,o+10)? as f64*60.+u16le(d,o+8)? as f64)/1000.,(u8v(d,o+13)? as f64*60.+u16le(d,o+11)? as f64)/1000.,u8v(d,o+34)? as f64,u8v(d,o+35)? as f64]);}let o=player*57;if d.len()<o+57{return Ok(None)}self.lap_cars=cars;self.lap=Some(vec![u32le(d,o)? as f64/1000.,u32le(d,o+4)? as f64/1000.,u8v(d,o+33)? as f64,u8v(d,o+32)? as f64,f32le(d,o+24)? as f64,f32le(d,o+20)? as f64,u8v(d,o+36)? as f64,(u8v(d,o+10)? as f64*60.+u16le(d,o+8)? as f64)/1000.,(u8v(d,o+13)? as f64*60.+u16le(d,o+11)? as f64)/1000.,u8v(d,o+37)? as f64,u8v(d,o+38)? as f64,u8v(d,o+39)? as f64,u8v(d,o+40)? as f64,u8v(d,o+45)? as f64,u8v(d,o+44)? as f64,u8v(d,o+46)? as f64,u16le(d,o+47)? as f64,f32le(d,o+52)? as f64,u8v(d,o+43)? as f64]); }
            F1_F1_PACKET_IDS_PARTICIPANTS => { let n=*d.first().ok_or_else(||"short F1 participants packet".to_string())? as usize; self.participants.clear(); for i in 0..n {let o=1+i*F1_DECODERS_PARTICIPANTS_SIZE;if d.len()<o+F1_DECODERS_PARTICIPANTS_SIZE {break} let name=&d[o+7..o+39];let end=name.iter().position(|x|*x==0).unwrap_or(32);self.participants.push(json!({"driverId":d[o+F1_DECODERS_PARTICIPANTS_DRIVER_ID],"teamId":d[o+F1_DECODERS_PARTICIPANTS_TEAM_ID],"name":String::from_utf8_lossy(&name[..end]).to_string()}));} }
            F1_F1_PACKET_IDS_CAR_SETUP => {let o=player*F1_DECODERS_CAR_SETUP_SIZE;let mut v=vec![0.;F1_DECODERS_CAR_SETUP_SIZE];for i in [F1_DECODERS_CAR_SETUP_FRONT_WING,F1_DECODERS_CAR_SETUP_REAR_WING,F1_DECODERS_CAR_SETUP_ON_THROTTLE,F1_DECODERS_CAR_SETUP_OFF_THROTTLE,F1_DECODERS_CAR_SETUP_FRONT_SUSPENSION,F1_DECODERS_CAR_SETUP_REAR_SUSPENSION,F1_DECODERS_CAR_SETUP_FRONT_ANTI_ROLL_BAR,F1_DECODERS_CAR_SETUP_REAR_ANTI_ROLL_BAR,F1_DECODERS_CAR_SETUP_FRONT_RIDE_HEIGHT,F1_DECODERS_CAR_SETUP_REAR_RIDE_HEIGHT,F1_DECODERS_CAR_SETUP_BRAKE_PRESSURE,F1_DECODERS_CAR_SETUP_BRAKE_BIAS,F1_DECODERS_CAR_SETUP_ENGINE_BRAKING]{v[i]=d[o+i]as f64}for i in [F1_DECODERS_CAR_SETUP_FRONT_CAMBER,F1_DECODERS_CAR_SETUP_REAR_CAMBER,F1_DECODERS_CAR_SETUP_FRONT_TOE,F1_DECODERS_CAR_SETUP_REAR_TOE,F1_DECODERS_CAR_SETUP_REAR_LEFT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_REAR_RIGHT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_FRONT_LEFT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_FRONT_RIGHT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_FUEL_LOAD]{v[i]=f32le(d,o+i)? as f64}self.setup=Some(v);}
            F1_F1_PACKET_IDS_CAR_TELEMETRY => {let o=player*F1_DECODERS_CAR_TELEMETRY_SIZE;self.telemetry=Some(vec![u16le(d,o+F1_DECODERS_CAR_TELEMETRY_SPEED)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_THROTTLE)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_STEER)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_BRAKE)? as f64,i8v(d,o+F1_DECODERS_CAR_TELEMETRY_GEAR)? as f64,u16le(d,o+F1_DECODERS_CAR_TELEMETRY_RPM)? as f64,(d[o+F1_DECODERS_CAR_TELEMETRY_DRS]==1) as u8 as f64,d[o+F1_DECODERS_CAR_TELEMETRY_CLUTCH] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRE_TEMP_FL] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRE_TEMP_FR] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRE_TEMP_RL] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRE_TEMP_RR] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRES_INNER_TEMP_FL] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRES_INNER_TEMP_FR] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRES_INNER_TEMP_RL] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_TYRES_INNER_TEMP_RR] as f64,u16le(d,o+F1_DECODERS_CAR_TELEMETRY_BRAKE_TEMP_FL)? as f64,u16le(d,o+F1_DECODERS_CAR_TELEMETRY_BRAKE_TEMP_FR)? as f64,u16le(d,o+F1_DECODERS_CAR_TELEMETRY_BRAKE_TEMP_RL)? as f64,u16le(d,o+F1_DECODERS_CAR_TELEMETRY_BRAKE_TEMP_RR)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_ENGINE_TEMPERATURE)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_TYRE_PRESSURE_FL)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_TYRE_PRESSURE_FR)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_TYRE_PRESSURE_RL)? as f64,f32le(d,o+F1_DECODERS_CAR_TELEMETRY_TYRE_PRESSURE_RR)? as f64,d[o+F1_DECODERS_CAR_TELEMETRY_SURFACE_TYPE_FL] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_SURFACE_TYPE_FR] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_SURFACE_TYPE_RL] as f64,d[o+F1_DECODERS_CAR_TELEMETRY_SURFACE_TYPE_RR] as f64]);}
            F1_F1_PACKET_IDS_CAR_STATUS => {let mut all=Vec::with_capacity(22);for i in 0..22{let o=i*F1_DECODERS_CAR_STATUS_SIZE;if d.len()<o+F1_DECODERS_CAR_STATUS_SIZE{break}all.push([d[o+F1_DECODERS_CAR_STATUS_TYRE_COMPOUND]as f64,d[o+F1_DECODERS_CAR_STATUS_TYRE_VISUAL_COMPOUND]as f64,d[o+F1_DECODERS_CAR_STATUS_TYRE_AGE]as f64]);}let o=player*F1_DECODERS_CAR_STATUS_SIZE;let v=vec![d[o+F1_DECODERS_CAR_STATUS_TRACTION_CONTROL]as f64,d[o+F1_DECODERS_CAR_STATUS_ANTI_LOCK_BRAKES]as f64,d[o+F1_DECODERS_CAR_STATUS_FUEL_MIX]as f64,d[o+F1_DECODERS_CAR_STATUS_FRONT_BRAKE_BIAS]as f64,d[o+F1_DECODERS_CAR_STATUS_PIT_LIMITER_STATUS]as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_FUEL_REMAINING)?as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_FUEL_CAPACITY)?as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_FUEL_REMAINING_LAPS)?as f64,u16le(d,o+F1_DECODERS_CAR_STATUS_MAX_RPM)?as f64,u16le(d,o+F1_DECODERS_CAR_STATUS_IDLE_RPM)?as f64,d[o+F1_DECODERS_CAR_STATUS_MAX_GEARS]as f64,(d[o+F1_DECODERS_CAR_STATUS_DRS_ALLOWED]==1)as u8 as f64,u16le(d,o+F1_DECODERS_CAR_STATUS_DRS_ACTIVATION_DISTANCE)?as f64,d[o+F1_DECODERS_CAR_STATUS_ACTUAL_TYRE_COMPOUND]as f64,d[o+F1_DECODERS_CAR_STATUS_TYRE_VISUAL_COMPOUND]as f64,d[o+F1_DECODERS_CAR_STATUS_TYRE_AGE]as f64,i8v(d,o+F1_DECODERS_CAR_STATUS_VEHICLE_FIAFLAGS)?as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_ENGINE_POWER_ICE)?as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_ENGINE_POWER_MGUK)?as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_ERS_STORE)?as f64,d[o+F1_DECODERS_CAR_STATUS_ERS_DEPLOY_MODE]as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_ERS_HARVESTED_THIS_LAP)?as f64,f32le(d,o+F1_DECODERS_CAR_STATUS_ERS_DEPLOYED_THIS_LAP)?as f64];self.status_cars=all;self.status=Some(v);}
            F1_F1_PACKET_IDS_FINAL_CLASSIFICATION => {if d.is_empty(){return Ok(None)}let count=d[0] as usize;let o=1+player*F1_DECODERS_FINAL_CLASSIFICATION_SIZE;if player>=count||d.len()<o+F1_DECODERS_FINAL_CLASSIFICATION_SIZE{return Ok(None)}self.classification=Some(vec![d[o+F1_DECODERS_FINAL_CLASSIFICATION_POSITION] as f64,d[o+F1_DECODERS_FINAL_CLASSIFICATION_GRID_POSITION] as f64,d[o+F1_DECODERS_FINAL_CLASSIFICATION_RESULT_STATUS] as f64,d[o+F1_DECODERS_FINAL_CLASSIFICATION_RESULT_REASON] as f64,u32le(d,o+F1_DECODERS_FINAL_CLASSIFICATION_BEST_LAP_TIME)? as f64/1000.]);}
            F1_F1_PACKET_IDS_CAR_DAMAGE => {let o=player*F1_DECODERS_CAR_DAMAGE_SIZE;let mut damage=vec![f32le(d,o+F1_DECODERS_CAR_DAMAGE_TYRE_WEAR_RL)? as f64,f32le(d,o+F1_DECODERS_CAR_DAMAGE_TYRE_WEAR_RR)? as f64,f32le(d,o+F1_DECODERS_CAR_DAMAGE_TYRE_WEAR_FL)? as f64,f32le(d,o+F1_DECODERS_CAR_DAMAGE_TYRE_WEAR_FR)? as f64];damage.resize(32,0.);for(i,offset)in[F1_DECODERS_CAR_DAMAGE_TYRES_DAMAGE_RL,F1_DECODERS_CAR_DAMAGE_TYRES_DAMAGE_RR,F1_DECODERS_CAR_DAMAGE_TYRES_DAMAGE_FL,F1_DECODERS_CAR_DAMAGE_TYRES_DAMAGE_FR,F1_DECODERS_CAR_DAMAGE_BRAKES_DAMAGE_RL,F1_DECODERS_CAR_DAMAGE_BRAKES_DAMAGE_RR,F1_DECODERS_CAR_DAMAGE_BRAKES_DAMAGE_FL,F1_DECODERS_CAR_DAMAGE_BRAKES_DAMAGE_FR,F1_DECODERS_CAR_DAMAGE_TYRE_BLISTERS_RL,F1_DECODERS_CAR_DAMAGE_TYRE_BLISTERS_RR,F1_DECODERS_CAR_DAMAGE_TYRE_BLISTERS_FL,F1_DECODERS_CAR_DAMAGE_TYRE_BLISTS_FR,F1_DECODERS_CAR_DAMAGE_FRONT_LEFT_WING_DAMAGE,F1_DECODERS_CAR_DAMAGE_FRONT_RIGHT_WING_DAMAGE,F1_DECODERS_CAR_DAMAGE_REAR_WING_DAMAGE,F1_DECODERS_CAR_DAMAGE_FLOOR_DAMAGE,F1_DECODERS_CAR_DAMAGE_DIFFUSER_DAMAGE,F1_DECODERS_CAR_DAMAGE_SIDEPOD_DAMAGE,F1_DECODERS_CAR_DAMAGE_DRS_FAULT,F1_DECODERS_CAR_DAMAGE_ERS_FAULT,F1_DECODERS_CAR_DAMAGE_GEAR_BOX_DAMAGE,F1_DECODERS_CAR_DAMAGE_ENGINE_DAMAGE,F1_DECODERS_CAR_DAMAGE_ENGINE_MGUHWEAR,F1_DECODERS_CAR_DAMAGE_ENGINE_ESWEAR,F1_DECODERS_CAR_DAMAGE_ENGINE_CEWEAR,F1_DECODERS_CAR_DAMAGE_ENGINE_ICEWEAR,F1_DECODERS_CAR_DAMAGE_ENGINE_MGUKWEAR,F1_DECODERS_CAR_DAMAGE_ENGINE_TCWEAR].into_iter().enumerate(){damage[4+i]=d[o+offset] as f64;}self.damage=Some(damage);}
            F1_F1_PACKET_IDS_SESSION_HISTORY => {if d.len()<7{return Ok(None)}let car=d[0] as usize;let count=d[1] as usize;let mut sectors=Map::with_capacity(count);let mut best_lap=0.0f64;let mut last=[0.0;3];let mut last_time=0.0;for i in 0..count{let o=7+i*14;if d.len()<o+14{break}let tm=u32le(d,o)? as f64/1000.;let a=(d[o+6]as f64*60.+u16le(d,o+4)?as f64)/1000.;let bb=(d[o+9]as f64*60.+u16le(d,o+7)?as f64)/1000.;let c=(d[o+12]as f64*60.+u16le(d,o+10)?as f64)/1000.;if tm>0.&&(best_lap==0.||tm<best_lap){best_lap=tm}sectors.insert((i+1).to_string(),json!({"lapTime":tm,"s1":a,"s2":bb,"s3":c}));if i+1==count{last=[a,bb,c];last_time=tm;}}
                let mut best=[0.0;3];for(j,lap,ms,min)in[(0,d[4],4,6),(1,d[5],7,9),(2,d[6],10,12)]{if lap>0&&lap as usize<=count{let o=7+(lap as usize-1)*F1_DECODERS_SESSION_HISTORY_SIZE;if d.len()>=o+F1_DECODERS_SESSION_HISTORY_SIZE{best[j]=(d[o+min]as f64*60.+u16le(d,o+ms)?as f64)/1000.;}}}
                let mut merged=self.history_by_car.get_mut(car).and_then(Value::as_object_mut).and_then(|entry|entry.remove("sectors")).and_then(|sectors|match sectors{Value::Object(map)=>Some(map),_=>None}).unwrap_or_default();for(k,v)in sectors{let score=|x:&Value|["s1","s2","s3","lapTime"].iter().filter(|k|x.get(**k).and_then(Value::as_f64).unwrap_or(0.)>0.).count();if merged.get(&k).map(|old|score(&v)>score(old)).unwrap_or(true){merged.insert(k,v);}}
                let best_time=if best_lap>0.&&last_time>0.{best_lap.min(last_time)}else{best_lap.max(last_time)};
                // History packets arrive per car; lower indices must not discard other cars.
                if self.history_by_car.len() <= car { self.history_by_car.resize(car+1,Value::Null); }
                self.history_by_car[car]=json!({"sectors":merged,"history":{"bestS1":best[0],"bestS2":best[1],"bestS3":best[2],"lastS1":last[0],"lastS2":last[1],"lastS3":last[2],"bestLapTime":best_time}});
            }
            F1_F1_PACKET_IDS_MOTION_EX => {let offsets=[F1_DECODERS_MOTION_EX_SUSPENSION_POSITION_RL,F1_DECODERS_MOTION_EX_SUSPENSION_POSITION_RR,F1_DECODERS_MOTION_EX_SUSPENSION_POSITION_FL,F1_DECODERS_MOTION_EX_SUSPENSION_POSITION_FR,F1_DECODERS_MOTION_EX_SUSPENSION_VELOCITY_RL,F1_DECODERS_MOTION_EX_SUSPENSION_VELOCITY_RR,F1_DECODERS_MOTION_EX_SUSPENSION_VELOCITY_FL,F1_DECODERS_MOTION_EX_SUSPENSION_VELOCITY_FR,F1_DECODERS_MOTION_EX_WHEEL_SPEED_RL,F1_DECODERS_MOTION_EX_WHEEL_SPEED_RR,F1_DECODERS_MOTION_EX_WHEEL_SPEED_FL,F1_DECODERS_MOTION_EX_WHEEL_SPEED_FR,F1_DECODERS_MOTION_EX_WHEEL_SLIP_RATIO_RL,F1_DECODERS_MOTION_EX_WHEEL_SLIP_RATIO_RR,F1_DECODERS_MOTION_EX_WHEEL_SLIP_RATIO_FL,F1_DECODERS_MOTION_EX_WHEEL_SLIP_RATIO_FR,F1_DECODERS_MOTION_EX_WHEEL_SLIP_ANGLE_RL,F1_DECODERS_MOTION_EX_WHEEL_SLIP_ANGLE_RR,F1_DECODERS_MOTION_EX_WHEEL_SLIP_ANGLE_FL,F1_DECODERS_MOTION_EX_WHEEL_SLIP_ANGLE_FR,F1_DECODERS_MOTION_EX_WHEEL_LAT_FORCE_RL,F1_DECODERS_MOTION_EX_WHEEL_LAT_FORCE_RR,F1_DECODERS_MOTION_EX_WHEEL_LAT_FORCE_FL,F1_DECODERS_MOTION_EX_WHEEL_LAT_FORCE_FR,F1_DECODERS_MOTION_EX_WHEEL_LONG_FORCE_RL,F1_DECODERS_MOTION_EX_WHEEL_LONG_FORCE_RR,F1_DECODERS_MOTION_EX_WHEEL_LONG_FORCE_FL,F1_DECODERS_MOTION_EX_WHEEL_LONG_FORCE_FR,F1_DECODERS_MOTION_EX_HEIGHT_OF_COGABOVE_GROUND,F1_DECODERS_MOTION_EX_LOCAL_VELOCITY_X,F1_DECODERS_MOTION_EX_LOCAL_VELOCITY_Y,F1_DECODERS_MOTION_EX_LOCAL_VELOCITY_Z,F1_DECODERS_MOTION_EX_ANGULAR_VELOCITY_X,F1_DECODERS_MOTION_EX_ANGULAR_VELOCITY_Y,F1_DECODERS_MOTION_EX_ANGULAR_VELOCITY_Z,F1_DECODERS_MOTION_EX_ANGULAR_ACCELERATION_X,F1_DECODERS_MOTION_EX_ANGULAR_ACCELERATION_Y,F1_DECODERS_MOTION_EX_ANGULAR_ACCELERATION_Z,F1_DECODERS_MOTION_EX_FRONT_WHEELS_ANGLE,F1_DECODERS_MOTION_EX_WHEEL_VERT_FORCE_RL,F1_DECODERS_MOTION_EX_WHEEL_VERT_FORCE_RR,F1_DECODERS_MOTION_EX_WHEEL_VERT_FORCE_FL,F1_DECODERS_MOTION_EX_WHEEL_VERT_FORCE_FR,F1_DECODERS_MOTION_EX_FRONT_AERO_HEIGHT,F1_DECODERS_MOTION_EX_REAR_AERO_HEIGHT,F1_DECODERS_MOTION_EX_FRONT_ROLL_ANGLE,F1_DECODERS_MOTION_EX_REAR_ROLL_ANGLE,F1_DECODERS_MOTION_EX_CHASSIS_YAW,F1_DECODERS_MOTION_EX_CHASSIS_PITCH];self.motion_ex=Some(offsets.iter().map(|o|f32le(d,*o).map(|v|v as f64)).collect::<Result<Vec<_>,_>>()?);}
            _ => return Ok(None),
        }
        if id == F1_F1_PACKET_IDS_CAR_TELEMETRY { if let Some(values)=self.telemetry.as_mut() { let o=self.player*F1_DECODERS_CAR_TELEMETRY_SIZE; values[20]=u16le(d,o+F1_DECODERS_CAR_TELEMETRY_ENGINE_TEMPERATURE)? as f64; values.push(if d.len() >= 22*F1_DECODERS_CAR_TELEMETRY_SIZE+1 { i8v(d,22*F1_DECODERS_CAR_TELEMETRY_SIZE)? as f64 } else { 0. }); } }
        if id == F1_F1_PACKET_IDS_CAR_STATUS { if let Some(values)=self.status.as_mut() { let o=self.player*F1_DECODERS_CAR_STATUS_SIZE; values[21]=f32le(d,o+F1_DECODERS_CAR_STATUS_ERS_HARVESTED_THIS_LAP)? as f64+f32le(d,o+46)? as f64; } }
        if full {
            self.snapshot(b).map(|packet|packet.map(DetectionPacket::Full))
        } else {
            self.detector_snapshot(b).map(|packet|packet.map(DetectionPacket::Ordinal))
        }
    }
    fn snapshot(&self, b: &[u8]) -> Result<Option<Value>, String> {
        let (Some(m), Some(t), Some(l), Some(s)) = (&self.motion, &self.telemetry, &self.lap, &self.session) else { return Ok(None); };
        Ok(Some(self.packet(b, m, t, l, s)?))
    }
    fn detector_snapshot(&self,b:&[u8])->Result<Option<F1Snapshot>,String> {
        let (Some(m),Some(_t),Some(l),Some(s))=(&self.motion,&self.telemetry,&self.lap,&self.session) else {return Ok(None);};
        // Presentation writes nonfinite floats as null; detector number(null)=0.
        let finite=|v:f64|if v.is_finite(){v}else{0.};
        Ok(Some(F1Snapshot {
            sample:Sample {
                lap_number:finite(l[2]),current_lap:finite(l[1]),last_lap:finite(l[0]),
                distance:finite(l[5]),position_x:finite(-m[0]),position_z:finite(m[2]),
                // Full JSON uses Number::from_f64 for pitLaneTimerActive;
                // the existing integer-only pit policy therefore observes None.
                ..Sample::default()
            },
            timestamp:finite((f32le(b,15)? as f64*1000.).round()),
            session_uid:self.uid,
            car_ordinal:self.participants.get(self.player).and_then(|p|p.get("teamId")).and_then(Value::as_f64).unwrap_or(0.),
            track_ordinal:finite(s[6]),session_type:session_type(s[5]),
        }))
    }
    fn packet(&self,b:&[u8],m:&[f64],t:&[f64],l:&[f64],s:&[f64])->Result<Value,String> {
        let mut f=Map::with_capacity(128); let status=self.status.as_deref(); let damage=self.damage.as_deref();let mx=self.motion_ex.as_deref();
        let get=|v:Option<&[f64]>,i:usize,default:f64|v.and_then(|x|x.get(i)).copied().unwrap_or(default);
        let put=|o:&mut Map<String,Value>,k:&str,v:f64| {o.insert(k.into(),number(v));};
        let compounds=[(16,"soft"),(17,"medium"),(18,"hard"),(7,"inter"),(8,"wet")];let compound=compounds.iter().find(|(n,_)|*n==get(status,14,0.) as i32).map(|x|x.1).unwrap_or("unknown");
        f.insert("drsAllowed".into(),json!(get(status,11,0.)==1.));f.insert("drsActivated".into(),json!(t[6]!=0.));f.insert("drsZoneApproaching".into(),json!(false));
        for (k,i) in [("ersStoreEnergy",19),("ersDeployMode",20),("ersDeployedThisLap",22),("ersHarvestedThisLap",21),("tyreVisualCompound",14),("tyreAge",15)] {put(&mut f,k,get(status,i,0.));}
        f.insert("tyreCompound".into(),json!(compound));for(k,v)in[("weather",s[0]),("trackTemperature",s[1]),("airTemperature",s[2]),("rainPercentage",s[10]),("totalLaps",s[3]),("currentSector",l[6]),("sector1Time",l[7]),("sector2Time",l[8])] {put(&mut f,k,v)}
        f.insert("sessionType".into(),json!(session_type(s[5])));
        let leader=self.lap_cars.iter().map(|c|c[4]).fold(0.0f64,f64::max);
        let speed_ms=(t[0]/3.6).max(1.0);
        let mut grid=Vec::with_capacity(self.lap_cars.len().min(self.participants.len()));
        for(i,c)in self.lap_cars.iter().enumerate(){
            let Some(part)=self.participants.get(i)else{continue};
            let cs=self.status_cars.get(i);
            let histcar=self.history_by_car.get(i).and_then(|h|h.get("history"));
            grid.push(json!({
                "position":c[3],"driverId":part["driverId"],"teamId":part["teamId"],"name":part["name"],
                "currentLapTime":c[1],"lastLapTime":c[0],
                "bestLapTime":histcar.and_then(|h|h.get("bestLapTime")).and_then(Value::as_f64).unwrap_or(c[2]),
                "gapToLeader":if c[3]==1. {0.} else {(leader-c[4])/speed_ms},
                "gapToCarAhead":0,"pitStatus":c[9],"numPitStops":c[10],
                "tyreCompound":match cs.map(|v|v[1] as i32).unwrap_or(0){16=>"soft",17=>"medium",18=>"hard",7=>"inter",8=>"wet",_=>"unknown"},
                "tyreAge":cs.map(|v|v[2]).unwrap_or(0.),"penalties":0,
                "bestS1":histcar.and_then(|h|h.get("bestS1")).and_then(Value::as_f64).unwrap_or(0.),
                "bestS2":histcar.and_then(|h|h.get("bestS2")).and_then(Value::as_f64).unwrap_or(0.),
                "bestS3":histcar.and_then(|h|h.get("bestS3")).and_then(Value::as_f64).unwrap_or(0.),
                "lastS1":histcar.and_then(|h|h.get("lastS1")).and_then(Value::as_f64).unwrap_or(0.),
                "lastS2":histcar.and_then(|h|h.get("lastS2")).and_then(Value::as_f64).unwrap_or(0.),
                "lastS3":histcar.and_then(|h|h.get("lastS3")).and_then(Value::as_f64).unwrap_or(0.)
            }));
        }
        grid.sort_by(|a,b|a["position"].as_f64().unwrap_or(0.).total_cmp(&b["position"].as_f64().unwrap_or(0.)));
        for i in 1..grid.len(){
            let prior=grid[i-1]["gapToLeader"].as_f64().unwrap_or(0.);
            let current=grid[i]["gapToLeader"].as_f64().unwrap_or(0.);
            grid[i]["gapToCarAhead"]=json!(current-prior);
        }
        f.insert("grid".into(),Value::Array(grid));
        let hist_entry=self.history_by_car.get(self.player);let hist=hist_entry.and_then(|v|v.get("history"));if let Some(sectors)=hist_entry.and_then(|v|v.get("sectors")){f.insert("lapSectors".into(),sectors.clone());}else{f.insert("lapSectors".into(),json!({}));}
        for(k,key)in[("lastS1","lastS1"),("lastS2","lastS2"),("lastS3","lastS3")] {put(&mut f,k,hist.and_then(|v|v.get(key)).and_then(Value::as_f64).unwrap_or(0.));}
        for(k,i)in[("brakeTempFL",16),("brakeTempFR",17),("brakeTempRL",18),("brakeTempRR",19),("tyrePressureFL",21),("tyrePressureFR",22),("tyrePressureRL",23),("tyrePressureRR",24),("engineTemperature",20),("surfaceTypeFL",25),("surfaceTypeFR",26),("surfaceTypeRL",27),("surfaceTypeRR",28),("tyresInnerTempFL",12),("tyresInnerTempFR",13),("tyresInnerTempRL",14),("tyresInnerTempRR",15),("suggestedGear",29)]{put(&mut f,k,get(Some(t),i,0.))}
        for(k,i)in[("currentLapInvalid",9),("penalties",10),("totalWarnings",11),("cornerCuttingWarnings",12),("resultStatus",13),("driverStatus",14),("pitLaneTimerActive",15),("pitLaneTimeInLaneInMS",16),("speedTrapFastestSpeed",17),("gridPosition",18)]{put(&mut f,k,get(Some(l),i,0.))}
        if let Some(c)=&self.classification {for(k,i)in[("resultStatus",2),("resultReason",3),("gridPosition",1)]{put(&mut f,k,c[i]);}}
        for(k,i)in[("tractionControl",0),("antiLockBrakes",1),("fuelMix",2),("frontBrakeBias",3),("pitLimiterStatus",4),("fuelRemainingLaps",7),("drsActivationDistance",12),("actualTyreCompound",13),("vehicleFIAFlags",16),("enginePowerICE",17),("enginePowerMGUK",18)]{if status.is_some(){put(&mut f,k,get(status,i,0.));}}
        if let Some(d)=damage {for(k,i)in[("tyresDamageFL",6),("tyresDamageFR",7),("tyresDamageRL",4),("tyresDamageRR",5),("brakesDamageFL",10),("brakesDamageFR",11),("brakesDamageRL",8),("brakesDamageRR",9),("tyreBlistersFL",14),("tyreBlistsFR",15),("tyreBlistersRL",12),("tyreBlistersRR",13),("frontLeftWingDamage",16),("frontRightWingDamage",17),("rearWingDamage",18),("floorDamage",19),("diffuserDamage",20),("sidepodDamage",21),("drsFault",22),("ersFault",23),("gearBoxDamage",24),("engineDamage",25),("engineMGUHWear",26),("engineESWear",27),("engineCEWear",28),("engineICEWear",29),("engineMGUKWear",30),("engineTCWear",31)]{put(&mut f,k,d[i]);}}
        f.insert("resultSource".into(),json!(if self.classification.is_some(){"final-classification"}else{"lap-data"}));
        for(k,i)in[("safetyCarStatus",9),("trackLength",4),("pitSpeedLimit",8),("formula",7),("pitStopWindowIdealLap",11),("pitStopWindowLatestLap",12)]{put(&mut f,k,get(Some(s),i,0.))}
        put(&mut f,"sector2LapDistanceStart",0.);put(&mut f,"sector3LapDistanceStart",0.);
        if let Some(set)=&self.setup {let keys=["frontWing","rearWing","onThrottle","offThrottle","frontCamber","rearCamber","frontToe","rearToe","frontSuspension","rearSuspension","frontAntiRollBar","rearAntiRollBar","frontRideHeight","rearRideHeight","brakePressure","brakeBias","engineBraking","rearLeftTyrePressure","rearRightTyrePressure","frontLeftTyrePressure","frontRightTyrePressure","fuelLoad"];let offsets=[F1_DECODERS_CAR_SETUP_FRONT_WING,F1_DECODERS_CAR_SETUP_REAR_WING,F1_DECODERS_CAR_SETUP_ON_THROTTLE,F1_DECODERS_CAR_SETUP_OFF_THROTTLE,F1_DECODERS_CAR_SETUP_FRONT_CAMBER,F1_DECODERS_CAR_SETUP_REAR_CAMBER,F1_DECODERS_CAR_SETUP_FRONT_TOE,F1_DECODERS_CAR_SETUP_REAR_TOE,F1_DECODERS_CAR_SETUP_FRONT_SUSPENSION,F1_DECODERS_CAR_SETUP_REAR_SUSPENSION,F1_DECODERS_CAR_SETUP_FRONT_ANTI_ROLL_BAR,F1_DECODERS_CAR_SETUP_REAR_ANTI_ROLL_BAR,F1_DECODERS_CAR_SETUP_FRONT_RIDE_HEIGHT,F1_DECODERS_CAR_SETUP_REAR_RIDE_HEIGHT,F1_DECODERS_CAR_SETUP_BRAKE_PRESSURE,F1_DECODERS_CAR_SETUP_BRAKE_BIAS,F1_DECODERS_CAR_SETUP_ENGINE_BRAKING,F1_DECODERS_CAR_SETUP_REAR_LEFT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_REAR_RIGHT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_FRONT_LEFT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_FRONT_RIGHT_TYRE_PRESSURE,F1_DECODERS_CAR_SETUP_FUEL_LOAD];let mut o=Map::new();for (i,k) in keys.iter().enumerate(){o.insert((*k).into(),number(set[offsets[i]]));}f.insert("setup".into(),Value::Object(o));}
        let speed=t[0];let mut p=Map::with_capacity(128);p.insert("gameId".into(),json!("f1-2025"));p.insert("sessionUID".into(),json!(u64le(b,7)?.to_string()));p.insert("IsRaceOn".into(),json!(1));p.insert("TimestampMS".into(),number((f32le(b,15)? as f64*1000.).round()));
        for(k,v)in[("EngineMaxRpm",get(status,8,15000.)),("EngineIdleRpm",get(status,9,4000.)),("CurrentEngineRpm",t[5]),("AccelerationX",-m[6]*9.81),("AccelerationY",m[7]*9.81),("AccelerationZ",m[8]*9.81),("VelocityX",-m[3]),("VelocityY",m[4]),("VelocityZ",m[5]),("Yaw",-m[9]),("Pitch",m[10]),("Roll",m[11]),("Speed",speed/3.6),("DistanceTraveled",l[5]),("BestLap",self.classification.as_ref().map(|c|c[4]).unwrap_or(0.)),("LastLap",l[0]),("CurrentLap",l[1]),("CurrentRaceTime",f32le(b,15).unwrap_or(0.) as f64),("Fuel",if get(status,6,0.)>0.{get(status,5,0.)/get(status,6,1.)}else{0.}),("CarOrdinal",self.participants.get(self.player).and_then(|x|x.get("teamId")).and_then(Value::as_f64).unwrap_or(0.)),("TrackOrdinal",s[6]),("Power",get(status,17,0.)+get(status,18,0.))] {put(&mut p,k,v)}
        if let Some(capacity)=status.and_then(|v|v.get(6)).copied().filter(|v|v.is_finite()&&*v>0.) { put(&mut p,"FuelCapacity",capacity); }
        for(k,v)in[("AngularVelocityX",get(mx,32,0.)),("AngularVelocityY",get(mx,33,0.)),("AngularVelocityZ",get(mx,34,0.)),("PositionX",-m[0]),("PositionY",m[1]),("PositionZ",m[2]),("TireTempFL",t[8]),("TireTempFR",t[9]),("TireTempRL",t[10]),("TireTempRR",t[11]),("TireCarcassTempFL",t[12]),("TireCarcassTempFR",t[13]),("TireCarcassTempRL",t[14]),("TireCarcassTempRR",t[15]),("TireWearFL",damage.map(|x|x[2]/100.).unwrap_or(-1.)),("TireWearFR",damage.map(|x|x[3]/100.).unwrap_or(-1.)),("TireWearRL",damage.map(|x|x[0]/100.).unwrap_or(-1.)),("TireWearRR",damage.map(|x|x[1]/100.).unwrap_or(-1.)),("LapNumber",l[2]),("RacePosition",self.classification.as_ref().map(|c|c[0]).unwrap_or(l[3])),("Accel",(t[1]*255.).round()),("Brake",(t[3]*255.).round()),("Clutch",(t[7]*2.55).round()),("Gear",t[4]+1.),("Steer",(t[2]*127.).round()),("DrsActive",if get(status,11,0.)==1.&&t[6]!=0.{1.}else{0.}),("ErsStoreEnergy",get(status,19,0.)),("ErsDeployMode",get(status,20,0.)),("ErsDeployed",get(status,22,0.)),("ErsHarvested",get(status,21,0.)),("WeatherType",s[0]),("TrackTemp",s[1]),("AirTemp",s[2]),("RainPercent",s[10]),("TyreCompound",get(status,14,0.)),("DrivetrainType",2.),("NumCylinders",6.),("HandBrake",0.)] {put(&mut p,k,v)}
        for k in ["NormSuspensionTravelFL","NormSuspensionTravelFR","NormSuspensionTravelRL","NormSuspensionTravelRR","WheelOnRumbleStripFL","WheelOnRumbleStripFR","WheelOnRumbleStripRL","WheelOnRumbleStripRR","WheelInPuddleDepthFL","WheelInPuddleDepthFR","WheelInPuddleDepthRL","WheelInPuddleDepthRR","SurfaceRumbleFL_2","SurfaceRumbleFR_2","SurfaceRumbleRL_2","SurfaceRumbleRR_2","TireSlipCombinedFL_2","SurfaceRumbleFL","SurfaceRumbleFR","SurfaceRumbleRL","SurfaceRumbleRR","Torque","Boost","NormDrivingLine","NormAIBrakeDiff","CarClass","CarPerformanceIndex"]{put(&mut p,k,0.)}
        let mxv=mx.unwrap_or(&[]);for(k,i)in[("TireSlipRatioFL",14),("TireSlipRatioFR",15),("TireSlipRatioRL",12),("TireSlipRatioRR",13),("TireSlipAngleFL",18),("TireSlipAngleFR",19),("TireSlipAngleRL",16),("TireSlipAngleRR",17),("WheelRotationSpeedFL",10),("WheelRotationSpeedFR",11),("WheelRotationSpeedRL",8),("WheelRotationSpeedRR",9)] {let fallback=if mx.is_none()&&k.starts_with("WheelRotationSpeed"){speed/3.6}else{0.};put(&mut p,k,mxv.get(i).copied().unwrap_or(fallback)/if k.starts_with("WheelRotationSpeed"){0.36}else{1.});}
        for (key,ratio,angle) in [("TireCombinedSlipFL",14,18),("TireCombinedSlipFR",15,19),("TireCombinedSlipRL",12,16),("TireCombinedSlipRR",13,17)]{put(&mut p,key,(mxv.get(ratio).copied().unwrap_or(0.).powi(2)+mxv.get(angle).copied().unwrap_or(0.).powi(2)).sqrt());}
        for (key,i) in [("SuspensionTravelMFL",2),("SuspensionTravelMFR",3),("SuspensionTravelMRL",0),("SuspensionTravelMRR",1)]{put(&mut p,key,mxv.get(i).copied().unwrap_or(0.)/1000.);}
        for (key,i) in [("BrakeTempFrontLeft",16),("BrakeTempFrontRight",17),("BrakeTempRearLeft",18),("BrakeTempRearRight",19),("TirePressureFrontLeft",21),("TirePressureFrontRight",22),("TirePressureRearLeft",23),("TirePressureRearRight",24)]{put(&mut p,key,t[i]);}
        for(k,i)in[("frontLeftWingDamage",16),("frontRightWingDamage",17),("rearWingDamage",18),("floorDamage",19),("diffuserDamage",20),("sidepodDamage",21)] {put(&mut f,k,damage.and_then(|d|d.get(i)).copied().unwrap_or(0.));}
        if let Some(mx)=mx {let names=["wheelSlipAngleFL","wheelSlipAngleFR","wheelSlipAngleRL","wheelSlipAngleRR","wheelLatForceFL","wheelLatForceFR","wheelLatForceRL","wheelLatForceRR","wheelLongForceFL","wheelLongForceFR","wheelLongForceRL","wheelLongForceRR","wheelVertForceFL","wheelVertForceFR","wheelVertForceRL","wheelVertForceRR","frontWheelsAngle","frontAeroHeight","rearAeroHeight","frontRollAngle","rearRollAngle","chassisYaw","chassisPitch","heightOfCOGAboveGround"];let ids=[18,19,16,17,22,23,20,21,26,27,24,25,41,42,39,40,38,43,44,45,46,47,48,28];let mut ex=Map::with_capacity(24);for(i,k)in names.iter().enumerate(){ex.insert((*k).into(),number(mx.get(ids[i]).copied().unwrap_or(0.)));}f.insert("motionEx".into(),Value::Object(ex));}
        p.insert("f1".into(),Value::Object(f));Ok(Value::Object(p))
    }
}
fn session_type(value:f64)->&'static str {
    const TYPES:[&str;14]=["unknown","practice-1","practice-2","practice-3","short-practice","qualifying-1","qualifying-2","qualifying-3","short-qualifying","one-shot-qualifying","race","race-2","race-3","time-trial"];
    TYPES.get(value as usize).copied().unwrap_or("unknown")
}
fn number(v:f64)->Value{Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)}
fn floats<const N:usize>(b:&[u8],o:usize,offs:&[usize;N])->Result<[f64;N],String>{let mut values=[0.;N];for(i,offset)in offs.iter().enumerate(){values[i]=f32le(b,o+*offset)? as f64;}Ok(values)}
fn u8v(b:&[u8],o:usize)->Result<u8,String>{b.get(o).copied().ok_or_else(||format!("F1 offset {o} out of bounds"))}
fn i8v(b:&[u8],o:usize)->Result<i8,String>{Ok(u8v(b,o)? as i8)}
fn u16le(b:&[u8],o:usize)->Result<u16,String>{Ok(u16::from_le_bytes(b.get(o..o+2).ok_or_else(||format!("F1 offset {o} out of bounds"))?.try_into().map_err(|_|"bad u16")?))}
fn u32le(b:&[u8],o:usize)->Result<u32,String>{Ok(u32::from_le_bytes(b.get(o..o+4).ok_or_else(||format!("F1 offset {o} out of bounds"))?.try_into().map_err(|_|"bad u32")?))}
fn u64le(b:&[u8],o:usize)->Result<u64,String>{Ok(u64::from_le_bytes(b.get(o..o+8).ok_or_else(||format!("F1 offset {o} out of bounds"))?.try_into().map_err(|_|"bad u64")?))}
fn f32le(b:&[u8],o:usize)->Result<f32,String>{Ok(f32::from_bits(u32le(b,o)?))}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{detection::Detector, formats::{RecordKind,SourceRecord}, games::GameParser};

    fn compare_packet(full:&Value,typed:&DetectionPacket<'_>,offset:u64) {
        let DetectionPacket::Ordinal(snapshot)=typed else {panic!("F1 import must use typed ordinal packets");};
        let mut sample=snapshot.sample;sample.offset=offset;
        assert_eq!(sample,Sample::from_value(full,offset));
        assert_eq!(snapshot.timestamp,crate::detection::policy::number(full,"TimestampMS"));
        assert_eq!(snapshot.car_ordinal,crate::detection::policy::number(full,"CarOrdinal"));
        assert_eq!(snapshot.track_ordinal,crate::detection::policy::number(full,"TrackOrdinal"));
        assert_eq!(snapshot.session_uid.to_string(),full["sessionUID"].as_str().unwrap());
        assert_eq!(snapshot.session_type,full["f1"]["sessionType"].as_str().unwrap());
    }

    fn compare_records(records:impl IntoIterator<Item=SourceRecord>)->u64 {
        let mut full_parser=GameParser::new("f1-2025").unwrap();
        let mut typed_parser=GameParser::new("f1-2025").unwrap();
        let mut full_detector=Detector::new("f1-2025").unwrap();
        let mut typed_detector=Detector::new("f1-2025").unwrap();
        let mut accepted=0;
        for record in records {
            if record.kind==RecordKind::Segment {
                full_parser.reset();typed_parser.reset();
                assert_eq!(full_detector.finish("segment-boundary").unwrap(),typed_detector.finish("segment-boundary").unwrap());
                full_detector.reset();typed_detector.reset();
                continue;
            }
            let time=record.time_ms.unwrap_or(0);
            let full=full_parser.feed(&record.payload,time).unwrap();
            let typed=typed_parser.feed_for_detection(&record.payload,time).unwrap();
            assert_eq!(full.is_some(),typed.is_some(),"accepted cadence at {}",record.offset);
            if let (Some(full),Some(typed))=(full,typed) {
                compare_packet(&full,&typed,record.offset);
                if record.kind==RecordKind::Frame {
                    accepted+=1;
                    assert_eq!(full_detector.feed(full,record.offset).unwrap(),typed_detector.feed_for_detection(typed,record.offset).unwrap(),"events/identity/recipe at {}",record.offset);
                }
            }
        }
        assert_eq!(full_detector.finish("import-eof").unwrap(),typed_detector.finish("import-eof").unwrap());
        accepted
    }

    fn packet(id:usize,size:usize,uid:u64,time:f32)->Vec<u8> {
        let mut b=vec![0;HEADER+size];
        b[..2].copy_from_slice(&2025u16.to_le_bytes());b[6]=id as u8;
        b[7..15].copy_from_slice(&uid.to_le_bytes());b[15..19].copy_from_slice(&time.to_le_bytes());
        b
    }

    #[test]
    fn typed_projection_matches_full_context_cadence_and_events() {
        let mut records=Vec::new();
        let mut push=|payload:Vec<u8>,kind| {
            let offset=12+records.len() as u64*1000;
            records.push(SourceRecord {offset,time_ms:Some(offset),kind,payload});
        };
        for (id,size) in [(F1_F1_PACKET_IDS_MOTION,F1_DECODERS_MOTION_SIZE),(F1_F1_PACKET_IDS_SESSION,8),(F1_F1_PACKET_IDS_LAP_DATA,F1_DECODERS_LAP_DATA_SIZE),(F1_F1_PACKET_IDS_CAR_TELEMETRY,F1_DECODERS_CAR_TELEMETRY_SIZE)] {
            push(packet(id,size,9,0.),RecordKind::Context);
        }
        // Unknown and incomplete datagrams must not create additional samples.
        push(packet(255,0,9,0.),RecordKind::Frame);
        push(packet(F1_F1_PACKET_IDS_MOTION,0,9,0.),RecordKind::Frame);
        for index in 0..81 {
            let mut b=packet(F1_F1_PACKET_IDS_LAP_DATA,F1_DECODERS_LAP_DATA_SIZE,9,index as f32*0.3);
            let d=&mut b[HEADER..];
            d[..4].copy_from_slice(&(if index>=40 {12_000u32}else{0u32}).to_le_bytes());
            d[4..8].copy_from_slice(&((index%40) as u32*300).to_le_bytes());
            d[20..24].copy_from_slice(&(index as f32*10.).to_le_bytes());
            d[33]=(index/40+1) as u8;d[46]=1;
            push(b,RecordKind::Frame);
        }
        assert_eq!(compare_records(records),81);
    }

    #[test]
    fn typed_projection_preserves_nonfinite_json_number_semantics() {
        let mut parser=Parser::new();
        parser.uid=7;parser.motion=Some([f64::NAN;12]);
        parser.telemetry=Some(vec![0.;30]);parser.lap=Some(vec![f64::INFINITY;19]);
        parser.session=Some(vec![0.;13]);
        let b=packet(0,0,7,f32::NAN);
        let full=parser.snapshot(&b).unwrap().unwrap();
        let typed=DetectionPacket::Ordinal(parser.detector_snapshot(&b).unwrap().unwrap());
        compare_packet(&full,&typed,99);
    }

    #[test]
    #[ignore = "complete canonical fixture equivalence; run explicitly in release mode"]
    fn canonical_f1_fixture_typed_full_equivalence() {
        use std::io::Read;
        let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
        let file=std::fs::File::open(path).expect("canonical F1 fixture");
        let mut bytes=Vec::new();
        flate2::read::MultiGzDecoder::new(file).read_to_end(&mut bytes).unwrap();
        let records=crate::formats::read_capture_bytes(&bytes).unwrap();
        assert_eq!(compare_records(records),184_333);
    }
}
