//! Windows-only native source primitives. Mapping handles and views are owned
//! together so disconnect always unmaps before closing the kernel object.
use crate::games::generated::layouts as layout;
/// Exact Kunos raw capture envelope, with unresolved metadata sentinels. Parser
/// resolves identity from the embedded source pages just as replay does.
pub fn pack_kunos_triplet(game_id: &str, physics: &[u8], graphics: &[u8], static_data: &[u8]) -> Vec<u8> {
    let magic: u32 = if game_id == "acc" { 0x5043_4341 } else { 0x5045_4341 };
    let capacity = 24 + physics.len() + graphics.len() + static_data.len();
    let mut out = Vec::with_capacity(capacity);
    out.extend_from_slice(&magic.to_le_bytes());
    out.extend_from_slice(&(-1i32).to_le_bytes());
    out.extend_from_slice(&(-1i32).to_le_bytes());
    for bytes in [physics, graphics, static_data] {
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}


/// LMU lock-free consistency rule: compare exactly consumed regions.
pub fn lmu_consumed_regions_match(first: &[u8], second: &[u8]) -> bool {
    let header = layout::LMU_LMU_TELEMETRY_HEADER_OFFSET as usize;
    let scoring = layout::LMU_LMU_SCORING_INFO_OFFSET as usize;
    let vehicles = layout::LMU_LMU_SCORING_VEHICLES_OFFSET as usize;
    let vehicle_size = layout::LMU_LMU_SCORING_VEHICLE_SIZE as usize;
    let telemetry = layout::LMU_LMU_TELEMETRY_INFO_OFFSET as usize;
    let telemetry_size = layout::LMU_LMU_TELEMETRY_INFO_SIZE as usize;
    let memory_size = layout::LMU_LMU_SHARED_MEMORY_SIZE as usize;
    let max_vehicles = layout::LMU_LMU_MAX_VEHICLES as usize;
    if first.len() < memory_size || second.len() < memory_size || first[..72] != second[..72] { return false; }
    let count_at = scoring + layout::LMU_LMU_SCORING_INFO_NUMBER_OF_VEHICLES;
    let count = i32::from_le_bytes(first[count_at..count_at + 4].try_into().unwrap());
    if !(0..=max_vehicles as i32).contains(&count) { return false; }
    let scoring_end = vehicles + count as usize * vehicle_size;
    if first[scoring..scoring_end] != second[scoring..scoring_end] || first[header..telemetry] != second[header..telemetry] { return false; }
    let active = first[header] as usize;
    let player = first[header + 1] as usize;
    if first[header + 2] == 0 || active == 0 || active > max_vehicles || player >= active { return false; }
    let begin = telemetry + player * telemetry_size;
    first[begin..begin + telemetry_size] == second[begin..begin + telemetry_size]
}

// Windows service primitives follow below.

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappingRange {
    pub offset: usize,
    pub length: usize,
    pub mapping_size: usize,
}

impl MappingRange {
    pub fn valid(self, maximum: usize) -> bool {
        self.length > 0
            && self.length <= maximum
            && self.offset.checked_add(self.length).is_some_and(|end| end <= self.mapping_size && end <= maximum)
    }
}

#[cfg(windows)]
mod platform {
    use super::{Duration, MappingRange};
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
            Memory::{MapViewOfFile, UnmapViewOfFile, VirtualQuery, MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS, MEM_COMMIT, FILE_MAP_READ},
        },
    };

    pub struct ReadOnlyMapping { handle: HANDLE, view: *const u8, size: usize }
    unsafe impl Send for ReadOnlyMapping {}

    impl ReadOnlyMapping {
        pub fn open(name: &str, minimum_size: usize) -> Result<Self, String> {
            let wide: Vec<u16> = OsStr::new(name).encode_wide().chain(Some(0)).collect();
            let handle = unsafe { windows_sys::Win32::System::Memory::OpenFileMappingW(FILE_MAP_READ, 0, wide.as_ptr()) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE { return Err(format!("mapping unavailable: {name}")); }
            let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) }.Value as *const u8;
            if view.is_null() { unsafe { CloseHandle(handle); } return Err(format!("mapping view unavailable: {name}")); }
            let mut info: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
            let written = unsafe { VirtualQuery(view.cast(), &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) };
            if written == 0 || info.State != MEM_COMMIT || info.BaseAddress != view.cast() || info.RegionSize < minimum_size {
                unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: view.cast_mut().cast() }); CloseHandle(handle); }
                return Err(format!("mapping range invalid: {name}"));
            }
            Ok(Self { handle, view, size: info.RegionSize })
        }
        pub fn size(&self) -> usize { self.size }
        pub fn copy_into(&self, range: MappingRange, bytes: &mut [u8]) -> Result<(), String> {
            if range.mapping_size != self.size || !range.valid(self.size) || bytes.len() != range.length {
                return Err("shared-memory read outside mapped region".into());
            }
            std::sync::atomic::compiler_fence(Ordering::SeqCst);
            unsafe { std::ptr::copy_nonoverlapping(self.view.add(range.offset), bytes.as_mut_ptr(), range.length); }
            std::sync::atomic::compiler_fence(Ordering::SeqCst);
            Ok(())
        }
        pub fn copy(&self, range: MappingRange) -> Result<Vec<u8>, String> {
            if range.mapping_size != self.size || !range.valid(self.size) { return Err("shared-memory read outside mapped region".into()); }
            let mut bytes = vec![0; range.length];
            self.copy_into(range, &mut bytes)?;
            Ok(bytes)
        }
        pub fn stable_copy(&self, range: MappingRange) -> Result<Option<Vec<u8>>, String> {
            let first = self.copy(range)?;
            let second = self.copy(range)?;
            Ok((first == second).then_some(first))
        }
    }
    impl Drop for ReadOnlyMapping {
        fn drop(&mut self) { unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.view.cast_mut().cast() }); CloseHandle(self.handle); } }
    }

    fn process_names() -> Result<std::collections::HashSet<String>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() { return Err("process snapshot failed".into()); }
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut names = std::collections::HashSet::new();
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            names.insert(String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase());
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot); }
        Ok(names)
    }

    /// Poll configured registry process names at 2-second cadence; callbacks run
    /// only on transitions. Stop is observed in interruptible <=100ms slices.
    pub fn spawn_process_monitor(
        games: Vec<(String, Vec<String>)>,
        stop: Arc<AtomicBool>,
        mut changed: impl FnMut(String, bool) + Send + 'static,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let mut prior = std::collections::HashMap::<String, bool>::new();
            while !stop.load(Ordering::Relaxed) {
                if let Ok(names) = process_names() {
                    for (game, candidates) in &games {
                        let active = candidates.iter().any(|name| {
                            let name = name.to_ascii_lowercase();
                            let exe = if name.ends_with(".exe") { name } else { format!("{name}.exe") };
                            names.contains(&exe)
                        });
                        if prior.get(game) != Some(&active) { prior.insert(game.clone(), active); changed(game.clone(), active); }
                    }
                }
                for _ in 0..20 { if stop.load(Ordering::Relaxed) { break; } thread::sleep(Duration::from_millis(100)); }
            }
        })
    }

    struct TimerResolution;
    impl TimerResolution {
        fn acquire() -> Self { unsafe { windows_sys::Win32::Media::Multimedia::timeBeginPeriod(1); } Self }
    }
    impl Drop for TimerResolution {
        fn drop(&mut self) { unsafe { windows_sys::Win32::Media::Multimedia::timeEndPeriod(1); } }
    }

    fn report_progress(sender: &crate::engine::SourceSender, game: &str, last_frame: Option<std::time::Instant>) -> Result<(), String> {
        let age = last_frame.map(|time| time.elapsed().as_millis() as u64);
        sender.try_send(crate::engine::SourceMessage::Status(serde_json::json!({
            "gameId": game,
            "state": if age.is_some_and(|age| age < 10_000) { "receiving" } else { "disconnected" },
            "processActive": true,
            "worker": {"name": format!("native-{game}"), "state": "running", "progressAgeMs": 0},
            "lastFrameAgeMs": age
        })))
    }

    fn epoch_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
    }
    fn pause(stop: &AtomicBool, duration: Duration) {
        let end = std::time::Instant::now() + duration;
        while !stop.load(Ordering::Relaxed) {
            let left = end.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() { break; }
            thread::sleep(left.min(Duration::from_millis(100)));
        }
    }
    fn wait_for_game(stop: &AtomicBool, active: &AtomicBool) {
        while !stop.load(Ordering::Relaxed) && !active.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn spawn_lmu_source(
        sender: crate::engine::SourceSender,
        stop: Arc<AtomicBool>,
        active: Arc<AtomicBool>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let range_size = layout::LMU_LMU_SHARED_MEMORY_SIZE as usize;
            let mut last_key = None;
            while !stop.load(Ordering::Relaxed) {
                wait_for_game(&stop, &active);
                if stop.load(Ordering::Relaxed) { break; }
                let mapping = match ReadOnlyMapping::open("LMU_Data", range_size) {
                    Ok(mapping) => mapping,
                    Err(_) => { pause(&stop, Duration::from_secs(2)); continue; }
                };
                if mapping.size() < range_size { pause(&stop, Duration::from_secs(2)); continue; }
                let _timer = TimerResolution::acquire();
                let mut next = std::time::Instant::now();
                let mut last_report = std::time::Instant::now();
                let mut last_frame = None;
                let mut first = vec![0; range_size];
                let mut second = vec![0; range_size];
                while !stop.load(Ordering::Relaxed) && active.load(Ordering::Relaxed) {
                    next += Duration::from_millis(10);
                    if last_report.elapsed() >= Duration::from_secs(1) {
                        if report_progress(&sender, "lmu", last_frame).is_err() { return; }
                        last_report = std::time::Instant::now();
                    }
                    let range = MappingRange { offset: 0, length: range_size, mapping_size: mapping.size() };
                    if mapping.copy_into(range, &mut first).is_err() || mapping.copy_into(range, &mut second).is_err() { break; }
                    if super::lmu_consumed_regions_match(&first, &second) {
                        let time_ms = epoch_ms();
                        if let Some(frame) = crate::games::lmu::encode_lmu_source_frame(&first, time_ms as f64) {
                            let player = first[layout::LMU_LMU_TELEMETRY_HEADER_OFFSET as usize + 1] as usize;
                            let elapsed_at = layout::LMU_LMU_TELEMETRY_INFO_OFFSET as usize + player * layout::LMU_LMU_TELEMETRY_INFO_SIZE as usize + layout::LMU_LMU_TELEMETRY_ELAPSED_TIME;
                            let event_at = layout::LMU_LMU_SESSION_EVENT_OFFSET as usize;
                            let key = (u32::from_le_bytes(first[event_at..event_at + 4].try_into().unwrap()), u64::from_le_bytes(first[elapsed_at..elapsed_at + 8].try_into().unwrap()));
                            if last_key != Some(key) {
                                last_key = Some(key);
                                last_frame = Some(std::time::Instant::now());
                                if sender.try_send(crate::engine::SourceMessage::Native { game_id: "lmu".into(), bytes: frame, time_ms }).is_err() { return; }
                            }
                        }
                    }

                    let now = std::time::Instant::now();
                    if now < next { thread::sleep(next - now); } else { next = now; }
                }
                drop(mapping);
                pause(&stop, Duration::from_secs(2));
            }
        })
    }

    pub fn spawn_kunos_source(
        game: &'static str,
        stop: Arc<AtomicBool>,
        sender: crate::engine::SourceSender,
        active: Arc<AtomicBool>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let (physics_name, graphics_name, static_name, physics_size, graphics_size, static_size, session_offset) = if game == "acc" {
                ("Local\\acpmf_physics", "Local\\acpmf_graphics", "Local\\acpmf_static", layout::ACC_PHYSICS_SIZE, layout::ACC_GRAPHICS_SIZE, layout::ACC_STATIC_SIZE, Some(layout::ACC_GRAPHICS_SESSION))
            } else {
                ("Local\\acevo_pmf_physics", "Local\\acevo_pmf_graphics", "Local\\acevo_pmf_static", layout::EVO_PHYSICS_SIZE, layout::EVO_GRAPHICS_EVO_SIZE, layout::EVO_STATIC_EVO_SIZE, None)
            };
            while !stop.load(Ordering::Relaxed) {
                wait_for_game(&stop, &active);
                if stop.load(Ordering::Relaxed) { break; }
                let maps = (
                    ReadOnlyMapping::open(physics_name, physics_size),
                    ReadOnlyMapping::open(graphics_name, graphics_size),
                    ReadOnlyMapping::open(static_name, static_size),
                );
                let (Ok(physics_map), Ok(graphics_map), Ok(static_map)) = maps else { pause(&stop, Duration::from_secs(10)); continue };
                let _timer = TimerResolution::acquire();
                let mut physics = vec![0; physics_size];
                let mut graphics = vec![0; graphics_size];
                let mut static_data = vec![0; static_size];
                let mut physics_ready = false;
                let mut graphics_ready = false;
                let mut static_ready = false;
                let mut session_id = None;
                let mut static_read_at = std::time::Instant::now();
                let mut physics_deadline = std::time::Instant::now();
                let mut graphics_deadline = physics_deadline;
                let mut assembly_deadline = physics_deadline;
                let mut last_report = std::time::Instant::now();
                let mut last_frame = None;
                while !stop.load(Ordering::Relaxed) && active.load(Ordering::Relaxed) {
                    let now = std::time::Instant::now();
                    if last_report.elapsed() >= Duration::from_secs(1) {
                        if report_progress(&sender, game, last_frame).is_err() { return; }
                        last_report = std::time::Instant::now();
                    }
                    if now >= physics_deadline {
                        physics_deadline += Duration::from_nanos(3_333_333);
                        if physics_map.copy_into(MappingRange { offset: 0, length: physics_size, mapping_size: physics_map.size() }, &mut physics).is_err() { break; }
                        physics_ready = true;
                    }
                    if now >= graphics_deadline {
                        graphics_deadline += Duration::from_nanos(16_666_667);
                        if graphics_map.copy_into(MappingRange { offset: 0, length: graphics_size, mapping_size: graphics_map.size() }, &mut graphics).is_err() { break; }
                        graphics_ready = true;
                        let refresh_static = if let Some(offset) = session_offset {
                            let current = i32::from_le_bytes(graphics[offset..offset + 4].try_into().unwrap());
                            let changed = session_id != Some(current);
                            session_id = Some(current);
                            changed
                        } else { !static_ready || (game == "ac-evo" && static_read_at.elapsed() >= Duration::from_secs(1)) };
                        if refresh_static {
                            if static_map.copy_into(MappingRange { offset: 0, length: static_size, mapping_size: static_map.size() }, &mut static_data).is_err() { break; }
                            static_ready = true;
                            static_read_at = now;
                        }
                    }
                    if now >= assembly_deadline {
                        assembly_deadline += Duration::from_millis(10);
                        if physics_ready && graphics_ready && static_ready {
                            last_frame = Some(std::time::Instant::now());
                            let bytes = super::pack_kunos_triplet(game, &physics, &graphics, &static_data);
                            if sender.try_send(crate::engine::SourceMessage::Native { game_id: game.into(), bytes, time_ms: epoch_ms() }).is_err() { return; }
                        }
                    }
                    let deadline = physics_deadline.min(graphics_deadline).min(assembly_deadline);
                    let sleep = deadline.saturating_duration_since(std::time::Instant::now());
                    if !sleep.is_zero() { thread::sleep(sleep.min(Duration::from_millis(1))); }
                }
                drop((physics_map, graphics_map, static_map));
                pause(&stop, Duration::from_secs(10));
            }
        })
    }
    #[derive(Clone)]
    struct SdkHeader { status: i32, revision: i32, session_len: usize, session_offset: usize, vars: usize, vars_offset: usize, buffer_count: usize, row_len: usize, buffers: [(i32, usize); layout::IRACING_SDK_IRSDK_MAX_BUFFERS] }

    fn sdk_header(b: &[u8]) -> Option<SdkHeader> {
        let header_size = layout::IRACING_SDK_IRSDK_HEADER_SIZE;
        if b.len() < header_size { return None; }
        let i = |o: usize| i32::from_le_bytes(b.get(o..o+4)?.try_into().ok()?);
        let count = i(32)?;
        if !(1..=layout::IRACING_SDK_IRSDK_MAX_BUFFERS as i32).contains(&count) { return None; }
        let mut buffers = [(0, 0); layout::IRACING_SDK_IRSDK_MAX_BUFFERS];
        for (n, buffer) in buffers[..count as usize].iter_mut().enumerate() { let o = 48 + n * 16; *buffer = (i(o)?, usize::try_from(i(o+4)?).ok()?); }
        Some(SdkHeader { status:i(4)?, revision:i(12)?, session_len:usize::try_from(i(16)?).ok()?, session_offset:usize::try_from(i(20)?).ok()?, vars:usize::try_from(i(24)?).ok()?, vars_offset:usize::try_from(i(28)?).ok()?, buffer_count:count as usize, row_len:usize::try_from(i(36)?).ok()?, buffers })
    }
    fn sdk_range(mapping: &ReadOnlyMapping, off: usize, len: usize, limit: usize) -> Option<Vec<u8>> {
        let range = MappingRange { offset:off,length:len,mapping_size:mapping.size() };
        (len <= limit && range.valid(layout::IRACING_SDK_MAX_MAPPING_OFFSET)).then_some(())?;
        mapping.copy(range).ok()
    }
    fn sdk_usable(h: &SdkHeader, size: usize) -> bool {
        h.vars > 0 && h.vars <= layout::IRACING_SDK_MAX_VARIABLES && h.row_len > 0 && h.row_len <= layout::IRACING_SDK_MAX_BUFFER_LENGTH && h.buffer_count <= layout::IRACING_SDK_IRSDK_MAX_BUFFERS
            && h.vars.checked_mul(layout::IRACING_IRSDK_VAR_HEADER_SIZE as usize).is_some_and(|n|sdk_range_bounds(h.vars_offset,n,size,layout::IRACING_SDK_MAX_VARIABLES * layout::IRACING_IRSDK_VAR_HEADER_SIZE as usize))
            && sdk_range_bounds(h.session_offset,h.session_len,size,layout::IRACING_SDK_MAX_SESSION_INFO_LENGTH)
            && h.buffers[..h.buffer_count].iter().all(|(_,off)|sdk_range_bounds(*off,h.row_len,size,layout::IRACING_SDK_MAX_BUFFER_LENGTH))
    }
    fn sdk_range_bounds(off: usize,len:usize,size:usize,limit:usize)->bool { len>0 && len<=limit && off.checked_add(len).is_some_and(|end|end<=size && end<=layout::IRACING_SDK_MAX_MAPPING_OFFSET) }
    fn sdk_str(bytes:&[u8])->String { String::from_utf8_lossy(&bytes[..bytes.iter().position(|b|*b==0).unwrap_or(bytes.len())]).trim().to_owned() }
    fn sdk_values(desc:&[u8],row:&[u8])->Option<serde_json::Map<String,serde_json::Value>> {
        use serde_json::Value;
        let mut out=serde_json::Map::new();
        for d in desc.chunks_exact(layout::IRACING_IRSDK_VAR_HEADER_SIZE as usize) {
            let ty=i32::from_le_bytes(d[0..4].try_into().ok()?);
            let off=usize::try_from(i32::from_le_bytes(d[4..8].try_into().ok()?)).ok()?;
            let count=usize::try_from(i32::from_le_bytes(d[8..12].try_into().ok()?)).ok()?;
            let name=sdk_str(&d[16..48]); if name.is_empty()||count==0||count>layout::IRACING_SDK_MAX_VARIABLES {continue}
            if ty==layout::IRACING_IRSDKVARIABLE_TYPE_CHAR as i32 {
                let end=off.checked_add(count)?;let s=sdk_str(row.get(off..end)?);out.insert(name,Value::String(s));continue
            }
            let size=match ty {t if t==layout::IRACING_IRSDKVARIABLE_TYPE_BOOL as i32=>1,t if t==layout::IRACING_IRSDKVARIABLE_TYPE_INT as i32||t==layout::IRACING_IRSDKVARIABLE_TYPE_BIT_FIELD as i32||t==layout::IRACING_IRSDKVARIABLE_TYPE_FLOAT as i32=>4,t if t==layout::IRACING_IRSDKVARIABLE_TYPE_DOUBLE as i32=>8,_=>continue};
            if off.checked_add(count.checked_mul(size)?)?>row.len(){continue}
            let mut vals=Vec::with_capacity(count);
            for n in 0..count {
                let x=&row[off+n*size..off+(n+1)*size];
                let v=match ty {t if t==layout::IRACING_IRSDKVARIABLE_TYPE_BOOL as i32=>Some(Value::Bool(x[0]!=0)),t if t==layout::IRACING_IRSDKVARIABLE_TYPE_INT as i32=>Value::from(i32::from_le_bytes(x.try_into().ok()?) as f64),t if t==layout::IRACING_IRSDKVARIABLE_TYPE_BIT_FIELD as i32=>Value::from(u32::from_le_bytes(x.try_into().ok()?) as f64),t if t==layout::IRACING_IRSDKVARIABLE_TYPE_FLOAT as i32=>Value::from(f32::from_le_bytes(x.try_into().ok()?) as f64),t if t==layout::IRACING_IRSDKVARIABLE_TYPE_DOUBLE as i32=>Value::from(f64::from_le_bytes(x.try_into().ok()?)),_=>None};
                let Some(v)=v else { vals.clear(); break; }; vals.push(v);
            }
            if vals.len()==count { out.insert(name,if count==1 { vals.pop().unwrap() } else {Value::Array(vals)}); }
        }
        Some(out)
    }
    fn yaml_scalar(yaml:&str,key:&str)->Option<String> {
        yaml.lines().find_map(|line| { let (k,v)=line.trim().split_once(':')?; (k==key).then(||yaml_unquote(v)) })
    }
    fn yaml_unquote(value:&str)->String {
        let value=value.trim();
        value.strip_prefix('"').and_then(|v|v.strip_suffix('"'))
            .or_else(||value.strip_prefix("'").and_then(|v|v.strip_suffix("'")))
            .unwrap_or(value).to_owned()
    }

    fn yaml_num(yaml:&str,key:&str,default:f64)->f64 { yaml_scalar(yaml,key).and_then(|v|v.parse().ok()).filter(|n:f64|n.is_finite()).unwrap_or(default) }
    fn iracing_session(yaml:&str,session_num:i64)->serde_json::Value {
        let driver_idx=yaml_num(yaml,"DriverCarIdx",-1.);
        let mut drivers=Vec::<std::collections::HashMap<String,String>>::new();
        let mut in_drivers=false;let mut current=None;
        for line in yaml.lines() {
            if line.trim()=="Drivers:" {in_drivers=true;continue}
            if !in_drivers {continue}
            let t=line.trim();
            if let Some(item)=t.strip_prefix("- ") {let mut m=std::collections::HashMap::new();if let Some((k,v))=item.split_once(':'){m.insert(k.to_owned(),yaml_unquote(v));}drivers.push(m);current=drivers.last_mut();continue}
            if let Some(m)=current.as_mut(){if let Some((k,v))=t.split_once(':'){if !k.contains(' '){m.insert(k.to_owned(),yaml_unquote(v));}}}
            if t.is_empty() {continue}
            if line.starts_with("WeekendInfo:") {break}
        }
        let driver=drivers.iter().find(|d|d.get("CarIdx").and_then(|v|v.parse::<f64>().ok())==Some(driver_idx));
        let track_length=yaml_scalar(yaml,"TrackLength").and_then(|v| {
            let split=v.find(|c:char| !(c.is_ascii_digit()||c=='.'||c=='-')).unwrap_or(v.len());
            let n=v[..split].parse::<f64>().ok()?;let unit=v[split..].trim().to_ascii_lowercase();
            Some(n*match unit.as_str(){"km"=>1000.,"mi"=>1609.344,"ft"=>0.3048,_=>1.})
        }).unwrap_or(0.);
        let sector_starts:Vec<f64>=yaml.split("SplitTimeInfo:").nth(1).into_iter().flat_map(|s|s.lines().take_while(|line|line.starts_with(' ')||line.starts_with('\t')).filter_map(|line|line.trim().strip_prefix("SectorStartPct:").and_then(|v|v.trim().parse::<f64>().ok()).filter(|v|*v>=0.&&*v<1.))).collect();
        let sector_starts=if sector_starts.len()>=2 {serde_json::json!(sector_starts)}else{serde_json::Value::Null};
        serde_json::json!({"sessionId":yaml_num(yaml,"SessionID",0.),"subSessionId":yaml_num(yaml,"SubSessionID",0.),"sessionNum":session_num,"driverCarIdx":driver_idx,"trackId":yaml_num(yaml,"TrackID",-1.),"trackName":yaml_scalar(yaml,"TrackDisplayName").or_else(||yaml_scalar(yaml,"TrackDisplayShortName")).or_else(||yaml_scalar(yaml,"TrackName")).unwrap_or_else(||"Unknown iRacing track".into()),"trackLengthM":track_length,"sectorStarts":sector_starts,"carId":driver.and_then(|d|d.get("CarID")).and_then(|v|v.parse::<f64>().ok()).unwrap_or(-1.),"carName":driver.and_then(|d|d.get("CarScreenName").or_else(||d.get("CarScreenNameShort")).or_else(||d.get("CarPath"))).cloned().unwrap_or_else(||"Unknown iRacing car".into()),"carClassId":driver.and_then(|d|d.get("CarClassID")).and_then(|v|v.parse::<f64>().ok()).unwrap_or(-1.),"carClassName":driver.and_then(|d|d.get("CarClassShortName").or_else(||d.get("CarClassRelSpeed"))).cloned().unwrap_or_else(||"Unknown class".into()),"engineIdleRpm":yaml_num(yaml,"DriverCarIdleRPM",0.),"engineRedlineRpm":yaml_num(yaml,"DriverCarRedLine",0.),"engineCylinderCount":yaml_num(yaml,"DriverCarEngCylinderCount",0.)})
    }

    pub fn spawn_iracing_source(sender:crate::engine::SourceSender,stop:Arc<AtomicBool>,active:Arc<AtomicBool>)->thread::JoinHandle<()> {
        thread::spawn(move || {
            let mut previous_tick=None;let mut previous_values=None;let mut signature=String::new();let mut cached_yaml=String::new();let mut cached_revision=-1;let mut cached_session=serde_json::Value::Null;let mut next_connect=std::time::Instant::now();
            while !stop.load(Ordering::Relaxed) {
                wait_for_game(&stop, &active);
                if stop.load(Ordering::Relaxed) { break; }
                if std::time::Instant::now()<next_connect {pause(&stop,Duration::from_millis(100));continue}
                let map=match ReadOnlyMapping::open("Local\\IRSDKMemMapFileName",layout::IRACING_SDK_IRSDK_HEADER_SIZE){Ok(m)=>m,Err(_)=>{next_connect=std::time::Instant::now()+Duration::from_secs(2);continue}};
                let mut last_report = std::time::Instant::now();
                let mut last_frame = None;
                while !stop.load(Ordering::Relaxed) && active.load(Ordering::Relaxed) {
                    let Some(hbytes)=sdk_range(&map,0,layout::IRACING_SDK_IRSDK_HEADER_SIZE,layout::IRACING_SDK_IRSDK_HEADER_SIZE) else {break};
                    if last_report.elapsed() >= Duration::from_secs(1) {
                        if report_progress(&sender, "iracing", last_frame).is_err() { return; }
                        last_report = std::time::Instant::now();
                    }
                    let Some(before)=sdk_header(&hbytes) else {break};
                    if before.status&layout::IRACING_SDK_IRSDK_CONNECTED as i32==0 || !sdk_usable(&before,map.size()) {break}
                    let Some((tick,offset))=before.buffers[..before.buffer_count].iter().max_by_key(|(tick,_)|tick).copied() else {break};
                    if previous_tick==Some(tick){pause(&stop,Duration::from_micros(4167));continue}
                    let sig=format!("{}:{}:{}",before.vars,before.vars_offset,before.row_len);
                    let Some(desc)=sdk_range(&map,before.vars_offset,before.vars*layout::IRACING_IRSDK_VAR_HEADER_SIZE as usize,layout::IRACING_SDK_MAX_VARIABLES*layout::IRACING_IRSDK_VAR_HEADER_SIZE as usize) else {break};
                    let Some(yaml_bytes)=sdk_range(&map,before.session_offset,before.session_len,layout::IRACING_SDK_MAX_SESSION_INFO_LENGTH) else {break};
                    let yaml=sdk_str(&yaml_bytes);
                    let Some(row)=sdk_range(&map,offset,before.row_len,layout::IRACING_SDK_MAX_BUFFER_LENGTH) else {break};
                    let Some(after_bytes)=sdk_range(&map,0,layout::IRACING_SDK_IRSDK_HEADER_SIZE,layout::IRACING_SDK_IRSDK_HEADER_SIZE) else {break};
                    let Some(after)=sdk_header(&after_bytes) else {break};
                    if after.revision!=before.revision || after.vars!=before.vars || after.vars_offset!=before.vars_offset || after.row_len!=before.row_len || after.session_offset!=before.session_offset || after.session_len!=before.session_len || !after.buffers[..after.buffer_count].iter().any(|(t,o)|*o==offset&&*t==tick) {continue}
                    let Some(values)=sdk_values(&desc,&row) else {break};
                    let session_num=values.get("SessionNum").and_then(|v|v.as_f64()).map(|n|n.trunc() as i64).unwrap_or(0);
                    let session=iracing_session(&yaml,session_num);
                    let schema_changed=signature!=sig||cached_yaml!=yaml||cached_revision!=before.revision||cached_session!=session;
                    let frame=if schema_changed {
                        signature=sig;cached_yaml=yaml.clone();cached_revision=before.revision;cached_session=session.clone();previous_values=Some(values.clone());
                        crate::games::iracing::encode_session(&serde_json::json!({"schemaVersion":3,"session":session,"values":values,"sessionInfo":yaml,"sessionInfoUpdate":before.revision}))
                    } else {
                        let prev=previous_values.replace(values.clone()).unwrap_or_default();
                        crate::games::iracing::encode_delta(&serde_json::json!({"schemaVersion":3,"values":values,"previousValues":prev}))
                    };
                    match frame {
                        Ok(bytes)=>{previous_tick=Some(tick); last_frame=Some(std::time::Instant::now()); if sender.try_send(crate::engine::SourceMessage::Native{game_id:"iracing".into(),bytes,time_ms:epoch_ms()}).is_err(){return;}}
                        Err(e)=>{let _=sender.try_send(crate::engine::SourceMessage::Failure(e));break}
                    }
                    pause(&stop,Duration::from_micros(4167));
                }
                drop(map);previous_tick=None;previous_values=None;next_connect=std::time::Instant::now()+Duration::from_secs(2);
            }
        })
    }
}

