use serde_json::{Map, Number, Value};

use crate::detection::kunos::{IdentityField, KunosSnapshot};
use crate::detection::policy::Sample;

const ACC_MAGIC: u32 = 0x5043_4341;
const EVO_MAGIC: u32 = 0x5045_4341;

pub struct Parser {
    game_id: String,
    evo_distance: EvoDistance,
    evo_slot: PlayerSlot,
    last_car: String,
    last_track: String,
    car_ordinal: i64,
    track_ordinal: i64,
    acc_car_raw: Option<[u8; 66]>,
    acc_track_raw: Option<[u8; 66]>,
    evo_car_raw: Option<[u8; 33]>,
    evo_track_raw: Option<[u8; 33]>,
    evo_config_raw: Option<[u8; 33]>,
    acc_car_ordinal: Option<i64>,
    acc_track_ordinal: Option<i64>,
    last_static: Vec<u8>,
}

struct PlayerSlot { slot: Option<usize>, observations: u8, scores: [f64; 60], previous: [f32; 180] }
impl Default for PlayerSlot { fn default()->Self{Self{slot:None,observations:0,scores:[0.0;60],previous:[0.0;180]}} }
struct EvoDistance { packet: Option<i32>, speed: f64, previous_km: f64, anchor: f64, integral: f64, calibration_integral: f64, calibration_true: f64, seconds_per_step: f64, output: f64 }
impl Default for EvoDistance { fn default()->Self{Self{packet:None,speed:0.0,previous_km:-1.0,anchor:0.0,integral:0.0,calibration_integral:0.0,calibration_true:0.0,seconds_per_step:0.0,output:0.0}}}

impl Parser {
    pub fn new(game_id: &str) -> Result<Self, String> {
        if !matches!(game_id, "acc" | "ac-evo") { return Err(format!("unsupported Kunos game id: {game_id}")); }
        Ok(Self {
            game_id: game_id.into(), evo_distance: EvoDistance::default(), evo_slot: PlayerSlot::default(),
            last_car: String::new(), last_track: String::new(), car_ordinal: -1, track_ordinal: -1,
            acc_car_raw: None, acc_track_raw: None, evo_car_raw: None, evo_track_raw: None, evo_config_raw: None,
            acc_car_ordinal: None, acc_track_ordinal: None, last_static: Vec::new(),
        })
    }
    pub fn reset(&mut self) {
        self.evo_distance = EvoDistance::default(); self.evo_slot = PlayerSlot::default();
        self.last_car.clear(); self.last_track.clear(); self.car_ordinal = -1; self.track_ordinal = -1;
        self.acc_car_raw = None; self.acc_track_raw = None; self.evo_car_raw = None;
        self.evo_track_raw = None; self.evo_config_raw = None;
        self.acc_car_ordinal = None; self.acc_track_ordinal = None; self.last_static.clear();
    }
    pub fn feed(&mut self, frame: &[u8], time_ms: u64) -> Result<Option<Value>, String> {
        Ok(self.feed_for_detection(frame, time_ms)?.map(|input| input.materialize()))
    }

    pub fn feed_for_detection<'a>(
        &'a mut self, frame: &'a [u8], time_ms: u64,
    ) -> Result<Option<DetectionInput<'a>>, String> {
        use crate::games::generated::layouts as l;
        let Some(magic) = u32le(frame, 0) else { return Ok(None) };
        let is_acc = self.game_id == "acc";
        if magic != (if is_acc { ACC_MAGIC } else { EVO_MAGIC }) || frame.len() < 24 { return Ok(None); }
        let car = i32le(frame, 4).unwrap() as i64;
        let track = i32le(frame, 8).unwrap() as i64;
        let Some((p, after_phys)) = part(frame, 12) else { return Ok(None) };
        let Some((g, after_graphics)) = part(frame, after_phys) else { return Ok(None) };
        let Some((stat, _)) = part(frame, after_graphics) else { return Ok(None) };
        if is_acc {
            if p.len() < l::ACC_PHYSICS_SIZE || g.len() < l::ACC_GRAPHICS_MIN_SIZE || stat.len() < l::ACC_STATIC_SIZE {
                return Ok(None);
            }
            if changed_name(&mut self.acc_car_raw, stat, l::ACC_STATIC_CAR_MODEL) {
                self.acc_car_ordinal = crate::games::catalog::resolve_acc_car_id(&wide(stat, l::ACC_STATIC_CAR_MODEL, 66));
            }
            if changed_name(&mut self.acc_track_raw, stat, l::ACC_STATIC_TRACK) {
                self.acc_track_ordinal = crate::games::catalog::resolve_acc_track_id(&wide(stat, l::ACC_STATIC_TRACK, 66));
            }
            self.car_ordinal = self.acc_car_ordinal.unwrap_or(car);
            self.track_ordinal = self.acc_track_ordinal.unwrap_or(track);
            let slot = player_acc(g);
            let coordinates = l::ACC_GRAPHICS_CAR_COORDINATES_BASE + slot * 12;
            let sample = Sample {
                lap_number: (read_i(g, l::ACC_GRAPHICS_COMPLETED_LAPS) + 1) as f64,
                current_lap: valid_ms(read_i(g, l::ACC_GRAPHICS_I_CURRENT_TIME)),
                last_lap: valid_ms(read_i(g, l::ACC_GRAPHICS_I_LAST_TIME)),
                distance: finite_number(rf(g, l::ACC_GRAPHICS_DISTANCE_TRAVELED) as f64),
                position_x: finite_number(rf(g, coordinates) as f64),
                position_z: finite_number(rf(g, coordinates + 8) as f64),
                is_acc: true,
                pit_state: Some(read_i(g, l::ACC_GRAPHICS_IS_IN_PIT) != 0 || read_i(g, l::ACC_GRAPHICS_IS_IN_PIT_LANE) != 0),
                acc_valid: if g.len() >= l::ACC_GRAPHICS_IS_VALID_LAP + 4 {
                    match read_i(g, l::ACC_GRAPHICS_IS_VALID_LAP) { 1 => Some(true), 0 => Some(false), _ => None }
                } else { None },
                ..Sample::default()
            };
            let snapshot = KunosSnapshot {
                sample, car_ordinal: self.car_ordinal as f64, track_ordinal: self.track_ordinal as f64,
                car_pi: IdentityField::Number(0.0), session_uid: IdentityField::Null,
                session_type: IdentityField::Text(acc_session_type(read_i(g, l::ACC_GRAPHICS_SESSION))),
            };
            return Ok(Some(DetectionInput {
                snapshot, physics: p, graphics: g, statics: stat, time_ms,
                car: self.car_ordinal, track: self.track_ordinal, slot, distance: sample.distance,
                car_model: "", is_acc: true,
            }));
        }

        // Only changed static records enter retained storage. Omitted static
        // records borrow that storage; no temporary vector or parser clone.
        let s = if stat.len() >= l::EVO_STATIC_EVO_SIZE {
            if self.last_static.as_slice() != stat {
                self.last_static.clear();
                self.last_static.extend_from_slice(stat);
            }
            stat
        } else if stat.is_empty() && !self.last_static.is_empty() {
            self.last_static.as_slice()
        } else { return Ok(None) };
        if p.len() < l::EVO_PHYSICS_SIZE || g.len() < l::EVO_GRAPHICS_EVO_SIZE { return Ok(None); }
        let status = read_i(g, l::EVO_GRAPHICS_EVO_STATUS);
        if status == 0 || status == 1 { return Ok(None); }
        if changed_name(&mut self.evo_car_raw, g, l::EVO_GRAPHICS_EVO_CAR_MODEL) {
            let model = cstr(g, l::EVO_GRAPHICS_EVO_CAR_MODEL, 33);
            if !model.is_empty() && model != self.last_car {
                self.car_ordinal = crate::games::catalog::resolve_evo_car(&model)
                    .and_then(|value| value.get("id").and_then(Value::as_i64)).unwrap_or(-1);
                self.last_car = model;
            }
        }
        let track_changed = changed_name(&mut self.evo_track_raw, s, l::EVO_STATIC_EVO_TRACK);
        let config_changed = changed_name(&mut self.evo_config_raw, s, l::EVO_STATIC_EVO_TRACK_CONFIGURATION);
        if track_changed || config_changed {
            let track_name = cstr(s, l::EVO_STATIC_EVO_TRACK, 33);
            let config = cstr(s, l::EVO_STATIC_EVO_TRACK_CONFIGURATION, 33);
            let key = format!("{track_name}|{config}");
            if !track_name.is_empty() && key != self.last_track {
                self.track_ordinal = crate::games::catalog::resolve_evo_track(&track_name, &config)
                    .and_then(|value| value.get("id").and_then(Value::as_i64)).unwrap_or(-1);
                self.last_track = key;
            }
        }
        let slot = player_slot(&mut self.evo_slot, p, g, read_u8(g, l::EVO_GRAPHICS_EVO_ACTIVE_CARS) as usize);
        let speed = rf(p, l::EVO_PHYSICS_SPEED_KMH) as f64 / 3.6;
        let laps = read_i(g, l::EVO_GRAPHICS_EVO_TOTAL_LAP_COUNT);
        let distance = integrate(&mut self.evo_distance, read_i(p, l::EVO_PHYSICS_PACKET_ID),
            speed, rf(g, l::EVO_GRAPHICS_EVO_CURRENT_KM) as f64, laps);
        let pit_box = read_u8(g, l::EVO_GRAPHICS_EVO_IS_IN_PIT_BOX) != 0;
        let pit_lane = read_u8(g, l::EVO_GRAPHICS_EVO_IS_IN_PIT_LANE) != 0;
        let location = read_i(g, l::EVO_GRAPHICS_EVO_CAR_LOCATION);
        let coordinates = l::EVO_GRAPHICS_EVO_CAR_COORDINATES_BASE + slot * 12;
        let sample = Sample {
            lap_number: (laps + 1) as f64,
            current_lap: valid_ms(read_i(g, l::EVO_GRAPHICS_EVO_CURRENT_LAP_TIME_MS)),
            last_lap: valid_ms(read_i(g, l::EVO_GRAPHICS_EVO_LAST_LAPTIME_MS)),
            distance: finite_number(distance),
            position_x: finite_number(rf(g, coordinates) as f64),
            position_z: finite_number(rf(g, coordinates + 8) as f64),
            pit_state: Some(pit_box || pit_lane || location == 0 || location == 1),
            acc_valid: if read_u8(g, l::EVO_GRAPHICS_EVO_IS_VALID_LAP) != 0 { Some(true) }
                else if pit_lane || pit_box { None } else { Some(false) },
            ..Sample::default()
        };
        Ok(Some(DetectionInput {
            snapshot: KunosSnapshot {
                sample, car_ordinal: self.car_ordinal as f64, track_ordinal: self.track_ordinal as f64,
                car_pi: IdentityField::Number(0.0), session_uid: IdentityField::Null, session_type: IdentityField::Null,
            },
            physics: p, graphics: g, statics: s, time_ms, car: self.car_ordinal, track: self.track_ordinal,
            slot, distance, car_model: &self.last_car, is_acc: false,
        }))
    }
}

