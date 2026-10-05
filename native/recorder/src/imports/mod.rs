mod capture;
mod archive;
mod ibt;
mod lmu_duckdb;
mod motec;
mod paths;
mod replay;
pub(crate) use paths::output_path;

use serde_json::{Value, json};

/// Execute an isolated import, preview, replay, or capture-format job.
/// Job inputs and outputs are confined to configured staging storage.
pub fn run(operation: &str, input: Value, config: &Value) -> Result<Value, String> {
    match operation {
        "preview" | "import" | "reprocess" => capture::run(operation, input, config),
        "read-capture" | "read-lap-window" => replay::run(operation, input, config),
        "encode-capture" | "encode-lap-slices" => crate::formats::run(operation, input, config),
        _ => Err(format!("Unsupported recorder import operation: {operation}")),
    }
}

/// Process caller-owned capture bytes entirely in memory for benchmarks and tests.
///
/// Reuses production decoding, parsing, and detection; unlike `run("import", ...)`,
/// benchmark operation never constructs a capture writer or persists results.
pub fn benchmark_bytes(bytes: &[u8], game_id: &str) -> Result<Value, String> {
    archive::benchmark_bytes(bytes, game_id)
}

/// Serve line-delimited base64 inputs to an in-memory benchmark caller.
pub fn benchmark_stdio() -> Result<(), String> {
    use base64::Engine;
    use std::io::{BufRead, Write};
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut output = std::io::BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let response = (|| -> Result<Value, String> {
            let request: Value = serde_json::from_str(&line.map_err(|error| error.to_string())?)
                .map_err(|error| format!("Invalid benchmark request: {error}"))?;
            let game_id = request.get("gameId").and_then(Value::as_str).ok_or("Missing gameId")?;
            let encoded = request.get("bytesBase64").and_then(Value::as_str).ok_or("Missing bytesBase64")?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)
                .map_err(|error| format!("Invalid bytesBase64: {error}"))?;
            let started = std::time::Instant::now();
            let result = benchmark_bytes(&bytes, game_id)?;
            Ok(json!({"elapsedSeconds": started.elapsed().as_secs_f64(), "result": result}))
        })()
        .unwrap_or_else(|error| json!({"error": error}));
        serde_json::to_writer(&mut output, &response).map_err(|error| error.to_string())?;
        output.write_all(b"\n").map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn response(job_id: &str, result_path: &std::path::Path) -> Value {
    json!({"jobId": job_id, "resultPath": result_path.to_string_lossy()})
}
