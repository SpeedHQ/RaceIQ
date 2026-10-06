use serde_json::{Map, Number, Value};
use super::generated::layouts as layout;

pub struct ForzaParser;
impl ForzaParser {
    pub fn reset(&mut self) {}
    pub fn feed(&mut self, b: &[u8]) -> Result<Option<Value>, String> {
        if b.len() < 324 { return Ok(None); }
        let race_on = i32le(b, layout::FM_PACKET_IS_RACE_ON)?;
        if race_on == 0 { return Ok(None); }
        let mut p = Map::with_capacity(96);
        p.insert("gameId".into(), Value::String("fm-2023".into()));
        put_i(&mut p, "IsRaceOn", race_on as i64);
        put_i(&mut p, "TimestampMS", u32le(b, layout::FM_PACKET_TIMESTAMP_MS)? as i64);
        for &(k,o) in layout::FM_PACKET_FLOAT_FIELDS { put_f(&mut p,k,f32le(b,o)? as f64); }
        for &(k,o) in layout::FM_PACKET_INT32_FIELDS { put_i(&mut p,k,i32le(b,o)? as i64); }
        put_i(&mut p,"LapNumber",u16le(b,layout::FM_PACKET_LAP_NUMBER)? as i64);
        put_i(&mut p,"RacePosition",b[layout::FM_PACKET_RACE_POSITION] as i64);
        for (k,o) in [("Accel",layout::FM_PACKET_ACCEL),("Brake",layout::FM_PACKET_BRAKE),("Clutch",layout::FM_PACKET_CLUTCH),("HandBrake",layout::FM_PACKET_HAND_BRAKE),("Gear",layout::FM_PACKET_GEAR)] { put_i(&mut p,k,b[o] as i64); }
        put_i(&mut p,"Steer",b[layout::FM_PACKET_STEER] as i8 as i64);
        put_i(&mut p,"NormDrivingLine",b[layout::FM_PACKET_NORM_DRIVING_LINE] as i8 as i64);
        put_i(&mut p,"NormAIBrakeDiff",b[layout::FM_PACKET_NORM_AIBRAKE_DIFF] as i8 as i64);
        for (k,o) in [("TireWearFL",layout::FM_PACKET_TIRE_WEAR_FL),("TireWearFR",layout::FM_PACKET_TIRE_WEAR_FR),("TireWearRL",layout::FM_PACKET_TIRE_WEAR_RL),("TireWearRR",layout::FM_PACKET_TIRE_WEAR_RR)] { put_f(&mut p,k,if b.len() >= 331 {f32le(b,o)? as f64} else {-1.0}); }
        put_i(&mut p,"TrackOrdinal",if b.len() >= 331 { i32le(b,layout::FM_PACKET_TRACK_ORDINAL)? as i64 } else { 0 });
        Ok(Some(Value::Object(p)))
    }
}
fn put_i(m:&mut Map<String,Value>,k:&str,v:i64){m.insert(k.into(),Value::Number(v.into()));}
fn put_f(m:&mut Map<String,Value>,k:&str,v:f64){m.insert(k.into(),Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null));}
fn i32le(b:&[u8],o:usize)->Result<i32,String>{let s=b.get(o..o+4).ok_or("short Forza packet")?; Ok(i32::from_le_bytes(s.try_into().unwrap()))}
fn u32le(b:&[u8],o:usize)->Result<u32,String>{let s=b.get(o..o+4).ok_or("short Forza packet")?; Ok(u32::from_le_bytes(s.try_into().unwrap()))}
fn u16le(b:&[u8],o:usize)->Result<u16,String>{let s=b.get(o..o+2).ok_or("short Forza packet")?; Ok(u16::from_le_bytes(s.try_into().unwrap()))}
fn f32le(b:&[u8],o:usize)->Result<f32,String>{Ok(f32::from_bits(u32le(b,o)?))}
