use crate::{detection::Detector, games::GameParser, imports, logger, protocol, writer::CaptureWriter};
use serde_json::{json, Value};
use std::{collections::HashMap, io, path::PathBuf, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc::{self, RecvTimeoutError, SyncSender}, Arc, Mutex}, thread::{self, JoinHandle}, time::{Duration, SystemTime, UNIX_EPOCH}};

struct UdpStats { total: AtomicUsize, dropped: AtomicUsize, routed: AtomicUsize, parsed: AtomicUsize, last_ms: AtomicUsize, progress_ms: AtomicUsize, last_game: AtomicUsize, previous_total: AtomicUsize, window_start_ms: AtomicUsize, started: std::time::Instant }
impl UdpStats { fn new() -> Self { let now=now_ms() as usize; Self { total:AtomicUsize::new(0), dropped:AtomicUsize::new(0), routed:AtomicUsize::new(0), parsed:AtomicUsize::new(0), last_ms:AtomicUsize::new(0), progress_ms:AtomicUsize::new(now), last_game:AtomicUsize::new(0), previous_total:AtomicUsize::new(0), window_start_ms:AtomicUsize::new(now), started:std::time::Instant::now() } } }
const SOURCE_QUEUE_MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct SourceSender {
    tx: SyncSender<SourceMessage>,
    pending_bytes: Arc<AtomicUsize>,
    exhausted: Arc<AtomicBool>,
}

impl SourceSender {
    pub fn try_send(&self, message: SourceMessage) -> Result<(), String> {
        let bytes = message.payload_len();
        let mut pending = self.pending_bytes.load(Ordering::Relaxed);
        loop {
            let next = pending.checked_add(bytes).filter(|value| *value <= SOURCE_QUEUE_MAX_BYTES)
                .ok_or_else(|| { self.exhausted.store(true, Ordering::Release); "source acquisition queue exceeded 64 MiB".to_owned() })?;
            match self.pending_bytes.compare_exchange_weak(pending, next, Ordering::AcqRel, Ordering::Relaxed) {
                Ok(_) => break,
                Err(actual) => pending = actual,
            }
        }
        match self.tx.try_send(message) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.pending_bytes.fetch_sub(bytes, Ordering::AcqRel);
                self.exhausted.store(true, Ordering::Release);
                Err(format!("source acquisition queue exhausted: {error}"))
            }
        }
    }

    fn release(&self, message: &SourceMessage) { self.pending_bytes.fetch_sub(message.payload_len(), Ordering::AcqRel); }
    fn pending_bytes(&self) -> usize { self.pending_bytes.load(Ordering::Acquire) }
    fn take_failure(&self) -> bool { self.exhausted.swap(false, Ordering::AcqRel) }
}

impl SourceMessage {
    fn payload_len(&self) -> usize {
        match self {
            Self::Udp { bytes, .. } | Self::Native { bytes, .. } => bytes.len(),
            Self::Status(status) => status.to_string().len(),
            Self::Failure(error) => error.len(),
        }
    }
}
struct DevDump { file: std::fs::File, game: String, count: u32, last_static: Option<Vec<u8>> }
impl DevDump {
    fn new(directory: &str, game: &str) -> Result<Self, String> {
        use std::{fs, fs::OpenOptions, io::Write};
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let path = PathBuf::from(directory).join(format!("{game}-{}.bin", now_ms()));
        let mut file = OpenOptions::new().create_new(true).write(true).read(true).open(path).map_err(|e| e.to_string())?;
        let (magic, version): (&[u8], u32) = match game { "acc" | "ac-evo" => (b"ACCTEST\0", 3), "iracing" => (b"IRIQDMP\0", 2), "lmu" => (b"LMUQDMP\0", 1), _ => (b"", 0) };
        if !magic.is_empty() { file.write_all(magic).and_then(|_|file.write_all(&version.to_le_bytes())).and_then(|_|file.write_all(&0u32.to_le_bytes())).map_err(|e|e.to_string())?; }
        Ok(Self { file, game: game.into(), count: 0, last_static: None })
    }
    fn frame(&mut self, kind: u8, bytes: &[u8], time_ms: u64) -> Result<(), String> {
        use std::io::{Seek, SeekFrom, Write};
        self.file.seek(SeekFrom::End(0)).map_err(|e|e.to_string())?;
        if self.game == "fm-2023" || self.game == "f1-2025" {
            let mut prefix = ((bytes.len() as u32) | 0x8000_0000).to_le_bytes().to_vec();
            prefix.extend_from_slice(&time_ms.to_le_bytes());
            self.file.write_all(&prefix).and_then(|_|self.file.write_all(bytes)).map_err(|e|e.to_string())?;
        } else {
            self.file.write_all(&[kind]).and_then(|_|self.file.write_all(&(bytes.len() as u32).to_le_bytes())).and_then(|_|self.file.write_all(bytes)).map_err(|e|e.to_string())?;
            self.count = self.count.checked_add(1).ok_or("development dump frame count overflow")?;
            self.file.seek(SeekFrom::Start(12)).and_then(|_|self.file.write_all(&self.count.to_le_bytes())).and_then(|_|self.file.seek(SeekFrom::End(0))).map_err(|e|e.to_string())?;
        }
        Ok(())
    }
}
struct Outgoing { opcode: u8, id: u32, payload: Vec<u8>, key: String, reliable: bool }
struct QueueState {
    control: std::collections::VecDeque<Outgoing>,
    reliable: std::collections::VecDeque<Outgoing>,
    reliable_bytes: usize,
    latest_status: Option<Outgoing>,
    latest_display: HashMap<String, Outgoing>,
    display_bytes: usize,
    failure: Option<String>,
    closed: bool,
}
struct Outbox { shared: Arc<(Mutex<QueueState>, std::sync::Condvar)>, writer: Mutex<Option<JoinHandle<()>>> }

