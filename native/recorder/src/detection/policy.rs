use serde_json::Value;

pub fn number(packet: &Value, key: &str) -> f64 {
    packet.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}
pub fn nested<'a>(packet: &'a Value, object: &str, key: &str) -> Option<&'a Value> {
    packet.get(object).and_then(|v| v.get(key))
}
pub fn quality(samples: &[&Value], lap_time: f64) -> Option<&'static str> {
    if samples.len() < 30 { return Some("too few telemetry packets"); }
    let first = &samples[0];
    let last = &samples[samples.len()-1];
    if number(last,"DistanceTraveled") - number(first,"DistanceTraveled") < 100. { return Some("telemetry distance too short"); }
    let peak = samples.iter().map(|p| number(p,"CurrentLap")).fold(f64::NEG_INFINITY, f64::max);
    if peak > 0. && (peak-lap_time).abs() > 2. { return Some("telemetry lap time mismatch"); }
    if first.get("gameId").and_then(Value::as_str)==Some("acc") && number(first,"LapNumber")==0. && lap_time<30. { return Some("starting lap"); }
    if first.get("gameId").and_then(Value::as_str)!=Some("acc") {
        let dx=number(last,"PositionX")-number(first,"PositionX"); let dz=number(last,"PositionZ")-number(first,"PositionZ");
        if (dx*dx+dz*dz).sqrt()>20. { return Some("start/end positions too far apart"); }
    }
    None
}
fn pit_state(p: &Value) -> Option<bool> {
    match p.get("gameId").and_then(Value::as_str).unwrap_or("") {
        "iracing" => nested(p,"iracing","onPitRoad")?.as_bool(),
        "lmu" => nested(p,"lmu","inPits")?.as_bool(),
        "f1-2025" => Some(nested(p,"f1","pitLaneTimerActive")?.as_i64()? == 1),
        "acc"|"ac-evo" => Some(nested(p,"acc","pitStatus")?.as_str()? != "out"),
        _ => None,
    }
}
pub fn pit_reason(samples: &[&Value]) -> Option<&'static str> {
    let first=*samples.first()?; let last=*samples.last()?;
    let start=pit_state(first); let end=pit_state(last);
    let any=samples.iter().any(|p|pit_state(p)==Some(true));
    if start.is_none() && end.is_none() && !samples.iter().any(|p|pit_state(p).is_some()) { return None; }
    if start==Some(true) && end==Some(true) { Some("pit lap") }
    else if end==Some(true) { Some("inlap") }
    else if any { Some("outlap") }
    else { None }
}
pub fn lmu_lap_time(samples: &[&Value], boundary: &Value) -> f64 {
    let last=number(boundary,"LastLap");
    if last>0. { return last; }
    if samples.len()<=30 { return 0.; }
    samples.iter().map(|p|number(p,"CurrentLap")).fold(0.0,f64::max)
}
pub fn lmu_invalid_reason(samples: &[&Value]) -> Option<&'static str> {
    samples.iter().any(|p|nested(p,"lmu","lapInvalidated").and_then(Value::as_bool)==Some(true)).then_some("game-invalidated")
}
pub fn lmu_pit_reason(samples: &[&Value], completed: u32) -> Option<&'static str> {
    pit_reason(samples).or_else(||(completed==0).then_some("outlap"))
}
pub fn track_limit(samples: &[&Value]) -> bool {
    if samples.is_empty() || nested(samples[0],"acc","isValidLap").and_then(Value::as_bool)==Some(false) { return false; }
    let mut consecutive=0;
    for p in samples {
        if nested(p,"acc","isValidLap").and_then(Value::as_bool)==Some(false) { consecutive+=1; if consecutive>=2{return true;} }
        else { consecutive=0; }
    }
    false
}