/// Starts configured Windows native sources. Process names come from the
/// immutable game registry supplied at configure time.
#[cfg(windows)]
    pub fn start(
        config: &serde_json::Value,
        sender: crate::engine::SourceSender,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Vec<std::thread::JoinHandle<()>>, String> {
    let games = config.get("games").and_then(serde_json::Value::as_array).ok_or("configure.games must be an array")?;
    let mut process_games = Vec::new();
    let mut active_flags = std::collections::HashMap::<String, std::sync::Arc<std::sync::atomic::AtomicBool>>::new();
    for game in games {
        let Some(id) = game.get("id").and_then(serde_json::Value::as_str) else { continue };
        let names = game.get("processNames").and_then(serde_json::Value::as_array).into_iter().flatten()
            .filter_map(serde_json::Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        process_games.push((id.to_owned(), names));
        active_flags.insert(id.to_owned(), std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)));
    }
    let ids = games.iter().filter_map(|g|g.get("id").and_then(serde_json::Value::as_str)).collect::<std::collections::HashSet<_>>();
    let mut handles = vec![platform::spawn_process_monitor(process_games, stop.clone(), {
        let sender = sender.clone();
        let active_flags = active_flags.clone();
        move |game_id, running| {
            if let Some(active) = active_flags.get(&game_id) { active.store(running, std::sync::atomic::Ordering::Relaxed); }
            let _ = sender.try_send(crate::engine::SourceMessage::Status(serde_json::json!({"gameId":game_id,"state":if running {"receiving"} else {"disconnected"},"processActive":running,"worker":{"name":format!("native-{game_id}"),"state":if running {"running"} else {"idle"},"progressAgeMs":0},"lastFrameAgeMs":null})));
        }
    })];
    if ids.contains("lmu") { handles.push(platform::spawn_lmu_source(sender.clone(), stop.clone(), active_flags["lmu"].clone())); }
    if ids.contains("acc") { handles.push(platform::spawn_kunos_source("acc", stop.clone(), sender.clone(), active_flags["acc"].clone())); }
    if ids.contains("ac-evo") { handles.push(platform::spawn_kunos_source("ac-evo", stop.clone(), sender.clone(), active_flags["ac-evo"].clone())); }
    let iracing_enabled = config.get("featureGates").and_then(|g|g.get("iracing")).and_then(serde_json::Value::as_bool).unwrap_or(true);
    if ids.contains("iracing") && iracing_enabled { handles.push(platform::spawn_iracing_source(sender, stop, active_flags["iracing"].clone())); }
    Ok(handles)
}

