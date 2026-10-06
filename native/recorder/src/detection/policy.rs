use serde_json::Value;

pub fn number(packet: &Value, key: &str) -> f64 {
    packet.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}
fn nested<'a>(packet: &'a Value, object: &str, key: &str) -> Option<&'a Value> {
    packet.get(object).and_then(|v| v.get(key))
}

/// Only fields needed while an ordinal lap is being collected. No presentation
/// telemetry, identity trees, or per-frame allocations survive conversion.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub offset: u64,
    pub lap_number: f64,
    pub current_lap: f64,
    pub last_lap: f64,
    pub distance: f64,
    pub position_x: f64,
    pub position_z: f64,
    pub fuel: f64,
    pub tire_wear: [f64; 4],
    pub is_forza: bool,
    pub is_acc: bool,
    pub pit_state: Option<bool>,
    pub lmu_invalidated: bool,
    pub acc_valid: Option<bool>,
}
impl Sample {
    pub fn from_value(p: &Value, offset: u64) -> Self {
        let game = p.get("gameId").and_then(Value::as_str).unwrap_or("");
        let pit_state = match game {
            "iracing" => nested(p,"iracing","onPitRoad").and_then(Value::as_bool),
            "lmu" => nested(p,"lmu","inPits").and_then(Value::as_bool),
            // Preserve integer-only conversion. F1 presentation JSON currently
            // writes this field as a floating-point number, not an integer.
            "f1-2025" => nested(p,"f1","pitLaneTimerActive").and_then(Value::as_i64).map(|v|v==1),
            "acc" | "ac-evo" => nested(p,"acc","pitStatus").and_then(Value::as_str).map(|v|v!="out"),
            _ => None,
        };
        Self {
            offset, lap_number: number(p,"LapNumber"), current_lap: number(p,"CurrentLap"),
            last_lap: number(p,"LastLap"), distance: number(p,"DistanceTraveled"),
            position_x: number(p,"PositionX"), position_z: number(p,"PositionZ"),
            fuel: if game=="fm-2023" { number(p,"Fuel") } else { 0. },
            tire_wear: if game=="fm-2023" { [number(p,"TireWearFL"),number(p,"TireWearFR"),number(p,"TireWearRL"),number(p,"TireWearRR")] } else { [0.;4] },
            is_forza: game=="fm-2023", is_acc: game=="acc", pit_state,
            lmu_invalidated: nested(p,"lmu","lapInvalidated").and_then(Value::as_bool)==Some(true),
            acc_valid: nested(p,"acc","isValidLap").and_then(Value::as_bool),
        }
    }
}

