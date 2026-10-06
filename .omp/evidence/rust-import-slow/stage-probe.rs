use std::{io::Read, time::{Duration, Instant}};
use raceiq_recorder::{formats::{RecordKind, read_capture_bytes}, games::GameParser, detection::Detector};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let bytes = std::fs::read(&args[1])?;
    let start = Instant::now();
    let mut plain = Vec::new();
    flate2::read::MultiGzDecoder::new(bytes.as_slice()).read_to_end(&mut plain)?;
    let decompress = start.elapsed();
    let start = Instant::now();
    let records = read_capture_bytes(&plain)?;
    let decode = start.elapsed();
    let record_count = records.len();
    let mut parser = GameParser::new(&args[2])?;
    let mut detector = Detector::new(&args[2])?;
    let mut parse = Duration::ZERO;
    let mut detect = Duration::ZERO;
    let mut emitted = 0usize;
    let mut laps = Vec::new();
    let mut by_id = [0usize; 256];
    let mut dimensions = serde_json::Value::Null;
    let process_start = Instant::now();
    for record in records {
        if record.kind == RecordKind::Segment { parser.reset(); detector.reset(); continue; }
        if record.payload.is_empty() { continue; }
        let start = Instant::now();
        let packet = parser.feed(&record.payload, record.time_ms.unwrap_or(0))?;
        parse += start.elapsed();
        if record.kind != RecordKind::Frame { continue; }
        if let Some(packet) = packet {
            emitted += 1;
            if args[2] == "f1-2025" { by_id[record.payload[6] as usize] += 1; }
            if emitted == 10000 {
                let f1 = packet.get("f1");
                dimensions = serde_json::json!({"topFields": packet.as_object().map(|v| v.len()), "f1Fields": f1.and_then(|v|v.as_object()).map(|v|v.len()), "gridRows": f1.and_then(|v|v.get("grid")).and_then(|v|v.as_array()).map(|v|v.len())});
            }
            let start = Instant::now();
            let events = detector.feed(packet, record.offset)?;
            detect += start.elapsed();
            for event in events { if event["kind"] == "LAP_RECORDED" { laps.push(event["data"].clone()); } }
        }
    }
    let start = Instant::now();
    let events = detector.finish("import-eof")?;
    detect += start.elapsed();
    for event in events { if event["kind"] == "LAP_RECORDED" { laps.push(event["data"].clone()); } }
    println!("{}", serde_json::json!({"decompressSeconds":decompress.as_secs_f64(),"decodeSeconds":decode.as_secs_f64(),"parseSeconds":parse.as_secs_f64(),"detectSeconds":detect.as_secs_f64(),"processSeconds":process_start.elapsed().as_secs_f64(),"records":record_count,"packets":emitted,"emittedByPacketId":by_id.iter().enumerate().filter(|(_,n)|**n>0).collect::<Vec<_>>(),"dimensions":dimensions,"laps":laps.iter().map(|v|serde_json::json!({"lapNumber":v["lapNumber"],"lapTime":v["lapTime"],"isValid":v["isValid"],"rawFrameCount":v["rawFrameCount"]})).collect::<Vec<_>>()}));
    Ok(())
}
