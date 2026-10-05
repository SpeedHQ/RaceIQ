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

pub(crate) fn response(job_id: &str, result_path: &std::path::Path) -> Value {
    json!({"jobId": job_id, "resultPath": result_path.to_string_lossy()})
}