impl Outbox {
    fn new() -> Result<Self, String> {
        let shared = Arc::new((Mutex::new(QueueState { control: Default::default(), reliable: Default::default(), reliable_bytes: 0, latest_status: None, latest_display: HashMap::new(), display_bytes: 0, failure: None, closed: false }), std::sync::Condvar::new()));
        let queue = shared.clone();
        let writer = thread::Builder::new().name("recorder-stdout".into()).spawn(move || {
            let stdout = io::stdout();
            let mut stdout = stdout.lock();
            loop {
                let message = {
                    let (lock, condition) = &*queue;
                    let mut state = match lock.lock() { Ok(state) => state, Err(_) => return };
                    while state.control.is_empty() && state.reliable.is_empty() && state.latest_status.is_none() && state.latest_display.is_empty() && !state.closed {
                        state = match condition.wait(state) { Ok(state) => state, Err(_) => return };
                    }
                    let next = state.control.pop_front()
                        .or_else(|| state.reliable.pop_front())
                        .or_else(|| state.latest_status.take())
                        .or_else(|| { let key = state.latest_display.keys().next().cloned()?; let message = state.latest_display.remove(&key); if let Some(item) = &message { state.display_bytes = state.display_bytes.saturating_sub(item.payload.len() + 5); } message });
                    if next.is_none() && state.closed { return; }
                    next
                };
                if let Some(message) = message {
                    if let Err(error) = protocol::write_message(&mut stdout, message.opcode, message.id, &message.payload) {
                        let (lock, condition) = &*queue;
                        if let Ok(mut state) = lock.lock() { state.failure = Some(format!("stdout IPC write failed: {error}")); state.closed = true; condition.notify_all(); }
                        return;
                    }
                    if message.reliable {
                        let (lock, condition) = &*queue;
                        if let Ok(mut state) = lock.lock() {
                            state.reliable_bytes = state.reliable_bytes.saturating_sub(message.payload.len() + 5);
                            condition.notify_all();
                        }
                    }
                }
            }
        }).map_err(|error| format!("start stdout writer: {error}"))?;
        Ok(Self { shared, writer: Mutex::new(Some(writer)) })
    }

    fn send(&self, opcode: u8, id: u32, payload: Vec<u8>) -> Result<(), String> {
        self.send_key(opcode, id, payload, String::new())
    }

    fn send_display(&self, game: &str, payload: Vec<u8>) -> Result<(), String> {
        self.send_key(protocol::LIVE_FRAME, 0, payload, game.to_owned())
    }

    fn send_key(&self, opcode: u8, id: u32, payload: Vec<u8>, key: String) -> Result<(), String> {
        if payload.len() + protocol::MIN_BODY > protocol::MAX_BODY { return Err("IPC message exceeds 16 MiB".into()); }
        let (lock, condition) = &*self.shared;
        let mut state = lock.lock().map_err(|_| "stdout queue poisoned")?;
        if let Some(error) = &state.failure { return Err(error.clone()); }
        if state.closed { return Err("stdout queue closed".into()); }
        let message = Outgoing { opcode, id, payload, key, reliable: opcode == protocol::EVENT };
        match opcode {
            protocol::RESPONSE | protocol::HELLO => {
                let size = message.payload.len() + 5;
                let pending: usize = state.control.iter().map(|item| item.payload.len() + 5).sum();
                if pending + size > 4 * 1024 * 1024 { return Err("IPC control response queue exceeded 4 MiB".into()); }
                state.control.push_back(message);
            }
            protocol::EVENT => {
                let size = message.payload.len() + 5;
                if state.reliable_bytes + size > 4 * 1024 * 1024 { return Err("IPC reliable lifecycle event queue exceeded 4 MiB".into()); }
                state.reliable_bytes += size;
                state.reliable.push_back(message);
            }
            protocol::LIVE_FRAME => {
                let size = message.payload.len() + 5;
                if size > 8 * 1024 * 1024 { return Err("IPC display frame exceeds 8 MiB".into()); }
                if let Some(previous) = state.latest_display.remove(&message.key) { state.display_bytes = state.display_bytes.saturating_sub(previous.payload.len() + 5); }
                if state.display_bytes + size > 8 * 1024 * 1024 { return Err("IPC display snapshot queue exceeded 8 MiB".into()); }
                state.display_bytes += size;
                state.latest_display.insert(message.key.clone(), message);
            }
            _ => state.latest_status = Some(message),
        }
        condition.notify_one();
        Ok(())
    }

