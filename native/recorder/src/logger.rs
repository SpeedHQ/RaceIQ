use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering}, mpsc::{self, SyncSender}, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_ACTIVE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
// JSON escaping uses at most six bytes per input byte; leave room for metadata.
const MAX_MESSAGE_BYTES: usize = (MAX_LINE_BYTES - 1024) / 6;
// Fixed slots * capped message size provide a strict 512 KiB queued-byte bound.
const LOGGER_QUEUE_LINES: usize = 32;
const FATAL: u8 = 0;
const ERROR: u8 = 1;
const WARN: u8 = 2;
const INFO: u8 = 3;
const DEBUG: u8 = 4;
const TRACE: u8 = 5;
static LOGGER: OnceLock<SyncSender<LogMessage>> = OnceLock::new();
static THRESHOLD: AtomicU8 = AtomicU8::new(INFO);
static DROPPED: AtomicU64 = AtomicU64::new(0);
static REPORTED_DROPPED: AtomicU64 = AtomicU64::new(0);
static DEGRADED: AtomicBool = AtomicBool::new(false);

enum LogMessage { Line(String), Flush(mpsc::SyncSender<()>) }

fn level(value: &str) -> Option<u8> {
    match value { "fatal" => Some(FATAL), "error" => Some(ERROR), "warn" => Some(WARN), "info" => Some(INFO), "debug" => Some(DEBUG), "trace" => Some(TRACE), "silent" => Some(FATAL), _ => None }
}

pub fn init() -> Result<(), String> {
    let directory = std::env::var_os("RACEIQ_RECORDER_LOG_DIR").map(PathBuf::from).ok_or("RACEIQ_RECORDER_LOG_DIR is required")?;
    let configured = std::env::var("RACEIQ_LOG_LEVEL").unwrap_or_else(|_| "info".into());
    THRESHOLD.store(level(&configured).unwrap_or(INFO), Ordering::Relaxed);
    let (tx, rx) = mpsc::sync_channel(LOGGER_QUEUE_LINES);
    LOGGER.set(tx).map_err(|_| "logger already initialized")?;
    thread::Builder::new().name("recorder-logger".into()).spawn(move || writer(directory, rx)).map_err(|error| format!("start logger: {error}"))?;
    if level(&configured).is_none() { log("warn", "invalid RACEIQ_LOG_LEVEL; using info"); }
    log("info", &format!("logger started pid={} path={}", std::process::id(), std::env::var_os("RACEIQ_RECORDER_LOG_DIR").unwrap_or_default().to_string_lossy()));
    Ok(())
}

fn redact(message: &str) -> String {
    let mut output = String::with_capacity(message.len().min(MAX_MESSAGE_BYTES));
    for part in message.split_whitespace() {
        if !output.is_empty() { output.push(' '); }
        let lower = part.to_ascii_lowercase();
        let secret = ["password=", "token=", "secret=", "authorization=", "api_key=", "apikey="]
            .iter().any(|marker| lower.contains(marker));
        if secret {
            let key = part.split_once('=').map(|(key, _)| key).unwrap_or("credential");
            output.push_str(key);
            output.push_str("=[REDACTED]");
        } else if part.len() >= 32 && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
            output.push_str("[REDACTED]");
        } else { output.push_str(part); }
        if output.len() >= MAX_MESSAGE_BYTES {
            let mut end = MAX_MESSAGE_BYTES;
            while !output.is_char_boundary(end) { end -= 1; }
            output.truncate(end);
            break;
        }
    }
    output
}

fn log_at_threshold(threshold: u8, name: &str, message: &str) {
    let Some(severity) = level(name) else { return; };
    if severity > threshold { return; }
    let message = redact(message);
    let line = json!({"time":utc_now(),"level":name,"service":"raceiq-recorder","pid":std::process::id(),"msg":message}).to_string();
    if let Some(tx) = LOGGER.get() {
        if tx.try_send(LogMessage::Line(line)).is_err() { DROPPED.fetch_add(1, Ordering::Relaxed); }
    } else { eprintln!("recorder logger unavailable"); }
}

pub fn log(name: &str, message: &str) { log_at_threshold(THRESHOLD.load(Ordering::Relaxed), name, message); }

pub fn flush() {
    let Some(tx) = LOGGER.get() else { return; };
    let (ack_tx, ack_rx) = mpsc::sync_channel(1);
    if tx.try_send(LogMessage::Flush(ack_tx)).is_ok() { let _ = ack_rx.recv_timeout(Duration::from_secs(2)); }
}

