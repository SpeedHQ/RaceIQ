use serde_json::{json, Value};

use super::ordinal::OrdinalDetector;

#[derive(Clone)]
struct DeferredPacket {
    packet: Value,
    offset: u64,
    host_time_ms: u64,
}

/// iRacing advances its physical lap counter before publishing authoritative
/// LastLap timing. Keep that gap outside the ordinal detector, then replay the
/// original packet window once timing rolls over.
pub struct IRacingDetector {
    detector: OrdinalDetector,
    session_key: Option<String>,
    physical_lap: Option<i64>,
    skip_first_completion: bool,
    complete_initial_lap_expected: bool,
    deferred: Vec<DeferredPacket>,
    pending_unexpected_lap: Option<DeferredPacket>,
    stale_last_lap: f64,
    peak_native_current_lap: f64,
    last_active_ms: u64,
}

impl IRacingDetector {
    pub fn new() -> Result<Self, String> {
        let detector = OrdinalDetector::new("iracing")?;
        Ok(Self {
            detector,
            session_key: None,
            physical_lap: None,
            skip_first_completion: true,
            complete_initial_lap_expected: false,
            deferred: Vec::new(),
            pending_unexpected_lap: None,
            stale_last_lap: 0.0,
            peak_native_current_lap: 0.0,
            last_active_ms: 0,
        })
    }

    /// Mark that caller has established a complete-lap start before first feed.
    pub fn expect_complete_lap_start(&mut self) {
        self.complete_initial_lap_expected = true;
    }

    pub fn feed(&mut self, packet: Value, offset: u64) -> Vec<Value> {
        self.feed_at(packet, offset, 0)
    }

    pub fn feed_at(&mut self, packet: Value, offset: u64, host_time_ms: u64) -> Vec<Value> {
        self.last_active_ms = host_time_ms;
        let mut out = Vec::new();
        let lap = number(&packet, "LapNumber") as i64;
        let uid = string(&packet, "sessionUID");
        if self.session_key.as_deref() != Some(uid.as_str()) {
            self.reset_gate(&packet);
            out.extend(self.detector.feed_at(packet, offset, host_time_ms));
            return out;
        }
        if let Some(pending) = self.pending_unexpected_lap.take() {
            if lap == number(&pending.packet, "LapNumber") as i64 {
                self.accept_unexpected_lap(pending, &mut out);
            }
        }
        let Some(physical_lap) = self.physical_lap else {
            self.physical_lap = Some(lap);
            out.extend(self.detector.feed_at(packet, offset, host_time_ms));
            return out;
        };
        if lap == physical_lap {
            if self.deferred.is_empty() {
                out.extend(self.detector.feed_at(packet, offset, host_time_ms));
                return out;
            }
            self.defer(packet.clone(), offset, host_time_ms);
            if self.native_timing_rolled(&packet) {
                self.release_deferred(number(&packet, "LastLap"), &mut out);
            }
            return out;
        }
        if lap != physical_lap + 1 {
            self.pending_unexpected_lap = Some(DeferredPacket { packet, offset, host_time_ms });
            return out;
        }
        self.physical_lap = Some(lap);
        if self.skip_first_completion {
            self.skip_first_completion = false;
            out.extend(self.detector.feed_at(with_last_lap(packet, 0.0), offset, host_time_ms));
            return out;
        }
        self.deferred.clear();
        self.stale_last_lap = number(&packet, "LastLap");
        self.peak_native_current_lap = 0.0;
        self.defer(packet, offset, host_time_ms);
        out
    }

    /// Flush inactivity after ten seconds without inventing a time from a
    /// sampled peak CurrentLap value. Ordinal stale handling remains delegated.
    pub fn tick(&mut self, time_ms: u64) -> Vec<Value> {
        if !self.deferred.is_empty() {
            if time_ms.saturating_sub(self.last_active_ms) < 10_000 {
                return Vec::new();
            }
            self.clear_gate();
            return self.detector.finish("stale");
        }
        self.detector.tick(time_ms)
    }