pub fn quality(samples: &[Sample], lap_time: f64) -> Option<&'static str> {
    if samples.len() < 30 { return Some("too few telemetry packets"); }
    let first = &samples[0];
    let last = &samples[samples.len()-1];
    if last.distance - first.distance < 100. { return Some("telemetry distance too short"); }
    let peak = samples.iter().map(|p|p.current_lap).fold(f64::NEG_INFINITY, f64::max);
    if peak > 0. && (peak-lap_time).abs() > 2. { return Some("telemetry lap time mismatch"); }
    if first.is_acc && first.lap_number==0. && lap_time<30. { return Some("starting lap"); }
    if !first.is_acc {
        let dx=last.position_x-first.position_x; let dz=last.position_z-first.position_z;
        if (dx*dx+dz*dz).sqrt()>20. { return Some("start/end positions too far apart"); }
    }
    None
}
pub fn pit_reason(samples: &[Sample]) -> Option<&'static str> {
    let first=samples.first()?; let last=samples.last()?;
    let start=first.pit_state; let end=last.pit_state;
    let any=samples.iter().any(|p|p.pit_state==Some(true));
    if start.is_none() && end.is_none() && !samples.iter().any(|p|p.pit_state.is_some()) { return None; }
    if start==Some(true) && end==Some(true) { Some("pit lap") }
    else if end==Some(true) { Some("inlap") }
    else if any { Some("outlap") }
    else { None }
}
pub fn lmu_lap_time(samples: &[Sample], boundary: &Sample) -> f64 {
    if boundary.last_lap>0. { return boundary.last_lap; }
    if samples.len()<=30 { return 0.; }
    samples.iter().map(|p|p.current_lap).fold(0.0,f64::max)
}
pub fn lmu_invalid_reason(samples: &[Sample]) -> Option<&'static str> {
    samples.iter().any(|p|p.lmu_invalidated).then_some("game-invalidated")
}
pub fn lmu_pit_reason(samples: &[Sample], completed: u32) -> Option<&'static str> {
    pit_reason(samples).or_else(||(completed==0).then_some("outlap"))
}
pub fn track_limit(samples: &[Sample]) -> bool {
    if samples.is_empty() || samples[0].acc_valid==Some(false) { return false; }
    let mut consecutive=0;
    for p in samples {
        if p.acc_valid==Some(false) { consecutive+=1; if consecutive>=2{return true;} }
        else { consecutive=0; }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conversion_preserves_missing_and_numeric_types() {
        assert_eq!(Sample::from_value(&json!({}), 41), Sample { offset:41, ..Sample::default() });
        let float = json!({"gameId":"f1-2025","f1":{"pitLaneTimerActive":1.0}});
        let integer = json!({"gameId":"f1-2025","f1":{"pitLaneTimerActive":1}});
        assert_eq!(Sample::from_value(&float, 0).pit_state, None);
        assert_eq!(Sample::from_value(&integer, 0).pit_state, Some(true));
        assert_eq!(Sample::from_value(&json!({"gameId":"lmu","lmu":{"inPits":false,"lapInvalidated":true}}),0).pit_state,Some(false));
    }

    #[test]
    fn quality_thresholds_and_lmu_policy_order() {
        let mut samples=vec![Sample { current_lap:12., ..Sample::default() };30];
        samples[29].distance=100.; samples[29].position_x=20.;
        assert_eq!(quality(&samples,10.),None);
        samples[29].position_x=20.001;
        assert_eq!(quality(&samples,10.),Some("start/end positions too far apart"));
        samples[29].distance=99.999;
        assert_eq!(quality(&samples,10.),Some("telemetry distance too short"));
        assert_eq!(quality(&samples[..29],10.),Some("too few telemetry packets"));
        samples[29].distance=100.;samples[29].current_lap=12.001;
        assert_eq!(quality(&samples,10.),Some("telemetry lap time mismatch"));
        assert_eq!(lmu_lap_time(&samples,&Sample::default()),0.);
        samples.push(Sample {current_lap:15.,..Sample::default()});
        assert_eq!(lmu_lap_time(&samples,&Sample::default()),15.);
        assert_eq!(lmu_lap_time(&samples,&Sample {last_lap:14.,..Sample::default()}),14.);
        assert_eq!(lmu_pit_reason(&samples,0),Some("outlap"));
        samples[0].pit_state=Some(true); samples[30].pit_state=Some(true);
        assert_eq!(lmu_pit_reason(&samples,0),Some("pit lap"));
        samples[1].lmu_invalidated=true;
        assert_eq!(lmu_invalid_reason(&samples),Some("game-invalidated"));
        samples[1].acc_valid=Some(false); samples[2].acc_valid=Some(false);
        assert!(track_limit(&samples));
        samples[0].acc_valid=Some(false);
        assert!(!track_limit(&samples));
    }

    #[test]
    fn pit_start_end_and_interior_states() {
        let mut samples=[Sample::default();3];
        assert_eq!(pit_reason(&samples),None);
        samples[2].pit_state=Some(true);
        assert_eq!(pit_reason(&samples),Some("inlap"));
        samples[0].pit_state=Some(true);
        assert_eq!(pit_reason(&samples),Some("pit lap"));
        samples[2].pit_state=Some(false);
        assert_eq!(pit_reason(&samples),Some("outlap"));
        samples[0].pit_state=Some(false);samples[1].pit_state=Some(true);
        assert_eq!(pit_reason(&samples),Some("outlap"));
        samples[1].pit_state=None;
        assert_eq!(pit_reason(&samples),None);
    }
}