/// Borrowed packet bytes plus stateful computations already performed exactly
/// once. Presentation is needed only by live callers and lap append boundaries.
pub struct DetectionInput<'a> {
    pub snapshot: KunosSnapshot<'a>,
    physics: &'a [u8],
    graphics: &'a [u8],
    statics: &'a [u8],
    time_ms: u64,
    car: i64,
    track: i64,
    slot: usize,
    distance: f64,
    car_model: &'a str,
    is_acc: bool,
}

impl DetectionInput<'_> {
    pub fn materialize(&self) -> Value {
        if self.is_acc { self.acc() } else { self.evo() }
    }

    fn acc(&self) -> Value {
        use crate::games::generated::layouts as l;
        let (p, g, s) = (self.physics, self.graphics, self.statics);
        let (t, car, track) = (self.time_ms, self.car, self.track);
        let mut m=Map::with_capacity(128);
        base(&mut m,"acc",t,car,track,read_i(g,l::ACC_GRAPHICS_COMPLETED_LAPS)+1, read_i(g,l::ACC_GRAPHICS_STATUS)==2);
        let current=valid_ms(read_i(g,l::ACC_GRAPHICS_I_CURRENT_TIME)); let last=valid_ms(read_i(g,l::ACC_GRAPHICS_I_LAST_TIME)); let best=valid_ms(read_i(g,l::ACC_GRAPHICS_I_BEST_TIME));
        set(&mut m,"CurrentLap",current);set(&mut m,"CurrentRaceTime",current);set(&mut m,"LastLap",last);set(&mut m,"BestLap",best);
        set(&mut m,"Fuel",rf(p,l::ACC_PHYSICS_FUEL));set(&mut m,"DistanceTraveled",rf(g,l::ACC_GRAPHICS_DISTANCE_TRAVELED));set(&mut m,"RacePosition",read_i(g,l::ACC_GRAPHICS_POSITION));
        let coordinates=l::ACC_GRAPHICS_CAR_COORDINATES_BASE+self.slot*12;
        set(&mut m,"PositionX",rf(g,coordinates));set(&mut m,"PositionY",rf(g,coordinates+4));set(&mut m,"PositionZ",rf(g,coordinates+8));
        set(&mut m,"Yaw",rf(p,l::ACC_PHYSICS_HEADING));set(&mut m,"Speed",(rf(p,l::ACC_PHYSICS_SPEED_KMH) as f64)/3.6);set(&mut m,"CurrentEngineRpm",read_i(p,l::ACC_PHYSICS_RPMS));
        set(&mut m,"Accel",js_round((rf(p,l::ACC_PHYSICS_GAS) as f64)*255.0));set(&mut m,"Brake",js_round((rf(p,l::ACC_PHYSICS_BRAKE) as f64)*255.0));set(&mut m,"Gear",if read_i(p,l::ACC_PHYSICS_GEAR)<=1 {0.0}else{(read_i(p,l::ACC_PHYSICS_GEAR)-1) as f64});set(&mut m,"Steer",js_round((rf(p,l::ACC_PHYSICS_STEER_ANGLE) as f64)*127.0));
        for (name,offset) in [("TireSurfaceTempInnerFL",l::ACC_PHYSICS_TYRE_TEMP_INNER_FL),("TireSurfaceTempInnerFR",l::ACC_PHYSICS_TYRE_TEMP_INNER_FR),("TireSurfaceTempInnerRL",l::ACC_PHYSICS_TYRE_TEMP_INNER_RL),("TireSurfaceTempInnerRR",l::ACC_PHYSICS_TYRE_TEMP_INNER_RR),("TireSurfaceTempMiddleFL",l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_FL),("TireSurfaceTempMiddleFR",l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_FR),("TireSurfaceTempMiddleRL",l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_RL),("TireSurfaceTempMiddleRR",l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_RR),("TireSurfaceTempOuterFL",l::ACC_PHYSICS_TYRE_TEMP_OUTER_FL),("TireSurfaceTempOuterFR",l::ACC_PHYSICS_TYRE_TEMP_OUTER_FR),("TireSurfaceTempOuterRL",l::ACC_PHYSICS_TYRE_TEMP_OUTER_RL),("TireSurfaceTempOuterRR",l::ACC_PHYSICS_TYRE_TEMP_OUTER_RR)]{set(&mut m,name,rf(p,offset));}
        for (k,o) in [("EngineMaxRpm",l::ACC_PHYSICS_CURRENT_MAX_RPM),("AccelerationX",l::ACC_PHYSICS_ACC_GX),("AccelerationY",l::ACC_PHYSICS_ACC_GY),("AccelerationZ",l::ACC_PHYSICS_ACC_GZ),("VelocityX",l::ACC_PHYSICS_VELOCITY_X),("VelocityY",l::ACC_PHYSICS_VELOCITY_Y),("VelocityZ",l::ACC_PHYSICS_VELOCITY_Z),("AngularVelocityX",l::ACC_PHYSICS_LOCAL_ANGULAR_VEL_X),("AngularVelocityY",l::ACC_PHYSICS_LOCAL_ANGULAR_VEL_Y),("AngularVelocityZ",l::ACC_PHYSICS_LOCAL_ANGULAR_VEL_Z),("Pitch",l::ACC_PHYSICS_PITCH),("Roll",l::ACC_PHYSICS_ROLL),("NormSuspensionTravelFL",l::ACC_PHYSICS_SUSP_TRAVEL_FL),("NormSuspensionTravelFR",l::ACC_PHYSICS_SUSP_TRAVEL_FR),("NormSuspensionTravelRL",l::ACC_PHYSICS_SUSP_TRAVEL_RL),("NormSuspensionTravelRR",l::ACC_PHYSICS_SUSP_TRAVEL_RR),("TireSlipRatioFL",l::ACC_PHYSICS_SLIP_RATIO_FL),("TireSlipRatioFR",l::ACC_PHYSICS_SLIP_RATIO_FR),("TireSlipRatioRL",l::ACC_PHYSICS_SLIP_RATIO_RL),("TireSlipRatioRR",l::ACC_PHYSICS_SLIP_RATIO_RR),("WheelRotationSpeedFL",l::ACC_PHYSICS_WHEEL_ROT_FL),("WheelRotationSpeedFR",l::ACC_PHYSICS_WHEEL_ROT_FR),("WheelRotationSpeedRL",l::ACC_PHYSICS_WHEEL_ROT_RL),("WheelRotationSpeedRR",l::ACC_PHYSICS_WHEEL_ROT_RR),("TireSlipAngleFL",l::ACC_PHYSICS_SLIP_ANGLE_FL),("TireSlipAngleFR",l::ACC_PHYSICS_SLIP_ANGLE_FR),("TireSlipAngleRL",l::ACC_PHYSICS_SLIP_ANGLE_RL),("TireSlipAngleRR",l::ACC_PHYSICS_SLIP_ANGLE_RR),("TireCombinedSlipFL",l::ACC_PHYSICS_WHEEL_SLIP_FL),("TireCombinedSlipFR",l::ACC_PHYSICS_WHEEL_SLIP_FR),("TireCombinedSlipRL",l::ACC_PHYSICS_WHEEL_SLIP_RL),("TireCombinedSlipRR",l::ACC_PHYSICS_WHEEL_SLIP_RR),("SuspensionTravelMFL",l::ACC_PHYSICS_SUSP_TRAVEL_FL),("SuspensionTravelMFR",l::ACC_PHYSICS_SUSP_TRAVEL_FR),("SuspensionTravelMRL",l::ACC_PHYSICS_SUSP_TRAVEL_RL),("SuspensionTravelMRR",l::ACC_PHYSICS_SUSP_TRAVEL_RR),("TireTempFL",l::ACC_PHYSICS_TYRE_TEMP_FL),("TireTempFR",l::ACC_PHYSICS_TYRE_TEMP_FR),("TireTempRL",l::ACC_PHYSICS_TYRE_TEMP_RL),("TireTempRR",l::ACC_PHYSICS_TYRE_TEMP_RR),("TireCarcassTempFL",l::ACC_PHYSICS_TYRE_CORE_FL),("TireCarcassTempFR",l::ACC_PHYSICS_TYRE_CORE_FR),("TireCarcassTempRL",l::ACC_PHYSICS_TYRE_CORE_RL),("TireCarcassTempRR",l::ACC_PHYSICS_TYRE_CORE_RR),("TirePressureFrontLeft",l::ACC_PHYSICS_TYRE_PRESSURE_FL),("TirePressureFrontRight",l::ACC_PHYSICS_TYRE_PRESSURE_FR),("TirePressureRearLeft",l::ACC_PHYSICS_TYRE_PRESSURE_RL),("TirePressureRearRight",l::ACC_PHYSICS_TYRE_PRESSURE_RR),("BrakeTempFrontLeft",l::ACC_PHYSICS_BRAKE_TEMP_FL),("BrakeTempFrontRight",l::ACC_PHYSICS_BRAKE_TEMP_FR),("BrakeTempRearLeft",l::ACC_PHYSICS_BRAKE_TEMP_RL),("BrakeTempRearRight",l::ACC_PHYSICS_BRAKE_TEMP_RR),("TireWearFL",l::ACC_PHYSICS_TYRE_WEAR_FL),("TireWearFR",l::ACC_PHYSICS_TYRE_WEAR_FR),("TireWearRL",l::ACC_PHYSICS_TYRE_WEAR_RL),("TireWearRR",l::ACC_PHYSICS_TYRE_WEAR_RR)] { set(&mut m,k,rf(p,o) as f64); }
        set(&mut m,"EngineMaxRpm",if read_i(p,l::ACC_PHYSICS_CURRENT_MAX_RPM)!=0{read_i(p,l::ACC_PHYSICS_CURRENT_MAX_RPM)as f64}else{read_i(s,l::ACC_STATIC_MAX_RPM)as f64});
        set(&mut m,"EngineIdleRpm",0.0);set(&mut m,"WheelOnRumbleStripFL",0.0);set(&mut m,"WheelOnRumbleStripFR",0.0);set(&mut m,"WheelOnRumbleStripRL",0.0);set(&mut m,"WheelOnRumbleStripRR",0.0);set(&mut m,"WheelInPuddleDepthFL",0.0);set(&mut m,"WheelInPuddleDepthFR",0.0);set(&mut m,"WheelInPuddleDepthRL",0.0);set(&mut m,"WheelInPuddleDepthRR",0.0);set(&mut m,"SurfaceRumbleFL_2",0.0);set(&mut m,"SurfaceRumbleFR_2",0.0);set(&mut m,"SurfaceRumbleRL_2",0.0);set(&mut m,"SurfaceRumbleRR_2",0.0);set(&mut m,"TireSlipCombinedFL_2",0.0);
        set(&mut m,"NormSuspensionTravelFL",if rf(s,l::ACC_STATIC_SUSP_MAX_FL)>0.0{rf(p,l::ACC_PHYSICS_SUSP_TRAVEL_FL) as f64/rf(s,l::ACC_STATIC_SUSP_MAX_FL) as f64}else{0.0});set(&mut m,"NormSuspensionTravelFR",if rf(s,l::ACC_STATIC_SUSP_MAX_FR)>0.0{rf(p,l::ACC_PHYSICS_SUSP_TRAVEL_FR) as f64/rf(s,l::ACC_STATIC_SUSP_MAX_FR) as f64}else{0.0});set(&mut m,"NormSuspensionTravelRL",if rf(s,l::ACC_STATIC_SUSP_MAX_RL)>0.0{rf(p,l::ACC_PHYSICS_SUSP_TRAVEL_RL) as f64/rf(s,l::ACC_STATIC_SUSP_MAX_RL) as f64}else{0.0});set(&mut m,"NormSuspensionTravelRR",if rf(s,l::ACC_STATIC_SUSP_MAX_RR)>0.0{rf(p,l::ACC_PHYSICS_SUSP_TRAVEL_RR) as f64/rf(s,l::ACC_STATIC_SUSP_MAX_RR) as f64}else{0.0});
        set(&mut m,"AccelerationX",(rf(p,l::ACC_PHYSICS_ACC_GX) as f64)*9.81);set(&mut m,"AccelerationY",(rf(p,l::ACC_PHYSICS_ACC_GY) as f64)*9.81);set(&mut m,"AccelerationZ",(rf(p,l::ACC_PHYSICS_ACC_GZ) as f64)*9.81);set(&mut m,"Yaw",rf(p,l::ACC_PHYSICS_HEADING) as f64);set(&mut m,"Pitch",rf(p,l::ACC_PHYSICS_PITCH) as f64);set(&mut m,"Roll",rf(p,l::ACC_PHYSICS_ROLL) as f64);
        let max_fuel=rf(s,l::ACC_STATIC_MAX_FUEL);if max_fuel.is_finite()&&max_fuel>0.0{set(&mut m,"FuelCapacity",max_fuel as f64);}set(&mut m,"Boost",0.0);set(&mut m,"Clutch",0.0);set(&mut m,"HandBrake",0.0);set(&mut m,"NormDrivingLine",0.0);set(&mut m,"NormAIBrakeDiff",0.0);set(&mut m,"TireWearFL",-1.0);set(&mut m,"TireWearFR",-1.0);set(&mut m,"TireWearRL",-1.0);set(&mut m,"TireWearRR",-1.0);set(&mut m,"Power",0.0);set(&mut m,"Torque",0.0);set(&mut m,"CarClass",0.0);set(&mut m,"CarPerformanceIndex",0.0);set(&mut m,"DrivetrainType",1.0);set(&mut m,"NumCylinders",0.0);
        set(&mut m,"TrackTemp",0.0);set(&mut m,"AirTemp",0.0);set(&mut m,"RainPercent",0.0);set(&mut m,"WeatherType",if read_i(g,l::ACC_GRAPHICS_RAIN_TYRES)!=0{3.0}else{0.0});
        set(&mut m,"SurfaceRumbleFL",0.0);set(&mut m,"SurfaceRumbleFR",0.0);set(&mut m,"SurfaceRumbleRL",0.0);set(&mut m,"SurfaceRumbleRR",0.0);
        let mut ext=Map::with_capacity(48); ext.insert("pitStatus".into(),Value::String((if read_i(g,l::ACC_GRAPHICS_IS_IN_PIT)!=0 {"in_pit"} else if read_i(g,l::ACC_GRAPHICS_IS_IN_PIT_LANE)!=0 {"pit_lane"} else {"out"}).into()));
        ext.insert("flagStatus".into(),Value::String(match read_i(g,l::ACC_GRAPHICS_FLAG){0=>"none",1=>"blue",2=>"yellow",3=>"black",4=>"white",5=>"checkered",6=>"penalty",_=>"none"}.into()));
        ext.insert("currentSectorIndex".into(),num(read_i(g,l::ACC_GRAPHICS_CURRENT_SECTOR_INDEX) as f64)); ext.insert("lastSectorTime".into(),num(read_i(g,l::ACC_GRAPHICS_LAST_SECTOR_TIME) as f64));
        ext.insert("isValidLap".into(),if g.len()>=l::ACC_GRAPHICS_IS_VALID_LAP+4 { match read_i(g,l::ACC_GRAPHICS_IS_VALID_LAP) { 1=>Value::Bool(true),0=>Value::Bool(false),_=>Value::Null }} else {Value::Null});
        ext.insert("sessionType".into(),Value::String(acc_session_type(read_i(g,l::ACC_GRAPHICS_SESSION)).into()));
        let penalty=read_i(g,l::ACC_GRAPHICS_PENALTY);ext.insert("penalty".into(),Value::Number(penalty.into()));ext.insert("penaltyTime".into(),num(rf(g,l::ACC_GRAPHICS_PENALTY_TIME)as f64));
        ext.insert("penaltyType".into(),Value::String(match penalty{0=>"none",1=>"drive-through-cutting",2=>"stop-and-go-10-cutting",3=>"stop-and-go-20-cutting",4=>"stop-and-go-30-cutting",5=>"disqualified-cutting",6=>"remove-best-lap-time-cutting",7=>"drive-through-pit-speeding",8=>"stop-and-go-10-pit-speeding",9=>"stop-and-go-20-pit-speeding",10=>"stop-and-go-30-pit-speeding",11=>"disqualified-pit-speeding",12=>"remove-best-lap-time-pit-speeding",13=>"disqualified-ignored-mandatory-pit",14=>"post-race-time",15=>"disqualified-trolling",16=>"disqualified-pit-entry",17=>"disqualified-pit-exit",18=>"disqualified-wrong-way-old",19=>"drive-through-ignored-driver-stint",20=>"disqualified-ignored-driver-stint",21=>"disqualified-exceeded-driver-stint-limit",22=>"disqualified-wrong-way",_=>"unknown"}.into()));
        ext.insert("fuelPerLap".into(),num(rf(g,l::ACC_GRAPHICS_FUEL_XLAP)as f64));ext.insert("windSpeed".into(),num(rf(g,l::ACC_GRAPHICS_WIND_SPEED)as f64));ext.insert("windDirection".into(),num(rf(g,l::ACC_GRAPHICS_WIND_DIRECTION)as f64));
        let compound=wide(g,l::ACC_GRAPHICS_CURRENT_TYRE_COMPOUND,66);ext.insert("tireCompound".into(),Value::String(if compound.is_empty(){if read_i(g,l::ACC_GRAPHICS_RAIN_TYRES)!=0{"wet_compound".into()}else{"dry_compound".into()}}else{compound}));
        for (k,o) in [("tireCoreTemp",[l::ACC_PHYSICS_TYRE_CORE_FL,l::ACC_PHYSICS_TYRE_CORE_FR,l::ACC_PHYSICS_TYRE_CORE_RL,l::ACC_PHYSICS_TYRE_CORE_RR]),("tireInnerTemp",[l::ACC_PHYSICS_TYRE_TEMP_INNER_FL,l::ACC_PHYSICS_TYRE_TEMP_INNER_FR,l::ACC_PHYSICS_TYRE_TEMP_INNER_RL,l::ACC_PHYSICS_TYRE_TEMP_INNER_RR]),("tireMiddleTemp",[l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_FL,l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_FR,l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_RL,l::ACC_PHYSICS_TYRE_TEMP_MIDDLE_RR]),("tireOuterTemp",[l::ACC_PHYSICS_TYRE_TEMP_OUTER_FL,l::ACC_PHYSICS_TYRE_TEMP_OUTER_FR,l::ACC_PHYSICS_TYRE_TEMP_OUTER_RL,l::ACC_PHYSICS_TYRE_TEMP_OUTER_RR]),("tireCamber",[l::ACC_PHYSICS_CAMBER_FL,l::ACC_PHYSICS_CAMBER_FR,l::ACC_PHYSICS_CAMBER_RL,l::ACC_PHYSICS_CAMBER_RR]),("wheelLoad",[l::ACC_PHYSICS_WHEEL_LOAD_FL,l::ACC_PHYSICS_WHEEL_LOAD_FR,l::ACC_PHYSICS_WHEEL_LOAD_RL,l::ACC_PHYSICS_WHEEL_LOAD_RR]),("brakePadWear",[l::ACC_PHYSICS_PAD_LIFE_FL,l::ACC_PHYSICS_PAD_LIFE_FR,l::ACC_PHYSICS_PAD_LIFE_RL,l::ACC_PHYSICS_PAD_LIFE_RR])] {
            ext.insert(k.into(),Value::Array(o.iter().map(|offset|num(rf(p,*offset) as f64)).collect()));
        }
        ext.insert("rideHeight".into(),Value::Array(vec![num(rf(p,l::ACC_PHYSICS_RIDE_HEIGHT_F)as f64),num(rf(p,l::ACC_PHYSICS_RIDE_HEIGHT_R)as f64)]));
        ext.insert("cgHeight".into(),num(rf(p,l::ACC_PHYSICS_CG_HEIGHT)as f64));ext.insert("tireRadius".into(),Value::Array([l::ACC_STATIC_TYRE_RADIUS_FL,l::ACC_STATIC_TYRE_RADIUS_FR,l::ACC_STATIC_TYRE_RADIUS_RL,l::ACC_STATIC_TYRE_RADIUS_RR].iter().map(|o|num(rf(s,*o)as f64)).collect()));
        ext.insert("tireContactHeading".into(),Value::Array((0..4).map(|i|Value::Array((0..3).map(|j|num(rf(p,l::ACC_PHYSICS_CONTACT_HEADING_BASE+i*12+j*4)as f64)).collect())).collect()));
        ext.insert("brakePadCompound".into(),Value::Number(0.into()));ext.insert("tc".into(),Value::Number(read_i(g,l::ACC_GRAPHICS_TC_GRAPHICS).into()));ext.insert("tcCut".into(),Value::Number(read_i(g,l::ACC_GRAPHICS_TC_CUT).into()));ext.insert("abs".into(),Value::Number(read_i(g,l::ACC_GRAPHICS_ABS_GRAPHICS).into()));ext.insert("engineMap".into(),Value::Number(read_i(g,l::ACC_GRAPHICS_ENGINE_MAP).into()));ext.insert("brakeBias".into(),num(rf(p,l::ACC_PHYSICS_BRAKE_BIAS)as f64));
        ext.insert("tcIntervention".into(),Value::Number(((rf(p,l::ACC_PHYSICS_TC)>0.01)as i32).into()));ext.insert("absIntervention".into(),Value::Number(((rf(p,l::ACC_PHYSICS_ABS)>0.01)as i32).into()));ext.insert("tcRaw".into(),num(rf(p,l::ACC_PHYSICS_TC)as f64));ext.insert("absRaw".into(),num(rf(p,l::ACC_PHYSICS_ABS)as f64));ext.insert("slipVibrations".into(),num(rf(p,l::ACC_PHYSICS_SLIP_VIBRATIONS)as f64));ext.insert("absVibrations".into(),num(rf(p,l::ACC_PHYSICS_ABS_VIBRATIONS)as f64));
        ext.insert("rainIntensity".into(),Value::Number(0.into()));ext.insert("trackGripStatus".into(),Value::String("unknown".into()));ext.insert("drsAvailable".into(),Value::Bool(false));ext.insert("drsEnabled".into(),Value::Bool(false));
        ext.insert("carDamage".into(),serde_json::json!({"front":rf(p,l::ACC_PHYSICS_DAM_FRONT),"rear":rf(p,l::ACC_PHYSICS_DAM_REAR),"left":rf(p,l::ACC_PHYSICS_DAM_LEFT),"right":rf(p,l::ACC_PHYSICS_DAM_RIGHT),"centre":rf(p,l::ACC_PHYSICS_DAM_CENTRE)}));
        ext.insert("airTempC".into(),if p.len()>=l::ACC_PHYSICS_AIR_TEMP+4{num(rf(p,l::ACC_PHYSICS_AIR_TEMP)as f64)}else{Value::Null});ext.insert("roadTempC".into(),if p.len()>=l::ACC_PHYSICS_ROAD_TEMP+4{num(rf(p,l::ACC_PHYSICS_ROAD_TEMP)as f64)}else{Value::Null});
        m.insert("acc".into(),Value::Object(ext));
        Value::Object(m)
    }

    fn evo(&self) -> Value {
        use crate::games::generated::layouts as l;
        let (p, g, s) = (self.physics, self.graphics, self.statics);
        let t = self.time_ms;
        let (slot, dist) = (self.slot, self.distance);
        let status = read_i(g, l::EVO_GRAPHICS_EVO_STATUS);
        let laps = read_i(g, l::EVO_GRAPHICS_EVO_TOTAL_LAP_COUNT);
        let speed = rf(p, l::EVO_PHYSICS_SPEED_KMH) as f64 / 3.6;
        let km = rf(g, l::EVO_GRAPHICS_EVO_CURRENT_KM) as f64;
        let mut m=Map::with_capacity(128);base(&mut m,"ac-evo",t,self.car,self.track,laps+1,status==2);
        for (key,val) in [("Fuel",rf(p,l::EVO_PHYSICS_FUEL) as f64),("DistanceTraveled",dist),("Speed",speed),("CurrentEngineRpm",read_i(p,l::EVO_PHYSICS_RPMS) as f64),("PositionX",rf(g,l::EVO_GRAPHICS_EVO_CAR_COORDINATES_BASE+slot*12) as f64),("PositionY",rf(g,l::EVO_GRAPHICS_EVO_CAR_COORDINATES_BASE+slot*12+4) as f64),("PositionZ",rf(g,l::EVO_GRAPHICS_EVO_CAR_COORDINATES_BASE+slot*12+8) as f64),("Yaw",rf(p,l::EVO_PHYSICS_HEADING) as f64)] {set(&mut m,key,val)}
        let current=valid_ms(read_i(g,l::EVO_GRAPHICS_EVO_CURRENT_LAP_TIME_MS));let last=valid_ms(read_i(g,l::EVO_GRAPHICS_EVO_LAST_LAPTIME_MS));let best=valid_ms(read_i(g,l::EVO_GRAPHICS_EVO_BEST_LAPTIME_MS));set(&mut m,"CurrentLap",current);set(&mut m,"CurrentRaceTime",current);set(&mut m,"LastLap",last);set(&mut m,"BestLap",best);
        for (k,o) in [("AccelerationX",l::EVO_PHYSICS_ACC_GX),("AccelerationY",l::EVO_PHYSICS_ACC_GY),("AccelerationZ",l::EVO_PHYSICS_ACC_GZ),("VelocityX",l::EVO_PHYSICS_VELOCITY_X),("VelocityY",l::EVO_PHYSICS_VELOCITY_Y),("VelocityZ",l::EVO_PHYSICS_VELOCITY_Z),("AngularVelocityX",l::EVO_PHYSICS_LOCAL_ANGULAR_VEL_X),("AngularVelocityY",l::EVO_PHYSICS_LOCAL_ANGULAR_VEL_Y),("AngularVelocityZ",l::EVO_PHYSICS_LOCAL_ANGULAR_VEL_Z),("Pitch",l::EVO_PHYSICS_PITCH),("Roll",l::EVO_PHYSICS_ROLL),("TireSlipRatioFL",l::EVO_PHYSICS_SLIP_RATIO_FL),("TireSlipRatioFR",l::EVO_PHYSICS_SLIP_RATIO_FR),("TireSlipRatioRL",l::EVO_PHYSICS_SLIP_RATIO_RL),("TireSlipRatioRR",l::EVO_PHYSICS_SLIP_RATIO_RR),("WheelRotationSpeedFL",l::EVO_PHYSICS_WHEEL_ROT_FL),("WheelRotationSpeedFR",l::EVO_PHYSICS_WHEEL_ROT_FR),("WheelRotationSpeedRL",l::EVO_PHYSICS_WHEEL_ROT_RL),("WheelRotationSpeedRR",l::EVO_PHYSICS_WHEEL_ROT_RR),("TireSlipAngleFL",l::EVO_PHYSICS_SLIP_ANGLE_FL),("TireSlipAngleFR",l::EVO_PHYSICS_SLIP_ANGLE_FR),("TireSlipAngleRL",l::EVO_PHYSICS_SLIP_ANGLE_RL),("TireSlipAngleRR",l::EVO_PHYSICS_SLIP_ANGLE_RR),("TireCombinedSlipFL",l::EVO_PHYSICS_WHEEL_SLIP_FL),("TireCombinedSlipFR",l::EVO_PHYSICS_WHEEL_SLIP_FR),("TireCombinedSlipRL",l::EVO_PHYSICS_WHEEL_SLIP_RL),("TireCombinedSlipRR",l::EVO_PHYSICS_WHEEL_SLIP_RR),("SuspensionTravelMFL",l::EVO_PHYSICS_SUSP_TRAVEL_FL),("SuspensionTravelMFR",l::EVO_PHYSICS_SUSP_TRAVEL_FR),("SuspensionTravelMRL",l::EVO_PHYSICS_SUSP_TRAVEL_RL),("SuspensionTravelMRR",l::EVO_PHYSICS_SUSP_TRAVEL_RR),("TireCarcassTempFL",l::EVO_PHYSICS_TYRE_CORE_FL),("TireCarcassTempFR",l::EVO_PHYSICS_TYRE_CORE_FR),("TireCarcassTempRL",l::EVO_PHYSICS_TYRE_CORE_RL),("TireCarcassTempRR",l::EVO_PHYSICS_TYRE_CORE_RR),("TirePressureFrontLeft",l::EVO_PHYSICS_TYRE_PRESSURE_FL),("TirePressureFrontRight",l::EVO_PHYSICS_TYRE_PRESSURE_FR),("TirePressureRearLeft",l::EVO_PHYSICS_TYRE_PRESSURE_RL),("TirePressureRearRight",l::EVO_PHYSICS_TYRE_PRESSURE_RR),("BrakeTempFrontLeft",l::EVO_PHYSICS_BRAKE_TEMP_FL),("BrakeTempFrontRight",l::EVO_PHYSICS_BRAKE_TEMP_FR),("BrakeTempRearLeft",l::EVO_PHYSICS_BRAKE_TEMP_RL),("BrakeTempRearRight",l::EVO_PHYSICS_BRAKE_TEMP_RR),("TireWearFL",l::EVO_PHYSICS_TYRE_WEAR_FL),("TireWearFR",l::EVO_PHYSICS_TYRE_WEAR_FR),("TireWearRL",l::EVO_PHYSICS_TYRE_WEAR_RL),("TireWearRR",l::EVO_PHYSICS_TYRE_WEAR_RR)] {set(&mut m,k,rf(p,o) as f64);}
        let tire_bases=[l::EVO_GRAPHICS_EVO_TYRE_LF_BASE,l::EVO_GRAPHICS_EVO_TYRE_RF_BASE,l::EVO_GRAPHICS_EVO_TYRE_LR_BASE,l::EVO_GRAPHICS_EVO_TYRE_RR_BASE];
        for (k,o) in [("TireTempFL",tire_bases[0]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER),("TireTempFR",tire_bases[1]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER),("TireTempRL",tire_bases[2]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER),("TireTempRR",tire_bases[3]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER)] {set(&mut m,k,rf(g,o) as f64);}
        for (key, offset) in [("TireSurfaceTempInnerFL",tire_bases[0]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT),("TireSurfaceTempInnerFR",tire_bases[1]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT),("TireSurfaceTempInnerRL",tire_bases[2]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT),("TireSurfaceTempInnerRR",tire_bases[3]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT),("TireSurfaceTempMiddleFL",tire_bases[0]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER),("TireSurfaceTempMiddleFR",tire_bases[1]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER),("TireSurfaceTempMiddleRL",tire_bases[2]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER),("TireSurfaceTempMiddleRR",tire_bases[3]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER),("TireSurfaceTempOuterFL",tire_bases[0]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT),("TireSurfaceTempOuterFR",tire_bases[1]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT),("TireSurfaceTempOuterRL",tire_bases[2]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT),("TireSurfaceTempOuterRR",tire_bases[3]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT)] { let value=rf(g,offset); if value>0.0 { set(&mut m,key,value as f64); } }
        set(&mut m,"EngineMaxRpm",read_i(p,l::EVO_PHYSICS_CURRENT_MAX_RPM) as f64);
        set(&mut m,"EngineIdleRpm",0.0);set(&mut m,"AccelerationX",(rf(p,l::EVO_PHYSICS_ACC_GX) as f64)*9.81);set(&mut m,"AccelerationY",(rf(p,l::EVO_PHYSICS_ACC_GY) as f64)*9.81);set(&mut m,"AccelerationZ",(rf(p,l::EVO_PHYSICS_ACC_GZ) as f64)*9.81);
        set(&mut m,"NormSuspensionTravelFL",(0.5+rf(p,l::EVO_PHYSICS_SUSP_TRAVEL_FL) as f64/0.1).clamp(0.0,1.0));set(&mut m,"NormSuspensionTravelFR",(0.5+rf(p,l::EVO_PHYSICS_SUSP_TRAVEL_FR) as f64/0.1).clamp(0.0,1.0));set(&mut m,"NormSuspensionTravelRL",(0.5+rf(p,l::EVO_PHYSICS_SUSP_TRAVEL_RL) as f64/0.1).clamp(0.0,1.0));set(&mut m,"NormSuspensionTravelRR",(0.5+rf(p,l::EVO_PHYSICS_SUSP_TRAVEL_RR) as f64/0.1).clamp(0.0,1.0));
        set(&mut m,"Accel",js_round((rf(p,l::EVO_PHYSICS_GAS) as f64)*255.0));set(&mut m,"Brake",js_round((rf(p,l::EVO_PHYSICS_BRAKE) as f64)*255.0));set(&mut m,"Gear",if read_i(p,l::EVO_PHYSICS_GEAR)<=1{0.0}else{(read_i(p,l::EVO_PHYSICS_GEAR)-1)as f64});set(&mut m,"Steer",js_round((rf(p,l::EVO_PHYSICS_STEER_ANGLE) as f64)*127.0));set(&mut m,"Clutch",0.0);set(&mut m,"HandBrake",0.0);set(&mut m,"Boost",0.0);set(&mut m,"NormDrivingLine",0.0);set(&mut m,"NormAIBrakeDiff",0.0);
        for k in ["WheelOnRumbleStripFL","WheelOnRumbleStripFR","WheelOnRumbleStripRL","WheelOnRumbleStripRR","WheelInPuddleDepthFL","WheelInPuddleDepthFR","WheelInPuddleDepthRL","WheelInPuddleDepthRR","SurfaceRumbleFL_2","SurfaceRumbleFR_2","SurfaceRumbleRL_2","SurfaceRumbleRR_2","TireSlipCombinedFL_2","SurfaceRumbleFL","SurfaceRumbleFR","SurfaceRumbleRL","SurfaceRumbleRR"]{set(&mut m,k,0.0)}
        let max_fuel=rf(g,l::EVO_GRAPHICS_EVO_MAX_FUEL);if max_fuel.is_finite()&&max_fuel>0.0{set(&mut m,"FuelCapacity",max_fuel as f64);}set(&mut m,"Power",0.0);set(&mut m,"Torque",0.0);set(&mut m,"CarClass",0.0);set(&mut m,"CarPerformanceIndex",0.0);set(&mut m,"DrivetrainType",1.0);set(&mut m,"NumCylinders",0.0);set(&mut m,"WeatherType",0.0);set(&mut m,"TrackTemp",rf(s,l::EVO_STATIC_EVO_STARTING_GROUND_TEMPERATURE_C) as f64);set(&mut m,"AirTemp",rf(s,l::EVO_STATIC_EVO_STARTING_AMBIENT_TEMPERATURE_C) as f64);set(&mut m,"RainPercent",0.0);
        if self.car<0&&!self.car_model.is_empty(){m.insert("carModelName".into(),Value::String(self.car_model.to_owned()));}
        let mut ext=Map::with_capacity(48);let pit_box=read_u8(g,l::EVO_GRAPHICS_EVO_IS_IN_PIT_BOX)!=0;let pit_lane=read_u8(g,l::EVO_GRAPHICS_EVO_IS_IN_PIT_LANE)!=0;let location=read_i(g,l::EVO_GRAPHICS_EVO_CAR_LOCATION);
        ext.insert("pitStatus".into(),Value::String((if pit_box||location==0 {"in_pit"} else if pit_lane||location==1 {"pit_lane"} else {"out"}).into()));
        ext.insert("isValidLap".into(),if read_u8(g,l::EVO_GRAPHICS_EVO_IS_VALID_LAP)!=0 {Value::Bool(true)}else if pit_lane||pit_box {Value::Null}else{Value::Bool(false)});
        ext.insert("tireCompound".into(),Value::String({let v=cstr(g,l::EVO_GRAPHICS_EVO_TYRE_LF_BASE+l::EVO_GRAPHICS_EVO_TYRE_COMPOUND_OFFSET,33);if v.is_empty(){"dry_compound".to_owned()}else{v}}));
        ext.insert("tireCoreTemp".into(),Value::Array([l::EVO_PHYSICS_TYRE_CORE_FL,l::EVO_PHYSICS_TYRE_CORE_FR,l::EVO_PHYSICS_TYRE_CORE_RL,l::EVO_PHYSICS_TYRE_CORE_RR].iter().map(|o|num(rf(p,*o)as f64)).collect()));
        ext.insert("tireCamber".into(),Value::Array([l::EVO_PHYSICS_CAMBER_FL,l::EVO_PHYSICS_CAMBER_FR,l::EVO_PHYSICS_CAMBER_RL,l::EVO_PHYSICS_CAMBER_RR].iter().map(|o|num(rf(p,*o)as f64)).collect()));
        ext.insert("wheelLoad".into(),Value::Array([l::EVO_PHYSICS_WHEEL_LOAD_FL,l::EVO_PHYSICS_WHEEL_LOAD_FR,l::EVO_PHYSICS_WHEEL_LOAD_RL,l::EVO_PHYSICS_WHEEL_LOAD_RR].iter().map(|o|num(rf(p,*o)as f64)).collect()));
        ext.insert("brakePadWear".into(),Value::Array([l::EVO_PHYSICS_PAD_LIFE_FL,l::EVO_PHYSICS_PAD_LIFE_FR,l::EVO_PHYSICS_PAD_LIFE_RL,l::EVO_PHYSICS_PAD_LIFE_RR].iter().map(|o|num(rf(p,*o)as f64)).collect()));
        for (name,offs) in [("tireInnerTemp",[tire_bases[0]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT,tire_bases[1]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT,tire_bases[2]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT,tire_bases[3]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT]),("tireMiddleTemp",[tire_bases[0]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER,tire_bases[1]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER,tire_bases[2]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER,tire_bases[3]+l::EVO_TYRE_STATE_TEMPERATURE_CENTER]),("tireOuterTemp",[tire_bases[0]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT,tire_bases[1]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT,tire_bases[2]+l::EVO_TYRE_STATE_TEMPERATURE_LEFT,tire_bases[3]+l::EVO_TYRE_STATE_TEMPERATURE_RIGHT])] {ext.insert(name.into(),Value::Array(offs.iter().map(|o|num(rf(g,*o)as f64)).collect()));}
        ext.insert("cgHeight".into(),num(rf(p,l::EVO_PHYSICS_CG_HEIGHT)as f64));ext.insert("tireRadius".into(),Value::Array(vec![0.into(),0.into(),0.into(),0.into()]));
        ext.insert("tireContactHeading".into(),Value::Array((0..4).map(|i|Value::Array((0..3).map(|j|num(rf(p,l::EVO_PHYSICS_CONTACT_HEADING_BASE+i*12+j*4)as f64)).collect())).collect()));
        let elec=l::EVO_GRAPHICS_EVO_ELECTRONICS_BASE;
        ext.insert("brakePadCompound".into(),Value::Number(0.into()));ext.insert("tc".into(),Value::Number((read_u8(g,elec+l::EVO_ELECTRONICS_TC_LEVEL)as i8 as i64).into()));ext.insert("tcCut".into(),Value::Number((read_u8(g,elec+l::EVO_ELECTRONICS_TC_CUT_LEVEL)as i8 as i64).into()));ext.insert("abs".into(),Value::Number((read_u8(g,elec+l::EVO_ELECTRONICS_ABS_LEVEL)as i8 as i64).into()));ext.insert("engineMap".into(),Value::Number((read_u8(g,elec+l::EVO_ELECTRONICS_ENGINE_MAP_LEVEL)as i8 as i64).into()));ext.insert("brakeBias".into(),num(rf(p,l::EVO_PHYSICS_BRAKE_BIAS)as f64));
        ext.insert("tcIntervention".into(),Value::Number(((read_u8(g,l::EVO_GRAPHICS_EVO_TC_ACTIVE)!=0) as i32).into()));ext.insert("absIntervention".into(),Value::Number(((read_u8(g,l::EVO_GRAPHICS_EVO_ABS_ACTIVE)!=0) as i32).into()));ext.insert("tcRaw".into(),num(rf(p,l::EVO_PHYSICS_TC)as f64));ext.insert("absRaw".into(),num(rf(p,l::EVO_PHYSICS_ABS)as f64));ext.insert("slipVibrations".into(),num(rf(p,l::EVO_PHYSICS_SLIP_VIBRATIONS)as f64));ext.insert("absVibrations".into(),num(rf(p,l::EVO_PHYSICS_ABS_VIBRATIONS)as f64));
        ext.insert("rainIntensity".into(),Value::Number(0.into()));ext.insert("trackGripStatus".into(),Value::String("unknown".into()));ext.insert("windSpeed".into(),Value::Number(0.into()));ext.insert("windDirection".into(),Value::Number(0.into()));ext.insert("drsAvailable".into(),Value::Bool(false));ext.insert("drsEnabled".into(),Value::Bool(false));
        ext.insert("fuelPerLap".into(),num(rf(g,l::EVO_GRAPHICS_EVO_FUEL_PER_LAP)as f64));ext.insert("currentSectorIndex".into(),Value::Number((-1).into()));ext.insert("lastSectorTime".into(),Value::Number(0.into()));
        ext.insert("airTempC".into(),if p.len()>=l::EVO_PHYSICS_AIR_TEMP+4{num(rf(p,l::EVO_PHYSICS_AIR_TEMP)as f64)}else{Value::Null});ext.insert("roadTempC".into(),if p.len()>=l::EVO_PHYSICS_ROAD_TEMP+4{num(rf(p,l::EVO_PHYSICS_ROAD_TEMP)as f64)}else{Value::Null});
        let mut evo=Map::with_capacity(64);evo.insert("physicsPacketId".into(),Value::Number(read_i(p,l::EVO_PHYSICS_PACKET_ID).into()));evo.insert("graphicsPacketId".into(),Value::Number(read_i(g,l::EVO_GRAPHICS_EVO_PACKET_ID).into()));evo.insert("acEvoVersion".into(),Value::String(cstr(s,l::EVO_STATIC_EVO_AC_EVO_VERSION,15)));
        evo.insert("sessionName".into(),Value::String(cstr(s,l::EVO_STATIC_EVO_SESSION_NAME,33)));evo.insert("isStaticWeather".into(),Value::Bool(read_u8(s,l::EVO_STATIC_EVO_IS_STATIC_WEATHER)!=0));evo.insert("isTimedRace".into(),Value::Bool(read_u8(s,l::EVO_STATIC_EVO_IS_TIMED_RACE)!=0));evo.insert("isOnline".into(),Value::Bool(read_u8(s,l::EVO_STATIC_EVO_IS_ONLINE)!=0));evo.insert("numberOfSessions".into(),Value::Number(read_i(s,l::EVO_STATIC_EVO_NUMBER_OF_SESSIONS).into()));
        let session=read_i(s,l::EVO_STATIC_EVO_SESSION);evo.insert("sessionType".into(),Value::String(match session{0=>"time_attack",1=>"race",2=>"hot_stint",3=>"cruise",-1=>"unknown",_=>"unknown"}.into()));
        let grip=read_i(s,l::EVO_STATIC_EVO_STARTING_GRIP);evo.insert("startingGrip".into(),Value::String(match grip{0=>"green",1=>"fast",2=>"optimum",_=>"unknown"}.into()));
        let session_base=l::EVO_GRAPHICS_EVO_SESSION_STATE_BASE;
        let timing_base=l::EVO_GRAPHICS_EVO_TIMING_STATE_BASE;
        evo.insert("deltaCurrent".into(),Value::String(cstr(g,timing_base+l::EVO_TIMING_STATE_DELTA_CURRENT,15)));evo.insert("deltaLast".into(),Value::String(cstr(g,timing_base+l::EVO_TIMING_STATE_DELTA_LAST,15)));evo.insert("idealLapTime".into(),Value::String(cstr(g,timing_base+l::EVO_TIMING_STATE_IDEAL_LAPTIME,15)));evo.insert("timingIsInvalid".into(),Value::Bool(read_u8(g,timing_base+l::EVO_TIMING_STATE_IS_INVALID)!=0));
        let flag=read_i(g,l::EVO_GRAPHICS_EVO_FLAG);
        let elec=l::EVO_GRAPHICS_EVO_ELECTRONICS_BASE;
        evo.insert("escLevel".into(),Value::Number((read_u8(g,elec+l::EVO_ELECTRONICS_ESC_LEVEL)as i8 as i64).into()));evo.insert("isDrsOpen".into(),Value::Bool(read_u8(g,elec+l::EVO_ELECTRONICS_IS_DRS_OPEN)!=0));
        evo.insert("engineMapLevel".into(),Value::Number((read_u8(g,elec+l::EVO_ELECTRONICS_ENGINE_MAP_LEVEL) as i8 as i64).into()));
        evo.insert("tyreMiddleTempC".into(),Value::Array(tire_bases.iter().map(|o|num(rf(g,*o+l::EVO_TYRE_STATE_TEMPERATURE_CENTER)as f64)).collect()));
        evo.insert("clutchPercent".into(),num(rf(g,l::EVO_GRAPHICS_EVO_CLUTCH_PERCENT)as f64));evo.insert("handbrakePercent".into(),num(rf(g,l::EVO_GRAPHICS_EVO_HANDBRAKE_PERCENT)as f64));evo.insert("waterTempC".into(),num(rf(p,l::EVO_PHYSICS_WATER_TEMP)as f64));evo.insert("oilTempC".into(),num(rf(g,l::EVO_GRAPHICS_EVO_OIL_TEMPERATURE_C)as f64));evo.insert("oilPressureBar".into(),num(rf(g,l::EVO_GRAPHICS_EVO_OIL_PRESSURE_BAR)as f64));evo.insert("exhaustTempC".into(),num(rf(g,l::EVO_GRAPHICS_EVO_EXHAUST_TEMPERATURE_C)as f64));evo.insert("turboBoost".into(),num(rf(g,l::EVO_GRAPHICS_EVO_TURBO_BOOST)as f64));evo.insert("currentTorque".into(),num(rf(g,l::EVO_GRAPHICS_EVO_CURRENT_TORQUE)as f64));evo.insert("currentBhp".into(),Value::Number(read_i(g,l::EVO_GRAPHICS_EVO_CURRENT_BHP).into()));evo.insert("isWrongWay".into(),Value::Bool(read_u8(g,l::EVO_GRAPHICS_EVO_IS_WRONG_WAY)!=0));
        evo.insert("instantaneousKmPerLiter".into(),num(rf(g,l::EVO_GRAPHICS_EVO_INSTANTANEOUS_KM_PER_FUEL_LITER)as f64));
        m.insert("RacePosition".into(),Value::Number((u32le(g,l::EVO_GRAPHICS_EVO_CURRENT_POS).unwrap_or(0)as u64).into()));
        ext.insert("flagStatus".into(),Value::String(match flag{0=>"none",1=>"white",2=>"green",3=>"red",4=>"blue",5=>"yellow",6=>"black",7=>"black_white",8=>"checkered",9=>"orange_circle",10=>"red_yellow_stripes",_=>"none"}.into()));
        ext.insert("normalizedCarPosition".into(),num(rf(g,l::EVO_GRAPHICS_EVO_NPOS)as f64));ext.insert("trackLengthM".into(),num(rf(s,l::EVO_STATIC_EVO_TRACK_LENGTH_M)as f64));
        ext.insert("carDamage".into(),serde_json::json!({"front":rf(p,l::EVO_PHYSICS_DAM_FRONT),"rear":rf(p,l::EVO_PHYSICS_DAM_REAR),"left":rf(p,l::EVO_PHYSICS_DAM_LEFT),"right":rf(p,l::EVO_PHYSICS_DAM_RIGHT),"centre":rf(p,l::EVO_PHYSICS_DAM_CENTRE)}));
        evo.insert("airTempC".into(),num(rf(p,l::EVO_PHYSICS_AIR_TEMP)as f64));evo.insert("roadTempC".into(),num(rf(p,l::EVO_PHYSICS_ROAD_TEMP)as f64));evo.insert("deltaTimeMs".into(),Value::Number(read_i(g,l::EVO_GRAPHICS_EVO_DELTA_TIME_MS).into()));evo.insert("predictedLapTimeMs".into(),Value::Number(read_i(g,l::EVO_GRAPHICS_EVO_PREDICTED_LAP_TIME_MS).into()));
        evo.insert("sessionTimeLeftMs".into(),Value::Number(read_i(g,session_base+l::EVO_SESSION_STATE_TIME_LEFT_MS).into()));evo.insert("sessionTotalLaps".into(),Value::Number(read_i(g,session_base+l::EVO_SESSION_STATE_TOTAL_LAP).into()));evo.insert("sessionCurrentLap".into(),Value::Number(read_i(g,session_base+l::EVO_SESSION_STATE_CURRENT_LAP).into()));evo.insert("lapLengthKm".into(),num(rf(g,session_base+l::EVO_SESSION_STATE_LAP_LENGTH_KM)as f64));
        evo.insert("fuelLiters".into(),num(rf(g,l::EVO_GRAPHICS_EVO_FUEL_LITER_CURRENT_QUANTITY)as f64));evo.insert("fuelPercent".into(),num(rf(g,l::EVO_GRAPHICS_EVO_FUEL_LITER_CURRENT_QUANTITY_PERCENT)as f64));evo.insert("fuelLitersPerLap".into(),num(rf(g,l::EVO_GRAPHICS_EVO_FUEL_LITER_PER_LAP)as f64));evo.insert("fuelLitersUsed".into(),num(rf(g,l::EVO_GRAPHICS_EVO_FUEL_LITER_USED)as f64));evo.insert("lapsPossibleWithFuel".into(),num(rf(g,l::EVO_GRAPHICS_EVO_LAPS_POSSIBLE_WITH_FUEL)as f64));evo.insert("kmPerFuelLiter".into(),num(rf(g,l::EVO_GRAPHICS_EVO_KM_PER_FUEL_LITER)as f64));
        evo.insert("brakeDiscLife".into(),Value::Array([l::EVO_PHYSICS_DISC_LIFE_FL,l::EVO_PHYSICS_DISC_LIFE_FR,l::EVO_PHYSICS_DISC_LIFE_RL,l::EVO_PHYSICS_DISC_LIFE_RR].iter().map(|o|num(rf(p,*o)as f64)).collect()));evo.insert("localVelocity".into(),Value::Array(vec![num(rf(p,l::EVO_PHYSICS_LOCAL_VELOCITY_X)as f64),num(rf(p,l::EVO_PHYSICS_LOCAL_VELOCITY_Y)as f64),num(rf(p,l::EVO_PHYSICS_LOCAL_VELOCITY_Z)as f64)]));
        evo.insert("gapAheadMs".into(),num(rf(g,l::EVO_GRAPHICS_EVO_GAP_AHEAD)as f64));evo.insert("gapBehindMs".into(),num(rf(g,l::EVO_GRAPHICS_EVO_GAP_BEHIND)as f64));evo.insert("sessionKm".into(),num(km));evo.insert("totalDrivingTimeS".into(),Value::Number((u32le(g,l::EVO_GRAPHICS_EVO_TOTAL_DRIVING_TIME_S).unwrap_or(0)as u64).into()));
        evo.insert("timeOfDayHours".into(),Value::Number(read_i(g,l::EVO_GRAPHICS_EVO_TIME_OF_DAY_HOURS).into()));evo.insert("timeOfDayMinutes".into(),Value::Number(read_i(g,l::EVO_GRAPHICS_EVO_TIME_OF_DAY_MINUTES).into()));evo.insert("timeOfDaySeconds".into(),Value::Number(read_i(g,l::EVO_GRAPHICS_EVO_TIME_OF_DAY_SECONDS).into()));
        ext.insert("acEvo".into(),Value::Object(evo));m.insert("acc".into(),Value::Object(ext));Value::Object(m)
    }
}