    /// At EOF, use only observed authoritative timing; otherwise discard the
    /// unconfirmed fragment and finish through the shared ordinal detector.
    pub fn finish(&mut self, reason: &str) -> Vec<Value> {
        let mut out = Vec::new();
        if !self.deferred.is_empty() {
            let lap_time = if self.stale_last_lap > 0.0 {
                self.stale_last_lap
            } else {
                self.deferred.first().map(|p| number(&p.packet, "LastLap")).unwrap_or(0.0)
            };
            if lap_time > 0.0 {
                self.release_deferred(lap_time, &mut out);
            } else {
                self.deferred.clear();
            }
        }
        out.extend(self.detector.finish(reason));
        self.clear_gate();
        out
    }

    pub fn reset(&mut self) {
        self.detector.reset();
        self.clear_gate();
    }

    fn reset_gate(&mut self, packet: &Value) {
        self.session_key = Some(string(packet, "sessionUID"));
        self.physical_lap = Some(number(packet, "LapNumber") as i64);
        self.skip_first_completion = !self.complete_initial_lap_expected;
        self.complete_initial_lap_expected = false;
        self.deferred.clear();
        self.pending_unexpected_lap = None;
        self.stale_last_lap = number(packet, "LastLap");
        self.peak_native_current_lap = number(packet, "iracing.sdkCurrentLapTime");
    }

    fn clear_gate(&mut self) {
        self.session_key = None;
        self.physical_lap = None;
        self.skip_first_completion = true;
        self.deferred.clear();
        self.pending_unexpected_lap = None;
        self.stale_last_lap = 0.0;
        self.peak_native_current_lap = 0.0;
        self.last_active_ms = 0;
    }

    fn defer(&mut self, packet: Value, offset: u64, host_time_ms: u64) {
        self.peak_native_current_lap = self.peak_native_current_lap.max(number(&packet, "iracing.sdkCurrentLapTime"));
        self.deferred.push(DeferredPacket { packet, offset, host_time_ms });
    }

    fn native_timing_rolled(&self, packet: &Value) -> bool {
        let last_lap = number(packet, "LastLap");
        let last_lap_changed = last_lap > 0.0 && (last_lap - self.stale_last_lap).abs() > 0.0001;
        let current = number(packet, "iracing.sdkCurrentLapTime");
        last_lap_changed || (current > 0.0 && self.peak_native_current_lap > 10.0
            && current < 5.0_f64.min(self.peak_native_current_lap * 0.5))
    }

    fn release_deferred(&mut self, lap_time: f64, out: &mut Vec<Value>) {
        let mut entries = std::mem::take(&mut self.deferred).into_iter();
        let Some(boundary) = entries.next() else { return; };
        self.detector.set_next_override(boundary.offset, "LastLap", json!(lap_time));
        out.extend(self.detector.feed_at(
            with_last_lap(boundary.packet, lap_time), boundary.offset, boundary.host_time_ms,
        ));
        for entry in entries {
            out.extend(self.detector.feed_at(entry.packet, entry.offset, entry.host_time_ms));
        }
    }

    fn accept_unexpected_lap(&mut self, entry: DeferredPacket, out: &mut Vec<Value>) {
        self.deferred.clear();
        self.physical_lap = Some(number(&entry.packet, "LapNumber") as i64);
        self.skip_first_completion = true;
        out.extend(self.detector.feed_at(entry.packet, entry.offset, entry.host_time_ms));
    }
}

fn number(packet: &Value, key: &str) -> f64 {
    packet.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn string(packet: &Value, key: &str) -> String {
    packet.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn with_last_lap(mut packet: Value, lap_time: f64) -> Value {
    if let Some(object) = packet.as_object_mut() {
        object.insert("LastLap".to_owned(), json!(lap_time));
    }
    packet
}
