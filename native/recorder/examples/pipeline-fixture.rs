use base64::Engine;
use raceiq_recorder::{detection::Detector, games::GameParser};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, Write};

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "gameId")]
    game_id: String,
    records: Vec<Record>,
}
#[derive(Deserialize)]
struct Record {
    kind: String,
    #[serde(rename = "payloadBase64")]
    payload_base64: Option<String>,
    #[serde(rename = "timeMs")]
    time_ms: Option<u64>,
    offset: u64,
}

fn capture(request: Request) -> Result<Value, String> {
    let mut parser = GameParser::new(&request.game_id)?;
    let mut packets = Vec::new();
    let mut chunks: Vec<Vec<(Value, u64, u64)>> = Vec::new();
    let mut chunk = Vec::new();
    let mut frame_index = 0usize;
    for record in request.records {
        if record.kind == "segment" {
            parser.reset();
            if !chunk.is_empty() { chunks.push(std::mem::take(&mut chunk)); }
            continue;
        }
        if !matches!(record.kind.as_str(), "frame" | "context") { return Err(format!("invalid record kind: {}", record.kind)); }
        let encoded = record.payload_base64.ok_or("record missing payloadBase64")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        let packet = parser.feed(&bytes, record.time_ms.unwrap_or(0))?;
        if record.kind == "frame" {
            if let Some(packet) = packet {
                packets.push(json!({"frameIndex": frame_index, "recordOffset": record.offset, "packet": packet}));
                chunk.push((packet, record.offset, record.time_ms.unwrap_or(0)));
                if chunk.len() == 500 { chunks.push(std::mem::take(&mut chunk)); }
            }
            frame_index += 1;
        }
    }
    if !chunk.is_empty() { chunks.push(chunk); }
    let mut events = Vec::new();
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let mut detector = Detector::new(&request.game_id)?;
        for (packet_index, (packet, offset, time_ms)) in chunk.iter().enumerate() {
            for event in detector.feed_ref_at(packet, *offset, *time_ms)? {
                events.push(json!({"chunkIndex": chunk_index, "packetIndex": packet_index, "event": event}));
            }
        }
        for event in detector.finish("benchmark-chunk")? {
            events.push(json!({"chunkIndex": chunk_index, "finish": true, "event": event}));
        }
    }
    Ok(json!({"gameId": request.game_id, "packets": packets, "events": events}))
}

fn main() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let result = line.map_err(|e| e.to_string()).and_then(|line| {
            let request = serde_json::from_str::<Request>(&line).map_err(|e| e.to_string())?;
            capture(request)
        }).unwrap_or_else(|error| json!({"error": error}));
        serde_json::to_writer(&mut stdout, &result).map_err(|e| e.to_string())?;
        stdout.write_all(b"\n").map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