pub fn health() -> Value {
    let degraded = DEGRADED.load(Ordering::Relaxed);
    json!({"state":if degraded {"degraded"} else {"ready"},"error":if degraded {Value::String("recorder log IO unavailable".into())} else {Value::Null},"droppedMessages":DROPPED.load(Ordering::Relaxed)})
}

pub fn mark_degraded() { DEGRADED.store(true, Ordering::Relaxed); }

fn writer(directory: PathBuf, rx: mpsc::Receiver<LogMessage>) {
    let mut file: Option<File> = None;
    let mut active_day = utc_now()[..10].to_owned();
    let mut last_flush = std::time::Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(LogMessage::Line(line)) => {
                let day = utc_now()[..10].to_owned();
                if file.is_none() { file = open_log(&directory).ok(); active_day.clone_from(&day); }
                if file.is_some() && day != active_day {
                    file.take();
                    if let Err(error) = rotate(&directory) { report_io_error(&error); }
                    file = open_log(&directory).ok();
                    active_day = day;
                }
                if let Some(active) = file.as_mut() {
                    match active.metadata().map(|metadata| metadata.len() >= MAX_ACTIVE_BYTES) {
                        Ok(true) => {
                            file.take();
                            if let Err(error) = rotate(&directory) { report_io_error(&error); }
                            file = open_log(&directory).ok();
                        }
                        Err(error) => report_io_error(&error),
                        _ => {}
                    }
                    if let Some(active) = file.as_mut() {
                        if let Err(error) = writeln!(active, "{line}") { file.take(); report_io_error(&error); }
                        else { DEGRADED.store(false, Ordering::Relaxed); }
                    }
                } else {
                    DEGRADED.store(true, Ordering::Relaxed);
                    eprintln!("recorder log unavailable");
                }
                let dropped = DROPPED.load(Ordering::Relaxed);
                let reported = REPORTED_DROPPED.swap(dropped, Ordering::Relaxed);
                if dropped > reported { eprintln!("recorder logger dropped {} diagnostic messages", dropped - reported); }
            }
            Ok(LogMessage::Flush(ack)) => {
                if let Some(active) = file.as_mut() { if let Err(error) = active.flush() { report_io_error(&error); } }
                let _ = ack.try_send(());
                last_flush = std::time::Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_flush.elapsed() >= Duration::from_secs(1) {
                    if let Some(active) = file.as_mut() { if let Err(error) = active.flush() { report_io_error(&error); file.take(); } }
                    last_flush = std::time::Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(mut active) = file { let _ = active.flush(); }
}

fn report_io_error(error: &std::io::Error) {
    DEGRADED.store(true, Ordering::Relaxed);
    eprintln!("recorder log IO degraded: {error}");
}

fn open_log(directory: &Path) -> std::io::Result<File> {
    fs::create_dir_all(directory)?;
    prune(directory);
    let active = directory.join("recorder.log");
    if active.exists() && fs::metadata(&active)?.len() >= MAX_ACTIVE_BYTES { rotate(directory)?; }
    OpenOptions::new().create(true).append(true).open(active)
}

fn rotate(directory: &Path) -> std::io::Result<()> {
    let active = directory.join("recorder.log");
    if !active.exists() { return Ok(()); }
    let stamp = utc_now().replace(':', "-").replace('.', "-");
    for counter in 0..1000u32 {
        let destination = directory.join(format!("recorder-{stamp}-{}-{counter}.log", std::process::id()));
        if !destination.exists() { fs::rename(&active, destination)?; return Ok(()); }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "recorder rotation name space exhausted"))
}

fn prune(directory: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(directory) else { return; };
    let mut rotated = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("recorder-") || !name.ends_with(".log") { continue; }
        if let Ok(metadata) = entry.metadata() {
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            rotated.push((entry.path(), modified, metadata.len()));
            if now.duration_since(modified).unwrap_or_default() > Duration::from_secs(25 * 60 * 60) { let _ = fs::remove_file(entry.path()); }
        }
    }
    rotated.sort_by_key(|entry| entry.1);
    let mut total: u64 = rotated.iter().map(|entry| entry.2).sum();
    while rotated.len() > 64 || total > 64 * 1024 * 1024 {
        let (path, _, bytes) = rotated.remove(0);
        let _ = fs::remove_file(path);
        total = total.saturating_sub(bytes);
    }
}

fn utc_now() -> String {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let days = (duration.as_secs() / 86_400) as i64;
    let time = duration.as_secs() % 86_400;
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 { year += 1; }
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", time / 3_600, (time / 60) % 60, time % 60, duration.subsec_millis())
}