#[cfg(not(windows))]
pub fn start(
    _config: &serde_json::Value,
    sender: crate::engine::SourceSender,
    _stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<Vec<std::thread::JoinHandle<()>>, String> {
    let _ = sender.try_send(crate::engine::SourceMessage::Status(serde_json::json!({"nativeCapture":false,"state":"unavailable","reason":"native shared-memory acquisition is available only on Windows"})));
    Ok(Vec::new())
}

#[cfg(windows)]
pub use platform::{ReadOnlyMapping, spawn_process_monitor};

#[derive(Debug)]
pub struct ProgressClock(Instant);
impl Default for ProgressClock { fn default() -> Self { Self(Instant::now()) } }
impl ProgressClock {
    pub fn touch(&mut self) { self.0 = Instant::now(); }
    pub fn age_ms(&self) -> u64 { self.0.elapsed().as_millis().min(u64::MAX as u128) as u64 }
}

#[cfg(test)]
mod tests {
    use super::MappingRange;
    #[test]
    fn rejects_overflow_and_out_of_bounds_reads() {
        assert!(MappingRange { offset: 0, length: 112, mapping_size: 112 }.valid(64 * 1024 * 1024));
        assert!(!MappingRange { offset: 112, length: 1, mapping_size: 112 }.valid(64 * 1024 * 1024));
        assert!(!MappingRange { offset: usize::MAX, length: 2, mapping_size: usize::MAX }.valid(usize::MAX));
        assert!(!MappingRange { offset: 0, length: 65, mapping_size: 65 }.valid(64));
    }
    #[test]
    fn lmu_consistency_checks_only_consumed_regions() {
        use crate::games::generated::layouts as l;
        let mut first = vec![0u8; l::LMU_LMU_SHARED_MEMORY_SIZE as usize];
        let mut second = first.clone();
        let header = l::LMU_LMU_TELEMETRY_HEADER_OFFSET as usize;
        first[header] = 1;
        first[header + 2] = 1;
        second.copy_from_slice(&first);
        assert!(super::lmu_consumed_regions_match(&first, &second));
        second[72] = 1;
        assert!(super::lmu_consumed_regions_match(&first, &second));
        second[72] = 0;
        second[l::LMU_LMU_SCORING_INFO_OFFSET as usize + 8] = 1;
        assert!(!super::lmu_consumed_regions_match(&first, &second));
        second.copy_from_slice(&first);
        let unused_row = l::LMU_LMU_TELEMETRY_INFO_OFFSET as usize + l::LMU_LMU_TELEMETRY_INFO_SIZE as usize;
        second[unused_row] = 1;
        assert!(super::lmu_consumed_regions_match(&first, &second));
        let selected_row = l::LMU_LMU_TELEMETRY_INFO_OFFSET as usize;
        second[selected_row] = 1;
        assert!(!super::lmu_consumed_regions_match(&first, &second));
        second.copy_from_slice(&first);
        let count_at = l::LMU_LMU_SCORING_INFO_OFFSET as usize + l::LMU_LMU_SCORING_INFO_NUMBER_OF_VEHICLES;
        second[count_at..count_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(!super::lmu_consumed_regions_match(&first, &second));
    }
}

#[cfg(all(test, windows))]
mod named_mapping_tests {
    use super::{MappingRange, ReadOnlyMapping};
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Memory::{CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE},
    };

    #[test]
    fn opens_named_mapping_copies_bounded_bytes_and_releases_view() {
        let name = format!("Local\\RaceIQ-native-test-{}", std::process::id());
        let wide: Vec<u16> = OsStr::new(&name).encode_wide().chain(Some(0)).collect();
        let handle = unsafe { CreateFileMappingW(INVALID_HANDLE_VALUE, std::ptr::null(), PAGE_READWRITE, 0, 4096, wide.as_ptr()) };
        assert!(!handle.is_null());
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 4096) };
        assert!(!view.Value.is_null());
        unsafe { std::ptr::write_bytes(view.Value.cast::<u8>(), 0x5a, 4096); }
        {
            let mapping = ReadOnlyMapping::open(&name, 4096).unwrap();
            assert_eq!(mapping.copy(MappingRange { offset: 12, length: 4, mapping_size: mapping.size() }).unwrap(), [0x5a; 4]);
            assert!(mapping.copy(MappingRange { offset: 4095, length: 2, mapping_size: mapping.size() }).is_err());
            assert_eq!(mapping.stable_copy(MappingRange { offset: 0, length: 64, mapping_size: mapping.size() }).unwrap(), Some(vec![0x5a; 64]));
        }
        unsafe { UnmapViewOfFile(view); CloseHandle(handle); }
        assert!(ReadOnlyMapping::open(&name, 4096).is_err());
        let replacement = unsafe { CreateFileMappingW(INVALID_HANDLE_VALUE, std::ptr::null(), PAGE_READWRITE, 0, 4096, wide.as_ptr()) };
        assert!(!replacement.is_null());
        let replacement_view = unsafe { MapViewOfFile(replacement, FILE_MAP_ALL_ACCESS, 0, 0, 4096) };
        assert!(!replacement_view.Value.is_null());
        assert!(ReadOnlyMapping::open(&name, 4096).is_ok());
        unsafe { UnmapViewOfFile(replacement_view); CloseHandle(replacement); }
    }
}