    fn send_fenced_response(&self, id: u32, result: Result<Value, String>) -> Result<(), String> {
        let payload = match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(message) => json!({"ok":false,"error":{"code":"RECORDER_OPERATION_FAILED","message":message}}),
        };
        let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
        if bytes.len() + protocol::MIN_BODY > protocol::MAX_BODY { return Err("IPC message exceeds 16 MiB".into()); }
        let (lock, condition) = &*self.shared;
        let mut state = lock.lock().map_err(|_| "stdout queue poisoned")?;
        let size = bytes.len() + 5;
        if state.reliable_bytes + size > 4 * 1024 * 1024 { return Err("IPC reliable lifecycle queue exceeded 4 MiB".into()); }
        state.reliable_bytes += size;
        state.reliable.push_back(Outgoing { opcode: protocol::RESPONSE, id, payload: bytes, key: String::new(), reliable: true });
        condition.notify_one();
        Ok(())
    }

    fn wait_reliable_empty(&self) -> Result<(), String> {
        let (lock, condition) = &*self.shared;
        let mut state = lock.lock().map_err(|_| "stdout queue poisoned")?;
        while state.reliable_bytes > 0 {
            if let Some(error) = &state.failure { return Err(error.clone()); }
            state = condition.wait(state).map_err(|_| "stdout queue poisoned")?;
        }
        if let Some(error) = &state.failure { return Err(error.clone()); }
        Ok(())
    }

    fn close(&self) -> Result<(), String> {
        {
            let (lock, condition) = &*self.shared;
            let mut state = lock.lock().map_err(|_| "stdout queue poisoned")?;
            state.closed = true;
            condition.notify_all();
        }
        if let Some(writer) = self.writer.lock().map_err(|_| "stdout thread handle poisoned")?.take() {
            writer.join().map_err(|_| "stdout writer thread panicked")?;
        }
        let state = self.shared.0.lock().map_err(|_| "stdout queue poisoned")?;
        if let Some(error) = &state.failure { return Err(error.clone()); }
        Ok(())
    }
}

fn send_json(out: &Outbox, opcode: u8, id: u32, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    out.send(opcode, id, bytes)
}

fn respond(out: &Outbox, id: u32, result: Result<Value, String>) -> Result<(), String> {
    let payload = match result { Ok(result) => json!({"ok":true,"result":result}), Err(message) => json!({"ok":false,"error":{"code":"RECORDER_OPERATION_FAILED","message":message}}) };
    send_json(out, protocol::RESPONSE, id, &payload)
}

#[derive(Debug)]
pub enum SourceMessage {
    Udp { game_id: String, bytes: Vec<u8>, time_ms: u64 },
    Native { game_id: String, bytes: Vec<u8>, time_ms: u64 },
    Status(Value),
    Failure(String),
}

enum Input { Message(protocol::Message), Eof, Error(String) }
enum Async { Response(u32, Value), Failure(u32, String), Source(SourceMessage) }
struct ActiveCapture { id: String, writer: CaptureWriter }

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64 }
fn read_loop(tx: mpsc::Sender<Input>) {
    let stdin = io::stdin();
    let mut locked = stdin.lock();
    loop {
        match protocol::read_message(&mut locked) {
            Ok(Some(message)) => if tx.send(Input::Message(message)).is_err() { break; },
            Ok(None) => { let _ = tx.send(Input::Eof); break; },
            Err(error) => { let _ = tx.send(Input::Error(error.to_string())); break; }
        }
    }
}

