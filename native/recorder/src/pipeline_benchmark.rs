use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::hint::black_box;
use std::io::{BufRead, Write};
use std::time::Instant;

const MAX_TRIALS: u64 = 100;
const MAX_CHUNK_PACKETS: u64 = 500;

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "gameId")]
    game_id: String,
    records: Vec<Record>,
    trials: u64,
    #[serde(rename = "chunkPackets")]
    chunk_packets: u64,
    #[serde(default, rename = "memoryProfile")]
    memory_profile: bool,
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
struct Prepared {
    kind: String,
    bytes: Vec<u8>,
    time_ms: u64,
    offset: u64,
}

fn benchmark(req: Request) -> Result<Value, String> {
    #[cfg(not(feature = "benchmark-memory"))]
    if req.memory_profile { return Err("memoryProfile requires benchmark-memory executable".into()); }
    if req.trials == 0 || req.trials > MAX_TRIALS { return Err("trials must be between 1 and 100".into()); }
    if req.chunk_packets == 0 || req.chunk_packets > MAX_CHUNK_PACKETS { return Err("chunkPackets must be between 1 and 500".into()); }
    if req.records.is_empty() { return Err("records must not be empty".into()); }
    let mut source_frames = 0u64;
    let records = req.records.into_iter().map(|r| {
        if !matches!(r.kind.as_str(), "frame" | "context" | "segment") { return Err(format!("invalid record kind: {}", r.kind)); }
        let bytes = match (r.kind.as_str(), r.payload_base64) {
            ("segment", None) => Vec::new(),
            ("segment", Some(_)) => return Err("segment record must not have payloadBase64".into()),
            (_, Some(encoded)) => base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| format!("invalid payloadBase64: {e}"))?,
            (_, None) => return Err(format!("{} record requires payloadBase64", r.kind)),
        };
        if r.kind == "frame" { source_frames += 1; }
        Ok(Prepared { kind: r.kind, bytes, time_ms: r.time_ms.unwrap_or(0), offset: r.offset })
    }).collect::<Result<Vec<_>, String>>()?;
    if records.iter().any(|r| r.kind != "segment" && r.bytes.is_empty()) {
        return Err("frame/context payloads must not be empty".into());
    }
    if source_frames == 0 { return Err("records contain no source frames".into()); }

    let parse_once = || -> Result<u64, String> {
        let mut parser = crate::games::GameParser::new(&req.game_id)?;
        let mut accepted = 0u64;
        for r in &records {
            if r.kind == "segment" {
                parser.reset();
            } else if let Some(packet) = parser.feed(&r.bytes, r.time_ms)? {
                black_box(packet);
                if r.kind == "frame" { accepted += 1; }
            }
        }
        Ok(accepted)
    };
    let warm_parse = parse_once()?;
    if warm_parse == 0 { return Err("parser accepted zero source frames".into()); }
    let mut parse_samples = Vec::with_capacity(req.trials as usize);
    let mut accepted_packets = warm_parse;
    for _ in 0..req.trials {
        let mut parser = crate::games::GameParser::new(&req.game_id)?;
        let started = Instant::now();
        let mut accepted = 0u64;
        for r in &records {
            if r.kind == "segment" {
                parser.reset();
            } else if let Some(packet) = parser.feed(&r.bytes, r.time_ms)? {
                black_box(packet);
                if r.kind == "frame" { accepted += 1; }
            }
        }
        let elapsed = started.elapsed().as_secs_f64();
        if accepted == 0 { return Err("parser accepted zero source frames".into()); }
        if accepted != warm_parse { return Err("parser accepted packet count changed between trials".into()); }
        accepted_packets = accepted;
        parse_samples.push(json!({"elapsedSeconds":elapsed,"acceptedPackets":accepted}));
    }

    // Prepare full presentation packets and split on segment boundaries/size before processing timers.
    let mut parser = crate::games::GameParser::new(&req.game_id)?;
    let mut chunks: Vec<Vec<(Value, u64, u64)>> = Vec::new();
    let mut chunk = Vec::new();
    for r in &records {
        if r.kind == "segment" {
            parser.reset();
            if !chunk.is_empty() { chunks.push(std::mem::take(&mut chunk)); }
        } else if let Some(packet) = parser.feed(&r.bytes, r.time_ms)? {
            if r.kind == "frame" { chunk.push((packet, r.offset, r.time_ms)); }
            if chunk.len() == req.chunk_packets as usize { chunks.push(std::mem::take(&mut chunk)); }
        }
    }
    if !chunk.is_empty() { chunks.push(chunk); }
    let prepared_count: u64 = chunks.iter().map(|c| c.len() as u64).sum();
    if prepared_count == 0 { return Err("no usable packets for pipeline stage".into()); }
    if prepared_count != accepted_packets { return Err("prepared packet count differs from parser stage".into()); }

    fn make_detectors(game_id: &str, count: usize) -> Result<Vec<crate::detection::Detector>, String> {
        (0..count).map(|_| crate::detection::Detector::new(game_id)).collect()
    }
    fn pipeline_once(
        chunks: &[Vec<(Value, u64, u64)>],
        detectors: Vec<crate::detection::Detector>,
    ) -> Result<(u64, u64, Option<crate::detection::Detector>), String> {
        let mut processed = 0u64;
        let mut events = 0u64;
        let mut retained = None;
        for (packets, mut detector) in chunks.iter().zip(detectors) {
            // Only the current chunk may retain a completed lap buffer.
            drop(retained.take());
            for (packet, offset, time_ms) in packets {
                let output = detector.feed_ref_at(packet, *offset, *time_ms)?;
                events += output.len() as u64;
                black_box(output);
                processed += 1;
            }
            let output = detector.finish("benchmark-chunk")?;
            events += output.len() as u64;
            black_box(output);
            retained = Some(detector);
        }
        Ok((processed, events, retained))
    }
    let warm_detectors = make_detectors(&req.game_id, chunks.len())?;
    let warm_pipeline = pipeline_once(&chunks, warm_detectors)?;
    drop(warm_pipeline.2);
    if warm_pipeline.0 == 0 { return Err("pipeline processed zero packets".into()); }
    let mut pipeline_samples = Vec::with_capacity(req.trials as usize);
    let mut expected_events = warm_pipeline.1;
    for _ in 0..req.trials {
        let detectors = make_detectors(&req.game_id, chunks.len())?;
        let started = Instant::now();
        let result = pipeline_once(&chunks, detectors)?;
        let elapsed = started.elapsed().as_secs_f64();
        if result.0 != prepared_count { return Err("pipeline processed packet count changed".into()); }
        if result.1 != expected_events { return Err("pipeline event count changed between reset trials".into()); }
        expected_events = result.1;
        pipeline_samples.push(json!({"elapsedSeconds":elapsed,"processedPackets":result.0,"eventCount":result.1}));
    }
    let mut response = json!({"parse":parse_samples,"pipeline":pipeline_samples,"sourceFrames":source_frames,"acceptedPackets":accepted_packets});
    if req.memory_profile {
        #[cfg(not(feature = "benchmark-memory"))]
        return Err("memoryProfile requires benchmark-memory executable".into());
        #[cfg(feature = "benchmark-memory")]
        {
            let mut parse = Vec::with_capacity(3);
            let mut pipeline = Vec::with_capacity(3);
            for _ in 0..3 {
                let scope = crate::memory_accounting::Scope::begin();
                let mut parser = crate::games::GameParser::new(&req.game_id)?;
                let mut accepted = 0u64;
                for record in &records {
                    if record.kind == "segment" {
                        parser.reset();
                    } else if let Some(packet) = parser.feed(&record.bytes, record.time_ms)? {
                        black_box(packet);
                        if record.kind == "frame" { accepted += 1; }
                    }
                }
                let (peak, retained) = scope.finish();
                // Retention includes live parser caches, not only post-drop residue.
                black_box(&parser);
                if accepted != accepted_packets { return Err("parser accepted packet count changed during memory profile".into()); }
                parse.push(json!({"peakAdditionalBytes":peak,"retainedAdditionalBytes":retained}));
            }
            for _ in 0..3 {
                let scope = crate::memory_accounting::Scope::begin();
                let detectors = make_detectors(&req.game_id, chunks.len())?;
                let result = pipeline_once(&chunks, detectors)?;
                let (peak, retained) = scope.finish();
                black_box(&result.2);
                if result.0 != prepared_count || result.1 != expected_events { return Err("pipeline output changed during memory profile".into()); }
                pipeline.push(json!({"peakAdditionalBytes":peak,"retainedAdditionalBytes":retained}));
            }
            fn summary(samples: Vec<Value>) -> Value {
                let mut peaks = samples.iter().map(|v| v["peakAdditionalBytes"].as_u64().unwrap_or(0)).collect::<Vec<_>>();
                let mut retained = samples.iter().map(|v| v["retainedAdditionalBytes"].as_u64().unwrap_or(0)).collect::<Vec<_>>();
                peaks.sort_unstable(); retained.sort_unstable();
                json!({"samples":samples,"peakAdditionalBytes":peaks.last().copied().unwrap_or(0),"retainedAdditionalBytes":retained[retained.len()/2]})
            }
            response["memory"] = json!({"metric":"rust-requested-live-allocation-bytes","parse":summary(parse),"pipeline":summary(pipeline)});
        }
    }
    Ok(response)
}

pub fn stdio() -> Result<(), String> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut output = std::io::BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let response = (|| -> Result<Value, String> {
            let request: Request = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| format!("invalid pipeline benchmark request: {e}"))?;
            benchmark(request)
        })().unwrap_or_else(|error| json!({"error":error}));
        serde_json::to_writer(&mut output, &response).map_err(|e| e.to_string())?;
        output.write_all(b"\n").map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