fn changed_name<const N: usize>(cache: &mut Option<[u8; N]>, bytes: &[u8], offset: usize) -> bool {
    let raw: &[u8; N] = bytes[offset..offset + N].try_into().expect("validated Kunos name");
    if cache.as_ref() == Some(raw) { return false; }
    *cache = Some(*raw);
    true
}

// Presentation serializes nonfinite floats as null; Value adapter reads null
// as zero. Typed policy must see the same value, not NaN or infinity.
fn finite_number(value: f64) -> f64 { if value.is_finite() { value } else { 0.0 } }

fn acc_session_type(session: i32) -> &'static str {
    match session {
        0 => "practice", 1 => "qualifying", 2 => "race", 3 => "hotlap", 4 => "time-attack",
        5 => "drift", 6 => "drag", 7 => "hot-stint", 8 => "hotlap-superpole", _ => "unknown",
    }
}
fn part(b:&[u8],o:usize)->Option<(&[u8],usize)>{let n=u32le(b,o)? as usize;let start=o.checked_add(4)?;let end=start.checked_add(n)?;Some((b.get(start..end)?,end))}
fn u32le(b:&[u8],o:usize)->Option<u32>{Some(u32::from_le_bytes(b.get(o..o.checked_add(4)?)?.try_into().ok()?))}
fn i32le(b:&[u8],o:usize)->Option<i32>{Some(i32::from_le_bytes(b.get(o..o.checked_add(4)?)?.try_into().ok()?))}
fn read_i(b:&[u8],o:usize)->i32{i32le(b,o).unwrap_or(0)}
fn read_u8(b:&[u8],o:usize)->u8{b.get(o).copied().unwrap_or(0)}
fn rf(b:&[u8],o:usize)->f32{u32le(b,o).map(f32::from_bits).unwrap_or(0.0)}
fn num(v:f64)->Value{Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)}
fn js_round(v:f64)->f64{(v+0.5).floor()}
fn set<T: Into<f64>>(m:&mut Map<String,Value>,k:&str,v:T){m.insert(k.into(),num(v.into()));}
fn base(m:&mut Map<String,Value>,id:&str,t:u64,car:i64,track:i64,lap:i32,on:bool){m.insert("gameId".into(),Value::String(id.into()));m.insert("TimestampMS".into(),Value::Number(t.into()));m.insert("IsRaceOn".into(),Value::Number((on as i64).into()));m.insert("CarOrdinal".into(),Value::Number(car.into()));m.insert("TrackOrdinal".into(),Value::Number(track.into()));m.insert("LapNumber".into(),Value::Number((lap as i64).into()));m.insert("CarClass".into(),Value::Number(0.into()));m.insert("CarPerformanceIndex".into(),Value::Number(0.into()));}
fn valid_ms(v:i32)->f64{if v>0&&v!=i32::MAX {v as f64/1000.0}else{0.0}}
fn wide(b:&[u8],o:usize,n:usize)->String{let mut u=Vec::new();for c in b.get(o..o.saturating_add(n)).unwrap_or(&[]).chunks_exact(2){let x=u16::from_le_bytes([c[0],c[1]]);if x==0{break}u.push(x)}String::from_utf16_lossy(&u).trim().to_owned()}
fn cstr(b:&[u8],o:usize,n:usize)->String{let s=b.get(o..o.saturating_add(n)).unwrap_or(&[]);let e=s.iter().position(|x|*x==0).unwrap_or(s.len());String::from_utf8_lossy(&s[..e]).trim().to_owned()}
fn player_acc(g:&[u8])->usize{use crate::games::generated::layouts as l;let player=read_i(g,l::ACC_GRAPHICS_PLAYER_CAR_ID);if player>0{for n in 0..60{if read_i(g,l::ACC_GRAPHICS_CAR_IDBASE+n*4)==player{return n}}}0}
fn player_slot(s:&mut PlayerSlot,p:&[u8],g:&[u8],active:usize)->usize {
    use crate::games::generated::layouts as l;
    if let Some(slot)=s.slot{return slot}
    let speed=rf(p,l::EVO_PHYSICS_SPEED_KMH) as f64; if speed<20.0{return 0}
    let vx=rf(p,l::EVO_PHYSICS_VELOCITY_X) as f64;let vz=rf(p,l::EVO_PHYSICS_VELOCITY_Z) as f64;let mag=(vx*vx+vz*vz).sqrt();if mag<0.1{return 0}
    let count=if active==0{1}else{active.min(60)};
    for i in 0..count {let o=l::EVO_GRAPHICS_EVO_CAR_COORDINATES_BASE+i*12;let x=rf(g,o) as f64;let z=rf(g,o+8) as f64;let dx=x-s.previous[i*3] as f64;let dz=z-s.previous[i*3+2] as f64;let dm=(dx*dx+dz*dz).sqrt();if dm>0.01{s.scores[i]=(s.scores[i] as f64+(vx*dx+vz*dz)/(mag*dm)) as f32 as f64;}s.previous[i*3]=x as f32;s.previous[i*3+2]=z as f32;}
    s.observations+=1;if s.observations<60{return 0}let mut best=0;for i in 1..60{if s.scores[i]>s.scores[best]{best=i}}s.slot=Some(best);best
}
fn integrate(s:&mut EvoDistance,packet:i32,speed:f64,km:f64,_lap:i32)->f64 {
    let delta=if s.previous_km<0.0 {0.0}else{km-s.previous_km};
    if s.previous_km>=0.0&&delta< -0.05 {s.anchor=km*1000.0;s.integral=0.0;s.calibration_integral=0.0;s.calibration_true=0.0;s.output=s.anchor;s.packet=Some(packet);s.speed=speed;s.previous_km=km;return s.output}
    let packet_delta=s.packet.map(|v|packet as i64-v as i64).unwrap_or(0);
    if packet_delta>0&&packet_delta<=10000 {let segment=0.5*(speed+s.speed)*packet_delta as f64;s.integral+=segment;s.calibration_integral+=segment;}
    if delta>0.0 {s.calibration_true+=delta*1000.0;if s.calibration_integral>0.0&&s.calibration_true>=5.0 {let sample=(s.calibration_true/s.calibration_integral).clamp(0.001,0.01);s.seconds_per_step=if s.seconds_per_step==0.0{sample}else{0.8*s.seconds_per_step+0.2*sample};s.calibration_true=0.0;s.calibration_integral=0.0;}s.anchor=km*1000.0;s.integral=0.0;}
    let k=if s.seconds_per_step>0.0{s.seconds_per_step}else{1.0/333.0};let candidate=if s.previous_km<0.0{km*1000.0}else{s.anchor+k*s.integral};s.output=s.output.max(candidate);s.packet=Some(packet);s.speed=speed;s.previous_km=km;s.output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::generated::layouts as l;
    use crate::detection::kunos::KunosDetector;
    use crate::formats::{RecordKind, SourceRecord};

    fn frame(magic: u32, car: i32, track: i32, physics: &[u8], graphics: &[u8], statics: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&magic.to_le_bytes());
        bytes.extend_from_slice(&car.to_le_bytes());
        bytes.extend_from_slice(&track.to_le_bytes());
        for part in [physics, graphics, statics] {
            bytes.extend_from_slice(&(part.len() as u32).to_le_bytes());
            bytes.extend_from_slice(part);
        }
        bytes
    }

    fn put_i(bytes: &mut [u8], offset: usize, value: i32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn put_f(bytes: &mut [u8], offset: usize, value: f32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn put_cstr(bytes: &mut [u8], offset: usize, value: &str) {
        bytes[offset..offset + value.len()].copy_from_slice(value.as_bytes());
    }

    fn compare_records(game: &str, records: impl IntoIterator<Item = SourceRecord>) -> (u64, usize) {
        let mut full_parser = Parser::new(game).unwrap();
        let mut typed_parser = Parser::new(game).unwrap();
        let mut full_detector = KunosDetector::new(game).unwrap();
        let mut typed_detector = KunosDetector::new(game).unwrap();
        let mut accepted = 0;
        let mut appends = 0;
        for record in records {
            if record.kind == RecordKind::Segment {
                full_parser.reset();
                typed_parser.reset();
                assert_eq!(full_detector.finish("segment-boundary"), typed_detector.finish("segment-boundary"));
                full_detector.reset();
                typed_detector.reset();
                continue;
            }
            let time = record.time_ms.unwrap_or(0);
            let full = full_parser.feed(&record.payload, time).unwrap();
            let typed = typed_parser.feed_for_detection(&record.payload, time).unwrap();
            assert_eq!(full.is_some(), typed.is_some(), "cadence at {}", record.offset);
            if let (Some(full), Some(typed)) = (full, typed) {
                assert_eq!(typed.snapshot.sample, Sample::from_value(&full, 0), "sample at {}", record.offset);
                assert_eq!(typed.materialize(), full, "complete presentation at {}", record.offset);
                assert_eq!(typed.materialize(), full, "repeat materialization at {}", record.offset);
                if record.kind == RecordKind::Frame {
                    accepted += 1;
                    let full_events = full_detector.feed_at(full, record.offset, time).unwrap();
                    let typed_events = typed_detector.feed_typed(typed.snapshot, record.offset, time, || typed.materialize()).unwrap();
                    assert_eq!(typed_events, full_events, "ordered events/identity/recipes/full appends at {}", record.offset);
                    for event in typed_events {
                        appends += event["data"]["analysisRecipe"]["appendPackets"].as_array().map_or(0, Vec::len);
                    }
                }
            }
            assert_eq!(full_detector.tick(time), typed_detector.tick(time), "inactivity at {}", record.offset);
        }
        assert_eq!(full_detector.finish("import-eof"), typed_detector.finish("import-eof"));
        (accepted, appends)
    }

    #[test]
    fn typed_acc_projection_preserves_optional_validity_and_nonfinite_numbers() {
        let mut parser = Parser::new("acc").unwrap();
        let physics = vec![0; l::ACC_PHYSICS_SIZE];
        let statics = vec![0; l::ACC_STATIC_SIZE];
        for size in [l::ACC_GRAPHICS_MIN_SIZE, l::ACC_GRAPHICS_IS_VALID_LAP + 4] {
            let mut graphics = vec![0; size];
            put_i(&mut graphics, l::ACC_GRAPHICS_I_CURRENT_TIME, i32::MAX);
            put_i(&mut graphics, l::ACC_GRAPHICS_I_LAST_TIME, -1);
            put_f(&mut graphics, l::ACC_GRAPHICS_DISTANCE_TRAVELED, f32::INFINITY);
            put_f(&mut graphics, l::ACC_GRAPHICS_CAR_COORDINATES_BASE, f32::NAN);
            if size >= l::ACC_GRAPHICS_IS_VALID_LAP + 4 {
                put_i(&mut graphics, l::ACC_GRAPHICS_IS_VALID_LAP, 2);
            }
            let bytes = frame(ACC_MAGIC, 71, 92, &physics, &graphics, &statics);
            let input = parser.feed_for_detection(&bytes, 123).unwrap().unwrap();
            let full = input.materialize();
            assert_eq!(input.snapshot.sample, Sample::from_value(&full, 0));
            assert_eq!(input.snapshot.sample.acc_valid, None);
            assert_eq!(input.snapshot.sample.distance, 0.0);
            assert_eq!(full["DistanceTraveled"], Value::Null);
        }
    }

    #[test]
    fn evo_borrowed_static_identity_distance_and_slot_advance_once() {
        let mut parser = Parser::new("ac-evo").unwrap();
        let mut physics = vec![0; l::EVO_PHYSICS_SIZE];
        let mut graphics = vec![0; l::EVO_GRAPHICS_EVO_SIZE];
        let mut statics = vec![0; l::EVO_STATIC_EVO_SIZE];
        put_i(&mut graphics, l::EVO_GRAPHICS_EVO_STATUS, 2);
        put_i(&mut graphics, l::EVO_GRAPHICS_EVO_CAR_LOCATION, 2);
        graphics[l::EVO_GRAPHICS_EVO_ACTIVE_CARS] = 2;
        graphics[l::EVO_GRAPHICS_EVO_IS_VALID_LAP] = 1;
        put_f(&mut physics, l::EVO_PHYSICS_SPEED_KMH, 36.0);
        put_f(&mut physics, l::EVO_PHYSICS_VELOCITY_X, 10.0);
        put_cstr(&mut graphics, l::EVO_GRAPHICS_EVO_CAR_MODEL, "unlisted-model");
        put_cstr(&mut statics, l::EVO_STATIC_EVO_TRACK, "unlisted-track");
        put_cstr(&mut statics, l::EVO_STATIC_EVO_SESSION_NAME, "first-session");
        let initial = frame(EVO_MAGIC, 7, 9, &physics, &graphics, &statics);
        {
            let input = parser.feed_for_detection(&initial, 0).unwrap().unwrap();
            assert_eq!(input.snapshot.car_ordinal, -1.0);
            assert_eq!(input.materialize()["carModelName"], "unlisted-model");
        }
        let retained_ptr = parser.last_static.as_ptr();
        for index in 1..60 {
            put_i(&mut physics, l::EVO_PHYSICS_PACKET_ID, index);
            put_f(&mut graphics, l::EVO_GRAPHICS_EVO_CAR_COORDINATES_BASE, -(index as f32));
            put_f(&mut graphics, l::EVO_GRAPHICS_EVO_CAR_COORDINATES_BASE + 12, index as f32);
            let bytes = frame(EVO_MAGIC, 7, 9, &physics, &graphics, &[]);
            let input = parser.feed_for_detection(&bytes, index as u64).unwrap().unwrap();
            assert_eq!(input.statics.as_ptr(), retained_ptr, "omitted statics must borrow cache");
            let packet = input.materialize();
            assert_eq!(input.materialize(), packet);
            assert_eq!(packet["acc"]["acEvo"]["sessionName"], "first-session");
            assert_eq!(input.snapshot.sample, Sample::from_value(&packet, 0));
            if index == 59 {
                assert_eq!(packet["PositionX"], 59.0);
                assert_eq!(packet["DistanceTraveled"], (1.0 / 333.0) * 590.0);
            }
        }
        assert_eq!(parser.evo_slot.observations, 60);
        assert_eq!(parser.evo_slot.slot, Some(1));
        put_cstr(&mut statics, l::EVO_STATIC_EVO_SESSION_NAME, "other-session");
        put_i(&mut graphics, l::EVO_GRAPHICS_EVO_STATUS, 1);
        let menu = frame(EVO_MAGIC, 7, 9, &physics, &graphics, &statics);
        assert!(parser.feed_for_detection(&menu, 100).unwrap().is_none());
        put_i(&mut graphics, l::EVO_GRAPHICS_EVO_STATUS, 2);
        let resumed = frame(EVO_MAGIC, 7, 9, &physics, &graphics, &[]);
        assert_eq!(parser.feed(&resumed, 101).unwrap().unwrap()["acc"]["acEvo"]["sessionName"], "other-session");
        parser.reset();
        assert!(parser.feed_for_detection(&resumed, 102).unwrap().is_none());
    }

    #[test]
    fn malformed_kunos_frames_leave_cadence_and_retained_state_unchanged() {
        for game in ["acc", "ac-evo"] {
            let mut parser = Parser::new(game).unwrap();
            for bytes in [&[][..], &[0; 12][..], &[0; 24][..]] {
                assert!(parser.feed_for_detection(bytes, 0).unwrap().is_none());
            }
            let magic = if game == "acc" { ACC_MAGIC } else { EVO_MAGIC };
            let physics = vec![0; if game == "acc" { l::ACC_PHYSICS_SIZE } else { l::EVO_PHYSICS_SIZE }];
            let mut graphics = vec![0; if game == "acc" { l::ACC_GRAPHICS_MIN_SIZE } else { l::EVO_GRAPHICS_EVO_SIZE }];
            let statics = vec![0; if game == "acc" { l::ACC_STATIC_SIZE } else { l::EVO_STATIC_EVO_SIZE }];
            put_i(&mut graphics, if game == "acc" { l::ACC_GRAPHICS_STATUS } else { l::EVO_GRAPHICS_EVO_STATUS }, 2);
            let valid = frame(magic, 7, 9, &physics, &graphics, &statics);
            assert!(parser.feed_for_detection(&valid, 1).unwrap().is_some());
            let short_static = frame(magic, 7, 9, &physics, &graphics, &[0]);
            assert!(parser.feed_for_detection(&short_static, 2).unwrap().is_none());
            assert!(parser.feed_for_detection(&valid[..valid.len() - 1], 3).unwrap().is_none());
            let short_physics = frame(magic, 7, 9, &physics[..physics.len() - 1], &graphics, &statics);
            assert!(parser.feed_for_detection(&short_physics, 4).unwrap().is_none());
            let omitted = frame(magic, 7, 9, &physics, &graphics, &[]);
            assert_eq!(parser.feed_for_detection(&omitted, 5).unwrap().is_some(), game == "ac-evo");
            parser.reset();
            assert!(parser.feed_for_detection(&omitted, 6).unwrap().is_none());
        }
    }

    #[test]
    fn typed_kunos_transition_streams_match_complete_full_events() {
        for game in ["acc", "ac-evo"] {
            let mut physics = vec![0; if game == "acc" { l::ACC_PHYSICS_SIZE } else { l::EVO_PHYSICS_SIZE }];
            let mut graphics = vec![0; if game == "acc" { l::ACC_GRAPHICS_IS_VALID_LAP + 4 } else { l::EVO_GRAPHICS_EVO_SIZE }];
            let statics = vec![0; if game == "acc" { l::ACC_STATIC_SIZE } else { l::EVO_STATIC_EVO_SIZE }];
            let mut records = Vec::new();
            for index in 0..95 {
                let lap = index / 40;
                let current = (index % 40) * 1000;
                if game == "acc" {
                    put_i(&mut graphics, l::ACC_GRAPHICS_STATUS, 2);
                    put_i(&mut graphics, l::ACC_GRAPHICS_COMPLETED_LAPS, lap);
                    put_i(&mut graphics, l::ACC_GRAPHICS_I_CURRENT_TIME, current);
                    put_i(&mut graphics, l::ACC_GRAPHICS_I_LAST_TIME, if lap > 0 { 40_000 } else { 0 });
                    put_f(&mut graphics, l::ACC_GRAPHICS_DISTANCE_TRAVELED, index as f32 * 20.0);
                    put_i(&mut graphics, l::ACC_GRAPHICS_IS_VALID_LAP, 1);
                } else {
                    put_i(&mut graphics, l::EVO_GRAPHICS_EVO_STATUS, 2);
                    put_i(&mut graphics, l::EVO_GRAPHICS_EVO_CAR_LOCATION, 2);
                    put_i(&mut graphics, l::EVO_GRAPHICS_EVO_TOTAL_LAP_COUNT, lap);
                    put_i(&mut graphics, l::EVO_GRAPHICS_EVO_CURRENT_LAP_TIME_MS, current);
                    put_i(&mut graphics, l::EVO_GRAPHICS_EVO_LAST_LAPTIME_MS, if lap > 0 { 40_000 } else { 0 });
                    put_f(&mut graphics, l::EVO_GRAPHICS_EVO_CURRENT_KM, index as f32 * 0.02);
                    put_i(&mut physics, l::EVO_PHYSICS_PACKET_ID, index);
                    graphics[l::EVO_GRAPHICS_EVO_IS_VALID_LAP] = 1;
                }
                records.push(SourceRecord {
                    offset: 12 + index as u64 * 1000, time_ms: Some(index as u64 * 1000), kind: RecordKind::Frame,
                    payload: frame(if game == "acc" { ACC_MAGIC } else { EVO_MAGIC }, 7, 9,
                        &physics, &graphics, if game == "ac-evo" && index > 0 { &[] } else { &statics }),
                });
            }
            assert_eq!(compare_records(game, records), (95, 2));
        }
    }

    #[test]
    #[ignore = "complete canonical ACC/AC Evo equivalence; run explicitly in release mode"]
    fn canonical_kunos_fixtures_typed_full_equivalence() {
        use std::io::Read;
        for (game, fixture) in [
            ("acc", "acc-2026-04-23T16-42-16-158Z.bin.gz"),
            ("ac-evo", "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz"),
        ] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/artifacts/sessions").join(fixture);
            let mut bytes = Vec::new();
            flate2::read::MultiGzDecoder::new(std::fs::File::open(path).expect("canonical Kunos capture"))
                .read_to_end(&mut bytes).unwrap();
            let records = crate::formats::read_capture_bytes(&bytes).unwrap();
            compare_records(game, records);
        }
    }

    #[test]
    fn acc_identity_changes_and_unknown_name_fallback_follow_current_packet() {
        let mut parser = Parser::new("acc").unwrap();
        let physics = vec![0; l::ACC_PHYSICS_SIZE];
        let graphics = vec![0; l::ACC_GRAPHICS_MIN_SIZE];
        let scenarios = [
            ("porsche_991_gt3_r", "monza", 70, 90, 0, 0),
            ("mercedes_amg_gt3", "monza", 70, 90, 1, 0),
            ("mercedes_amg_gt3", "zolder", 70, 90, 1, 1),
            ("unknown-car", "zolder", 70, 90, 70, 1),
            ("unknown-car", "zolder", 71, 90, 71, 1),
            ("mercedes_amg_gt3", "unknown-track", 70, 91, 1, 91),
            ("mercedes_amg_gt3", "unknown-track", 70, 92, 1, 92),
            ("porsche_991_gt3_r", "monza", 70, 90, 0, 0),
        ];
        for (model, track, source_car, source_track, expected_car, expected_track) in scenarios {
            let mut statics = vec![0; l::ACC_STATIC_SIZE];
            for (offset, name) in [(l::ACC_STATIC_CAR_MODEL, model), (l::ACC_STATIC_TRACK, track)] {
                for (index, unit) in name.encode_utf16().enumerate() {
                    statics[offset + index * 2..offset + index * 2 + 2].copy_from_slice(&unit.to_le_bytes());
                }
            }
            let frame = frame(ACC_MAGIC, source_car, source_track, &physics, &graphics, &statics);
            let packet = parser.feed(&frame, 0).unwrap().unwrap();
            assert_eq!(packet["CarOrdinal"], expected_car, "{model}");
            assert_eq!(packet["TrackOrdinal"], expected_track, "{track}");
        }
    }
}