pub fn run() -> Result<(), String> {
    let stdout = Outbox::new()?;
    let hello = json!({"protocolVersion":1,"pid":std::process::id(),"platform":if cfg!(windows){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"},"nativeCapture":cfg!(windows)});
    send_json(&stdout, protocol::HELLO, 0, &hello)?;
    let (input_tx, input_rx) = mpsc::channel();
    thread::Builder::new().name("recorder-stdin".into()).spawn(move || read_loop(input_tx)).map_err(|e| e.to_string())?;
    let (async_tx, async_rx) = mpsc::channel::<Async>();
    let (source_raw_tx, source_rx) = mpsc::sync_channel::<SourceMessage>(1024);
    let source_tx = SourceSender { tx: source_raw_tx, pending_bytes: Arc::new(AtomicUsize::new(0)), exhausted: Arc::new(AtomicBool::new(false)) };
    let mut source_threads: Vec<JoinHandle<()>> = Vec::new();
    let mut source_stop: Option<Arc<AtomicBool>> = None;
    let mut parsers: HashMap<String, GameParser> = HashMap::new();
    let mut detectors: HashMap<String, Detector> = HashMap::new();
    let mut captures: HashMap<String, ActiveCapture> = HashMap::new();
    let mut source_states: HashMap<String, Value> = HashMap::new();
    let mut event_sequence = 0u64;
    let mut live_sequence = 0u64;
    let mut debug_enabled = std::collections::HashSet::<String>::new();
    let mut debug_latest = HashMap::<String, [Vec<u8>; 3]>::new();
    let mut config: Option<Value> = None;
    let udp_stats = Arc::new(UdpStats::new());
    let mut dev_dumps = HashMap::<String, DevDump>::new();
    let mut quiesced = false;
    let mut stopping = false;

    while !stopping {
        match input_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Input::Message(message)) => {
                if message.opcode != protocol::REQUEST || message.request_id == 0 { return Err("unexpected recorder request envelope".into()); }
                let request: Value = serde_json::from_slice(&message.payload).map_err(|e| format!("invalid request JSON: {e}"))?;
                let operation = request.get("operation").and_then(Value::as_str).ok_or("request operation missing")?.to_owned();
                let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
                match operation.as_str() {
                    "configure" => {
                        if config.is_some() { respond(&stdout, message.request_id, Err("recorder already configured".into()))?; continue; }
                        if let Err(error) = configure(&input) { respond(&stdout, message.request_id, Err(error))?; continue; }
                        let stop = Arc::new(AtomicBool::new(false));
                        let mut handles = vec![start_udp(&input, source_tx.clone(), stop.clone(), udp_stats.clone())?];
                        #[cfg(windows)]
                        { handles.extend(crate::windows::start(&input, source_tx.clone(), stop.clone())?); }
                        source_stop = Some(stop);
                        source_threads = handles;
                        config = Some(input);
                        send_json(&stdout, protocol::STATUS, 0, &json!({"state":"ready","sources":[],"logger":{"state":"ready","error":null,"droppedMessages":0}}))?;
                        respond(&stdout, message.request_id, Ok(json!({"configured":true})))?;
                    }
                    "health" => {
                        let logger_health = logger::health();
                        let udp_age = now_ms().saturating_sub(udp_stats.progress_ms.load(Ordering::Relaxed) as u64);
                        let native_failed = source_states.values().any(|source| matches!(source.get("worker").and_then(|worker|worker.get("state")).and_then(Value::as_str),Some("failed"|"stalled")));
                        let health_state = if native_failed || udp_age > 10_000 { "failed" } else if logger_health["state"] == "degraded" { "degraded" } else { "ready" };
                        let mut sources: Vec<Value> = source_states.values().cloned().collect();
                        let mut workers: Vec<Value> = source_states.values().filter_map(|source| source.get("worker").cloned()).collect();
                        workers.push(json!({"name":"udp-acquisition","state":if config.is_some() && udp_age>10_000{"stalled"}else if config.is_some(){"running"}else{"idle"},"progressAgeMs":udp_age,"pendingBytes":source_tx.pending_bytes()}));
                        let port = config.as_ref().and_then(|c|c.get("udpPort")).and_then(Value::as_u64).unwrap_or(5301);
                        let total = udp_stats.total.load(Ordering::Relaxed);
                        let current_ms = now_ms() as usize;
                        let previous_ms = udp_stats.window_start_ms.swap(current_ms, Ordering::Relaxed);
                        let previous_total = udp_stats.previous_total.swap(total, Ordering::Relaxed);
                        let packets_per_sec = ((total.saturating_sub(previous_total)) as f64 * 1000.0 / current_ms.saturating_sub(previous_ms).max(1) as f64) as u64;
                        let udp = json!({"receiving":udp_stats.last_ms.load(Ordering::Relaxed)>0 && now_ms().saturating_sub(udp_stats.last_ms.load(Ordering::Relaxed) as u64)<2000,"packetsPerSec":packets_per_sec,"droppedPackets":udp_stats.dropped.load(Ordering::Relaxed),"totalPackets":total,"acceptedPackets":udp_stats.routed.load(Ordering::Relaxed),"port":port});
                        let last = udp_stats.last_ms.load(Ordering::Relaxed) as u64;
                        for (index, game) in [(1usize, "fm-2023"), (2usize, "f1-2025")] {
                            if !sources.iter().any(|source| source.get("gameId").and_then(Value::as_str) == Some(game)) {
                                let age = if udp_stats.last_game.load(Ordering::Relaxed) == index { Some(now_ms().saturating_sub(last)) } else { None };
                                sources.push(json!({"gameId":game,"state":if age.is_some_and(|age|age<2000){"receiving"}else{"disconnected"},"lastFrameAgeMs":age,"worker":{"name":"udp-acquisition","state":if config.is_some() && udp_age>10_000{"stalled"}else if config.is_some(){"running"}else{"idle"},"progressAgeMs":udp_age,"pendingBytes":source_tx.pending_bytes()}}));
                            }
                        }
                        publish_status(&stdout, &udp_stats, &sources, port, packets_per_sec)?;
                        respond(&stdout, message.request_id, Ok(json!({"state":health_state,"workers":workers,"sources":sources,"udp":udp,"lastWriteError":null,"logger":logger_health})))?;
                    }
                    "shutdown" => {
                        let phase = input.get("phase").and_then(Value::as_str).unwrap_or("exit");
                        if phase != "finalize" && phase != "exit" {
                            respond(&stdout, message.request_id, Err(format!("invalid shutdown phase: {phase}")))?;
                            continue;
                        }
                        if !quiesced {
                            if let Some(stop) = &source_stop { stop.store(true, Ordering::SeqCst); }
                            for handle in source_threads.drain(..) { handle.join().map_err(|_| "source worker panicked")?; }
                            while let Ok(source) = source_rx.try_recv() {
                                source_tx.release(&source);
                                record_dev_dump(&source, config.as_ref(), &mut dev_dumps)?;
                                process_source(source, &stdout, &mut parsers, &mut detectors, &mut captures, &mut source_states, &mut event_sequence, &mut live_sequence, config.as_ref(), &udp_stats)?;
                            }
                            let reason = input.get("reason").and_then(Value::as_str).unwrap_or("signal");
                            for (game, detector) in detectors.iter_mut() {
                                let events = detector.finish(reason)?;
                                apply_events(events, game, &stdout, &mut captures, &mut event_sequence, config.as_ref(), None)?;
                            }
                            let active: Vec<String> = captures.keys().cloned().collect();
                            for game in active {
                                if let Some(mut capture) = captures.remove(&game) {
                                    let result = capture.writer.close()?;
                                    emit_event(&stdout, &mut event_sequence, &capture.id, json!({"kind":"RECORDING_COMPLETED","data":{"gameId":game,"captureId":capture.id,"path":result["path"],"count":result["count"],"size":result["size"],"reason":reason}}))?;
                                }
                            }
                            quiesced = true;
                        }
                        if phase == "finalize" {
                            stdout.send_fenced_response(message.request_id, Ok(json!({"finalized":true,"eventSequence":event_sequence.to_string()})))?;
                        } else {
                            stopping = true;
                            respond(&stdout, message.request_id, Ok(json!({"stopped":true})))?;
                        }
                    }
                    "preview" | "import" | "reprocess" | "encode-capture" | "encode-lap-slices" | "read-capture" | "read-lap-window" => {
                        if quiesced && operation != "read-capture" && operation != "read-lap-window" {
                            respond(&stdout, message.request_id, Err("recorder is finalizing".into()))?;
                            continue;
                        }
                        let tx = async_tx.clone();
                        let conf = config.clone().unwrap_or_else(|| json!({}));
                        let op = operation.clone();
                        let id = message.request_id;
                        thread::spawn(move || match imports::run(&op, input, &conf) {
                            Ok(result) => { let _ = tx.send(Async::Response(id, result)); }
                            Err(error) => { let _ = tx.send(Async::Failure(id, error)); }
                        });
                    }
                    "forget-session" => {
                        let capture_id = input.get("captureId").and_then(Value::as_str).ok_or("forget-session requires captureId")?;
                        let game = captures.iter().find_map(|(game, capture)| (capture.id == capture_id).then_some(game.clone()));
                        if let Some(game) = game {
                            if let Some(mut capture) = captures.remove(&game) { let _ = capture.writer.close()?; }
                            if let Some(detector) = detectors.get_mut(&game) { detector.reset(); }
                            if let Some(parser) = parsers.get_mut(&game) { parser.reset(); }
                        }
                        respond(&stdout, message.request_id, Ok(json!({"forgotten":true})))?;
                    }
                    "debug-demand" => {
                        let game = input.get("gameId").and_then(Value::as_str).ok_or("debug-demand requires gameId")?;
                        if input.get("enabled").and_then(Value::as_bool) != Some(true) || !matches!(game, "acc" | "ac-evo") {
                            respond(&stdout, message.request_id, Err("debug-demand requires enabled Kunos game".into()))?;
                            continue;
                        }
                        debug_enabled.insert(game.to_owned());
                        let result = debug_latest.get(game).map(|pages| json!({"connected":true,"physics":base64(&pages[0]),"graphics":base64(&pages[1]),"static":base64(&pages[2])}))
                            .unwrap_or_else(|| json!({"connected":false,"physics":"","graphics":"","static":""}));
                        respond(&stdout, message.request_id, Ok(result))?;
                    }
                    _ => respond(&stdout, message.request_id, Err(format!("unsupported operation: {operation}")))?,
                }
            }
            Ok(Input::Eof) => {
                if let Some(stop) = &source_stop { stop.store(true, Ordering::SeqCst); }
                for handle in source_threads.drain(..) { handle.join().map_err(|_| "source worker panicked on parent EOF")?; }
                stopping = true;
            }
            Ok(Input::Error(error)) => return Err(format!("recorder protocol input failed: {error}")),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => { stopping = true; }
        }
        if source_tx.take_failure() { return Err("terminal source queue exhaustion: payload queue or byte bound exceeded".into()); }
        while let Ok(message) = async_rx.try_recv() {
            match message {
                Async::Response(id, result) => respond(&stdout, id, Ok(result))?,
                Async::Failure(id, error) => respond(&stdout, id, Err(error))?,
                Async::Source(source) => process_source(source, &stdout, &mut parsers, &mut detectors, &mut captures, &mut source_states, &mut event_sequence, &mut live_sequence, config.as_ref(), &udp_stats)?,
            }
        }
        while let Ok(source) = source_rx.try_recv() {
            source_tx.release(&source);
            record_dev_dump(&source, config.as_ref(), &mut dev_dumps)?;
            if let SourceMessage::Native { game_id, bytes, .. } = &source {
                if debug_enabled.contains(game_id) { if let Some(pages) = decode_debug_triplet(game_id, bytes) { debug_latest.insert(game_id.clone(), pages); } }
            }
            match source {
                SourceMessage::Failure(error) => return Err(error),
                other => process_source(other, &stdout, &mut parsers, &mut detectors, &mut captures, &mut source_states, &mut event_sequence, &mut live_sequence, config.as_ref(), &udp_stats)?,
            }
        }
        for (game, detector) in detectors.iter_mut() {
            let events = detector.tick(now_ms())?;
            apply_events(events, game, &stdout, &mut captures, &mut event_sequence, config.as_ref(), None)?;
        }
    }
    while let Ok(source) = source_rx.try_recv() {
        source_tx.release(&source);
        record_dev_dump(&source, config.as_ref(), &mut dev_dumps)?;
        process_source(source, &stdout, &mut parsers, &mut detectors, &mut captures, &mut source_states, &mut event_sequence, &mut live_sequence, config.as_ref(), &udp_stats)?;
    }
    for (game, detector) in detectors.iter_mut() {
        let events = detector.finish("parent-eof")?;
        apply_events(events, game, &stdout, &mut captures, &mut event_sequence, config.as_ref(), None)?;
    }
    let active: Vec<String> = captures.keys().cloned().collect();
    for game in active {
        if let Some(mut capture) = captures.remove(&game) {
            let result = capture.writer.close()?;
            emit_event(&stdout, &mut event_sequence, &capture.id, json!({"kind":"RECORDING_COMPLETED","data":{"gameId":game,"captureId":capture.id,"path":result["path"],"count":result["count"],"size":result["size"],"reason":"parent-eof"}}))?;
        }
    }
    logger::log("info", "recorder stopped");
    logger::flush();
    stdout.close()?;
    Ok(())
}

fn configure(config: &Value) -> Result<(), String> {
    let data_dir = config.get("dataDir").and_then(Value::as_str).ok_or("configure requires absolute dataDir")?;
    if !PathBuf::from(data_dir).is_absolute() { return Err("dataDir must be absolute".into()); }
    if let Some(port) = config.get("udpPort").and_then(Value::as_u64) { if port > u16::MAX as u64 { return Err("udpPort outside u16 range".into()); } }
    Ok(())
}

fn start_udp(config: &Value, sender: SourceSender, stop: Arc<AtomicBool>, stats: Arc<UdpStats>) -> Result<JoinHandle<()>, String> {
    use std::net::UdpSocket;
    let host = config.get("udpHostname").and_then(Value::as_str).unwrap_or("0.0.0.0");
    let port = config.get("udpPort").and_then(Value::as_u64).unwrap_or(5301) as u16;
    let socket = UdpSocket::bind((host, port)).map_err(|e| format!("bind UDP {host}:{port}: {e}"))?;
    socket.set_read_timeout(Some(Duration::from_millis(200))).map_err(|e| e.to_string())?;
    let configured = config.get("udpGameId").and_then(Value::as_str).map(str::to_owned);
    thread::Builder::new().name("recorder-udp".into()).spawn(move || {
        let mut buffer = vec![0u8; 65_535];
        while !stop.load(Ordering::Relaxed) {
            stats.progress_ms.store(now_ms() as usize, Ordering::Relaxed);
            match socket.recv_from(&mut buffer) {
                Ok((length, _)) => {
                    stats.total.fetch_add(1, Ordering::Relaxed);
                    stats.last_ms.store(now_ms() as usize, Ordering::Relaxed);
                    let bytes = &buffer[..length];
                    let game_id = configured.as_deref().map(str::to_owned).or_else(|| {
                        if bytes.len() >= 29 && u16::from_le_bytes([bytes[0], bytes[1]]) == 2025 { Some("f1-2025".to_owned()) }
                        else if bytes.len() >= 324 && i32::from_le_bytes(bytes[layout_offset_race()..layout_offset_race()+4].try_into().ok()?) != 0 { Some("fm-2023".to_owned()) }
                        else { None }
                    });
                    if let Some(game_id) = game_id {
                        stats.last_game.store(if game_id == "fm-2023" { 1 } else if game_id == "f1-2025" { 2 } else { 3 }, Ordering::Relaxed);
                        if sender.try_send(SourceMessage::Udp { game_id, bytes: bytes.to_vec(), time_ms: now_ms() }).is_err() {
                            stats.dropped.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                        stats.routed.fetch_add(1, Ordering::Relaxed);
                    } else { stats.dropped.fetch_add(1, Ordering::Relaxed); }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock || error.kind() == io::ErrorKind::TimedOut => {}
                Err(error) => { let _ = sender.try_send(SourceMessage::Failure(format!("UDP receive failed: {error}"))); break; }
            }
        }
    }).map_err(|e| format!("start UDP worker: {e}"))
}

fn layout_offset_race() -> usize { crate::games::generated::layouts::FM_PACKET_IS_RACE_ON as usize }

fn process_source(source: SourceMessage, out: &Outbox, parsers: &mut HashMap<String, GameParser>, detectors: &mut HashMap<String, Detector>, captures: &mut HashMap<String, ActiveCapture>, states: &mut HashMap<String, Value>, event_sequence: &mut u64, live_sequence: &mut u64, config: Option<&Value>, udp_stats: &UdpStats) -> Result<(), String> {
    let is_udp = matches!(&source, SourceMessage::Udp { .. });
    let (mut game_id, bytes, time_ms) = match source {
        SourceMessage::Udp { game_id, bytes, time_ms } | SourceMessage::Native { game_id, bytes, time_ms } => (game_id, bytes, time_ms),
        SourceMessage::Status(status) => {
            if let Some(game) = status.get("gameId").and_then(Value::as_str) { states.insert(game.to_owned(), status.clone()); }
            send_json(out, protocol::STATUS, 0, &status)?;
            return Ok(());
        }
        SourceMessage::Failure(error) => return Err(error),
    };
    if is_udp {
        if let Some(active_game) = states.values().find(|state| state.get("processActive").and_then(Value::as_bool) == Some(true))
            .and_then(|state| state.get("gameId").and_then(Value::as_str))
            .filter(|game| matches!(*game, "fm-2023" | "f1-2025")) { game_id = active_game.to_owned(); }
    }
    if !parsers.contains_key(&game_id) { parsers.insert(game_id.clone(), GameParser::new(&game_id)?); }
    let parsed = match parsers.get_mut(&game_id).ok_or("game parser missing")?.feed(&bytes, time_ms) {
        Ok(None) => return Ok(()),
        Ok(Some(packet)) => { if is_udp { udp_stats.parsed.fetch_add(1, Ordering::Relaxed); } packet },
        Err(_) => { if is_udp { udp_stats.dropped.fetch_add(1, Ordering::Relaxed); } return Ok(()); }
    };
    let mut packet = parsed;
    if !detectors.contains_key(&game_id) { detectors.insert(game_id.clone(), Detector::new(&game_id)?); }
    let offset = if let Some(capture) = captures.get_mut(&game_id) { capture.writer.write(&bytes, Some(time_ms))? } else { 12 };
    if let Some(object) = packet.as_object_mut() { object.insert("_rawByteOffset".into(), json!(offset)); }
    let events = detectors.get_mut(&game_id).ok_or("game detector missing")?.feed_at(packet.clone(), offset, time_ms)?;
    apply_events(events, &game_id, out, captures, event_sequence, config, Some((&bytes, time_ms)))?;
    *live_sequence = live_sequence.checked_add(1).ok_or("live sequence overflow")?;
    let capture_id = captures.get(&game_id).map(|capture| capture.id.as_str()).unwrap_or("");
    let payload = rmp_serde::to_vec_named(&json!({"captureId":capture_id,"sessionBestLapTime":packet.get("sessionBestLapTime"),"packet":packet})).map_err(|error| error.to_string())?;
    let mut frame = Vec::with_capacity(16 + payload.len());
    frame.extend_from_slice(&live_sequence.to_le_bytes());
    frame.extend_from_slice(&time_ms.to_le_bytes());
    frame.extend_from_slice(&payload);
    out.send_display(&game_id, frame)
}

fn apply_events(events: Vec<Value>, game: &str, out: &Outbox, captures: &mut HashMap<String, ActiveCapture>, event_sequence: &mut u64, config: Option<&Value>, frame: Option<(&[u8], u64)>) -> Result<(), String> {
    for event in events {
        let kind = event.get("kind").and_then(Value::as_str).unwrap_or("UNKNOWN");
        let mut data = event.get("data").cloned().unwrap_or(Value::Null);
        match kind {
            "SESSION_STARTED" => {
                if let Some(mut previous) = captures.remove(game) {
                    let previous_id = previous.id.clone();
                    let closed = previous.writer.close()?;
                    emit_event(out, event_sequence, &previous_id, json!({"kind":"RECORDING_COMPLETED","data":{"gameId":game,"captureId":previous_id,"path":closed["path"],"count":closed["count"],"size":closed["size"],"reason":"session-change"}}))?;
                }
                let capture_id = uuid::Uuid::new_v4().to_string();
                let root = config.and_then(|value| value.get("dataDir")).and_then(Value::as_str).ok_or("configured DATA_DIR missing")?;
                let mut writer = CaptureWriter::new(PathBuf::from(root).as_path(), game, &capture_id)?;
                if let Some((bytes, time_ms)) = frame { writer.write(bytes, Some(time_ms))?; }
                if let Some(object) = data.as_object_mut() {
                    object.insert("captureId".into(), json!(capture_id));
                    object.insert("rawFile".into(), json!(writer.path().to_string_lossy()));
                    object.insert("sparse".into(), json!(true));
                    object.insert("detectorVersion".into(), json!("rust-recorder_v1"));
                }
                captures.insert(game.to_owned(), ActiveCapture { id: capture_id.clone(), writer });
                emit_event(out, event_sequence, &capture_id, json!({"kind":kind,"data":data}))?;
            }
            "RECORDING_COMPLETED" => {
                let Some(mut capture) = captures.remove(game) else { continue; };
                let capture_id = capture.id.clone();
                let closed = capture.writer.close()?;
                if let Some(object) = data.as_object_mut() {
                    object.insert("gameId".into(), json!(game));
                    object.insert("captureId".into(), json!(capture_id));
                    object.insert("path".into(), closed["path"].clone());
                    object.insert("count".into(), closed["count"].clone());
                    object.insert("size".into(), closed["size"].clone());
                }
                emit_event(out, event_sequence, &capture_id, json!({"kind":kind,"data":data}))?;
            }
            _ => {
                if let Some(capture) = captures.get_mut(game) {
                    if kind == "LAP_RECORDED" { capture.writer.flush()?; }
                    emit_event(out, event_sequence, &capture.id, json!({"kind":kind,"data":data}))?;
                }
            }
        }
    }
    Ok(())
}
fn decode_debug_triplet(game: &str, bytes: &[u8]) -> Option<[Vec<u8>; 3]> {
    let magic = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?);
    if magic != if game == "acc" { 0x5043_4341 } else { 0x5045_4341 } { return None; }
    let mut at = 12;
    let mut pages = Vec::with_capacity(3);
    for _ in 0..3 {
        let size = u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?) as usize;
        at += 4;
        let page = bytes.get(at..at.checked_add(size)?)?.to_vec();
        at += size;
        pages.push(page);
    }
    if at != bytes.len() { return None; }
    Some([pages.remove(0), pages.remove(0), pages.remove(0)])
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(TABLE[a >> 2] as char);
        out.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        out.push(if chunk.len() > 1 { TABLE[((b & 15) << 2) | (c >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[c & 63] as char } else { '=' });
    }
    out
}

fn emit_event(out: &Outbox, sequence: &mut u64, capture_id: &str, event: Value) -> Result<(), String> {
    *sequence = sequence.checked_add(1).ok_or("event sequence overflow")?;
    let envelope = json!({"eventSequence":sequence.to_string(),"captureId":capture_id,"kind":event.get("kind").and_then(Value::as_str).unwrap_or("UNKNOWN"),"data":event.get("data").cloned().unwrap_or(Value::Null)});
    send_json(out, protocol::EVENT, 0, &envelope)
}

fn record_dev_dump(source: &SourceMessage, config: Option<&Value>, dumps: &mut HashMap<String, DevDump>) -> Result<(), String> {
    let (game, bytes, time_ms) = match source {
        SourceMessage::Udp { game_id, bytes, time_ms } | SourceMessage::Native { game_id, bytes, time_ms } => (game_id.as_str(), bytes.as_slice(), *time_ms),
        _ => return Ok(()),
    };
    let Some(settings) = config else { return Ok(()); };
    if settings.get("recordingGameId").and_then(Value::as_str) != Some(game) { return Ok(()); }
    let directory = settings.get("recordingDirectory").and_then(Value::as_str).ok_or("recordingDirectory missing for development recording")?;
    if !dumps.contains_key(game) { dumps.insert(game.to_owned(), DevDump::new(directory, game)?); }
    let dump = dumps.get_mut(game).ok_or("development dump missing")?;
    if game == "acc" || game == "ac-evo" {
        let Some(pages) = decode_debug_triplet(game, bytes) else { return Ok(()); };
        dump.frame(0, &pages[0], time_ms)?;
        dump.frame(1, &pages[1], time_ms)?;
        if dump.last_static.as_deref() != Some(pages[2].as_slice()) {
            dump.frame(2, &pages[2], time_ms)?;
            dump.last_static = Some(pages[2].clone());
        }
    } else { dump.frame(0, bytes, time_ms)?; }
    Ok(())
}

fn publish_status(out: &Outbox, stats: &UdpStats, sources: &[Value], port: u64, packets_per_sec: u64) -> Result<(), String> {
    let total = stats.total.load(Ordering::Relaxed);
    let udp = json!({"receiving":stats.last_ms.load(Ordering::Relaxed)>0 && now_ms().saturating_sub(stats.last_ms.load(Ordering::Relaxed) as u64)<2000,
        "packetsPerSec":packets_per_sec,"droppedPackets":stats.dropped.load(Ordering::Relaxed),
        "totalPackets":total,"acceptedPackets":stats.parsed.load(Ordering::Relaxed),"port":port});
    let status = json!({"state":"ready","sources":sources,"udp":udp,"logger":logger::health()});
    send_json(out, protocol::STATUS, 0, &status)
}
