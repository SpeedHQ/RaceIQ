use std::sync::Arc;
use std::fmt::{self, Write};

use serde_json::{json, Value};

use super::{ordinal::OrdinalDetector, policy::{number, Sample}};

/// Numeric SDK identity stays unformatted until a session event is emitted.
#[derive(Clone, Debug)]
pub(crate) enum IRacingUid {
    Numeric([f64; 3]),
    Text(Arc<str>),
}
impl IRacingUid {
    pub(crate) fn is_empty(&self) -> bool {
        matches!(self, Self::Text(text) if text.is_empty())
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Numeric(a), Self::Numeric(b)) => a == b && a.iter().zip(b).all(|(a,b)| a.is_sign_negative()==b.is_sign_negative() || *a!=0.),
            (Self::Text(a), Self::Text(b)) => a == b,
            (Self::Numeric(_), Self::Text(text)) => self.matches_text(text),
            (Self::Text(text), Self::Numeric(_)) => other.matches_text(text),
        }
    }
    pub(crate) fn matches_text(&self, text: &str) -> bool {
        match self {
            Self::Text(value) => value.as_ref() == text,
            Self::Numeric(n) => {
                // Rust's finite f64 Display needs at most 327 bytes per component.
                let mut buffer = UidBuffer { bytes: [0; 1024], len: 0 };
                write!(&mut buffer, "{}:{}:{}", n[0], n[1], n[2]).is_ok()
                    && buffer.bytes[..buffer.len] == *text.as_bytes()
            }
        }
    }
    fn from_text(text: &str) -> Self {
        let mut parts = text.split(':');
        let numeric = (|| Some([
            parts.next()?.parse::<f64>().ok()?,
            parts.next()?.parse::<f64>().ok()?,
            parts.next()?.parse::<f64>().ok()?,
        ]))();
        if let Some(n) = numeric {
            let uid = Self::Numeric(n);
            if parts.next().is_none() && n.iter().all(|n|n.is_finite()) && uid.matches_text(text) { return uid; }
        }
        Self::Text(text.into())
    }
    pub(crate) fn value(&self) -> Value {
        match self {
            Self::Numeric(n) => json!(format!("{}:{}:{}", n[0], n[1], n[2])),
            Self::Text(text) => json!(text.as_ref()),
        }
    }
}
struct UidBuffer { bytes: [u8; 1024], len: usize }
impl fmt::Write for UidBuffer {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let end = self.len.checked_add(text.len()).ok_or(fmt::Error)?;
        self.bytes.get_mut(self.len..end).ok_or(fmt::Error)?.copy_from_slice(text.as_bytes());
        self.len = end;
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct EventIdentity {
    uid: Option<Value>,
    class: Value,
    car_id: Value,
    track_id: Value,
    session_type: Value,
}

/// Owned detector projection. Presentation-only JSON never enters deferred windows.
#[derive(Clone, Debug)]
pub struct IRacingInput {
    pub sample: Sample,
    pub timestamp: f64,
    pub car_ordinal: f64,
    pub track_ordinal: f64,
    pub car_performance_index: f64,
    pub car_class: f64,
    pub native_current_lap: f64,
    pub race_on: bool,
    pub(crate) uid: IRacingUid,
    event_identity: Option<Arc<EventIdentity>>,
}
impl IRacingInput {
    pub(crate) fn from_parser(mut sample: Sample, timestamp: f64, uid: [f64; 3], car: f64, track: f64, class: f64) -> Self {
        // Full presentation converts overflow to null; numeric projection reads null as zero.
        if !sample.current_lap.is_finite() { sample.current_lap = 0.; }
        if !sample.distance.is_finite() { sample.distance = 0.; }
        let timestamp = if timestamp.is_finite() { timestamp } else { 0. };
        Self { sample, timestamp, car_ordinal: car, track_ordinal: track,
            car_performance_index: 0., car_class: class, native_current_lap: 0.,
            race_on: false, uid: IRacingUid::Numeric(uid), event_identity: None }
    }
    #[cfg(test)]
    fn from_value(packet: &Value) -> Self { Self::from_value_cached(packet, None) }
    fn from_value_cached(packet: &Value, cached_uid: Option<&IRacingUid>) -> Self {
        let field = |key: &str| packet.get(key).cloned().unwrap_or(Value::Null);
        let lmu = packet.get("lmu").filter(|v| !v.is_null());
        let lmu_field = |key: &str| lmu.and_then(|v|v.get(key)).cloned().unwrap_or(Value::Null);
        let text = packet.get("sessionUID").and_then(Value::as_str).unwrap_or("");
        let uid = if let Some(cached) = cached_uid.filter(|uid|uid.matches_text(text)) {
            cached.clone()
        } else { IRacingUid::from_text(text) };
        let session_type = packet.get("f1").and_then(|v|v.get("sessionType")).or_else(|| lmu.and_then(|v|v.get("sessionType")));
        let scalar_identity = packet.get("sessionUID").is_some_and(Value::is_string)
            && packet.get("CarClass").and_then(Value::as_number).is_some_and(|n|n.is_f64())
            && lmu.and_then(|v|v.get("carId")).is_none_or(Value::is_null)
            && lmu.and_then(|v|v.get("trackId")).is_none_or(Value::is_null)
            && session_type.is_none_or(Value::is_null);
        let event_identity = if scalar_identity { None } else {
            Some(Arc::new(EventIdentity {
                uid: if packet.get("sessionUID").is_some_and(Value::is_string) { None } else { Some(field("sessionUID")) },
                class: field("CarClass"), car_id: lmu_field("carId"), track_id: lmu_field("trackId"),
                session_type: session_type.cloned().unwrap_or(Value::Null),
            }))
        };
        Self {
            sample: Sample::from_value(packet, 0), timestamp: number(packet, "TimestampMS"),
            car_ordinal: number(packet, "CarOrdinal"), track_ordinal: number(packet, "TrackOrdinal"),
            car_performance_index: number(packet, "CarPerformanceIndex"), car_class: number(packet, "CarClass"),
            // This is deliberately a literal key, matching the original full-input gate.
            native_current_lap: number(packet, "iracing.sdkCurrentLapTime"),
            race_on: packet.get("IsRaceOn").and_then(Value::as_bool).unwrap_or(false),
            uid,
            event_identity,
        }
    }
    pub(crate) fn event(&self, game: &str) -> Value {
        let full = self.event_identity.as_deref();
        json!({"kind":"SESSION_STARTED","data":{
            "gameId":game,"carOrdinal":self.car_ordinal,"trackOrdinal":self.track_ordinal,
            "carPerformanceIndex":self.car_performance_index,
            "carClass":full.map(|v|v.class.clone()).unwrap_or_else(||json!(self.car_class)),
            "carId":full.map(|v|&v.car_id).unwrap_or(&Value::Null),
            "trackId":full.map(|v|&v.track_id).unwrap_or(&Value::Null),
            "sessionUID":full.and_then(|v|v.uid.clone()).unwrap_or_else(||self.uid.value()),
            "sessionType":full.map(|v|&v.session_type).unwrap_or(&Value::Null),
            "detectorVersion":"rust-recorder_v1"
        }})
    }
}

struct DeferredSample {
    input: IRacingInput,
    offset: u64,
    host_time_ms: u64,
}

/// Physical lap counters advance before authoritative LastLap timing. Replay the
/// original typed sample window only once the shared timing policy confirms it.
pub struct IRacingDetector {
    detector: OrdinalDetector,
    session_key: Option<IRacingUid>,
    physical_lap: Option<i64>,
    skip_first_completion: bool,
    complete_initial_lap_expected: bool,
    deferred: Vec<DeferredSample>,
    pending_unexpected_lap: Option<DeferredSample>,
    stale_last_lap: f64,
    peak_native_current_lap: f64,
    last_active_ms: u64,
}
impl IRacingDetector {
    pub fn new() -> Result<Self, String> {
        Ok(Self { detector: OrdinalDetector::new("iracing")?, session_key: None,
            physical_lap: None, skip_first_completion: true, complete_initial_lap_expected: false,
            deferred: Vec::new(), pending_unexpected_lap: None, stale_last_lap: 0.,
            peak_native_current_lap: 0., last_active_ms: 0 })
    }
    pub fn expect_complete_lap_start(&mut self) { self.complete_initial_lap_expected = true; }
    pub fn feed(&mut self, packet: Value, offset: u64) -> Vec<Value> { self.feed_at(packet, offset, 0) }
    pub fn feed_at(&mut self, packet: Value, offset: u64, host_time_ms: u64) -> Vec<Value> {
        self.feed_ref_at(&packet, offset, host_time_ms)
    }
    pub fn feed_ref(&mut self, packet: &Value, offset: u64) -> Vec<Value> { self.feed_ref_at(packet, offset, 0) }
    pub fn feed_ref_at(&mut self, packet: &Value, offset: u64, host_time_ms: u64) -> Vec<Value> {
        let input = IRacingInput::from_value_cached(packet, self.session_key.as_ref());
        self.feed_typed_at(input, offset, host_time_ms)
    }
    pub fn feed_typed(&mut self, input: IRacingInput, offset: u64) -> Vec<Value> {
        self.feed_typed_at(input, offset, 0)
    }
    pub fn feed_typed_at(&mut self, input: IRacingInput, offset: u64, host_time_ms: u64) -> Vec<Value> {
        self.last_active_ms = host_time_ms;
        let mut out = Vec::new();
        let lap = input.sample.lap_number as i64;
        if !self.session_key.as_ref().is_some_and(|uid|uid.same(&input.uid)) {
            self.reset_gate(&input);
            out.extend(self.detector.feed_iracing_at(&input, offset, host_time_ms));
            return out;
        }
        if let Some(pending) = self.pending_unexpected_lap.take() {
            if lap == pending.input.sample.lap_number as i64 { self.accept_unexpected_lap(pending, &mut out); }
        }
        let Some(physical_lap) = self.physical_lap else {
            self.physical_lap = Some(lap);
            out.extend(self.detector.feed_iracing_at(&input, offset, host_time_ms));
            return out;
        };
        if lap == physical_lap {
            if self.deferred.is_empty() {
                out.extend(self.detector.feed_iracing_at(&input, offset, host_time_ms));
                return out;
            }
            let last_lap = input.sample.last_lap;
            self.peak_native_current_lap = self.peak_native_current_lap.max(input.native_current_lap);
            let rolled = self.native_timing_rolled(&input);
            self.defer(input, offset, host_time_ms);
            if rolled { self.release_deferred(last_lap, &mut out); }
            return out;
        }
        if lap != physical_lap + 1 {
            self.pending_unexpected_lap = Some(DeferredSample { input, offset, host_time_ms });
            return out;
        }
        self.physical_lap = Some(lap);
        if self.skip_first_completion {
            self.skip_first_completion = false;
            let mut boundary = input;
            boundary.sample.last_lap = 0.;
            out.extend(self.detector.feed_iracing_at(&boundary, offset, host_time_ms));
            return out;
        }
        self.deferred.clear();
        self.stale_last_lap = input.sample.last_lap;
        self.peak_native_current_lap = 0.;
        self.defer(input, offset, host_time_ms);
        out
    }
    pub fn tick(&mut self, time_ms: u64) -> Vec<Value> {
        if !self.deferred.is_empty() {
            if time_ms.saturating_sub(self.last_active_ms) < 10_000 { return Vec::new(); }
            self.clear_gate();
            return self.detector.finish("stale");
        }
        self.detector.tick(time_ms)
    }
    pub fn finish(&mut self, reason: &str) -> Vec<Value> {
        let mut out = Vec::new();
        if !self.deferred.is_empty() {
            let lap_time = if self.stale_last_lap > 0. { self.stale_last_lap }
                else { self.deferred.first().map(|p|p.input.sample.last_lap).unwrap_or(0.) };
            if lap_time > 0. { self.release_deferred(lap_time, &mut out); }
            else { self.deferred.clear(); }
        }
        out.extend(self.detector.finish(reason));
        self.clear_gate();
        out
    }
    pub fn reset(&mut self) { self.detector.reset(); self.clear_gate(); }
    fn reset_gate(&mut self, input: &IRacingInput) {
        self.session_key = Some(input.uid.clone());
        self.physical_lap = Some(input.sample.lap_number as i64);
        self.skip_first_completion = !self.complete_initial_lap_expected;
        self.complete_initial_lap_expected = false;
        self.deferred.clear();
        self.pending_unexpected_lap = None;
        self.stale_last_lap = input.sample.last_lap;
        self.peak_native_current_lap = input.native_current_lap;
    }
    fn clear_gate(&mut self) {
        self.session_key = None;
        self.physical_lap = None;
        self.skip_first_completion = true;
        self.deferred.clear();
        self.pending_unexpected_lap = None;
        self.stale_last_lap = 0.;
        self.peak_native_current_lap = 0.;
        self.last_active_ms = 0;
    }
    fn defer(&mut self, input: IRacingInput, offset: u64, host_time_ms: u64) {
        self.peak_native_current_lap = self.peak_native_current_lap.max(input.native_current_lap);
        self.deferred.push(DeferredSample { input, offset, host_time_ms });
    }
    fn native_timing_rolled(&self, input: &IRacingInput) -> bool {
        let last_lap = input.sample.last_lap;
        let changed = last_lap > 0. && (last_lap - self.stale_last_lap).abs() > 0.0001;
        let current = input.native_current_lap;
        changed || (current > 0. && self.peak_native_current_lap > 10.
            && current < 5.0_f64.min(self.peak_native_current_lap * 0.5))
    }
    fn release_deferred(&mut self, lap_time: f64, out: &mut Vec<Value>) {
        let mut entries = self.deferred.drain(..);
        let Some(mut boundary) = entries.next() else { return; };
        self.detector.set_next_override(boundary.offset, "LastLap", json!(lap_time));
        boundary.input.sample.last_lap = lap_time;
        out.extend(self.detector.feed_iracing_at(&boundary.input, boundary.offset, boundary.host_time_ms));
        for entry in entries {
            out.extend(self.detector.feed_iracing_at(&entry.input, entry.offset, entry.host_time_ms));
        }
    }
    fn accept_unexpected_lap(&mut self, entry: DeferredSample, out: &mut Vec<Value>) {
        self.deferred.clear();
        self.physical_lap = Some(entry.input.sample.lap_number as i64);
        self.skip_first_completion = true;
        out.extend(self.detector.feed_iracing_at(&entry.input, entry.offset, entry.host_time_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(lap: i64, current: f64, last: f64, distance: f64) -> Value {
        json!({"gameId":"iracing","sessionUID":"2:1:0","CarOrdinal":73.0,
            "TrackOrdinal":21.0,"CarClass":4011.0,"CarPerformanceIndex":0.0,
            "LapNumber":lap,"CurrentLap":current,"LastLap":last,
            "DistanceTraveled":distance,"TimestampMS":distance*10.,
            "iracing":{"onPitRoad":false,"sdkCurrentLapTime":current}})
    }
    fn prepared() -> IRacingDetector {
        let mut detector = IRacingDetector::new().unwrap();
        detector.expect_complete_lap_start();
        for index in 0..40 {
            detector.feed(packet(1,index as f64*0.5,0.,index as f64*20.),index);
        }
        detector
    }
    fn lap(events: &[Value]) -> &Value {
        events.iter().find(|e|e["kind"]=="LAP_RECORDED").expect("recorded lap")
    }

    #[test]
    fn delayed_last_lap_replays_original_offsets_and_override() {
        let mut detector = prepared();
        assert!(detector.feed(packet(2,0.,18.,800.),40).is_empty());
        assert!(detector.feed(packet(2,0.5,18.,820.),41).is_empty());
        let events = detector.feed(packet(2,1.,20.,840.),42);
        let recorded = lap(&events);
        assert_eq!(recorded["data"]["lapTime"],20.);
        assert_eq!(recorded["data"]["isValid"],true);
        assert_eq!(recorded["data"]["rawFrameCount"],40);
        assert_eq!(recorded["data"]["analysisRecipe"]["ranges"][39]["offset"],"39");
        assert_eq!(recorded["data"]["analysisRecipe"]["overrides"],
            json!([{"offset":"40","fields":{"LastLap":20.}}]));
        assert!(detector.deferred.is_empty());
        let tail = detector.finish("import-eof");
        assert_eq!(tail.last().unwrap()["data"]["reason"],"import-eof");
    }

    #[test]
    fn literal_sdk_key_rollover_remains_distinct_from_nested_presentation() {
        let mut nested = prepared();
        nested.feed(packet(2,0.,20.,800.),40);
        let mut high = packet(2,12.,20.,820.);
        high["iracing"]["sdkCurrentLapTime"] = json!(12.);
        assert!(nested.feed(high.clone(),41).is_empty());
        assert!(nested.feed(packet(2,1.,20.,840.),42).is_empty());
        assert_eq!(nested.deferred.len(),3);
        assert_eq!(IRacingInput::from_value(&high).native_current_lap,0.);

        let mut literal = prepared();
        literal.feed(packet(2,0.,20.,800.),40);
        high["iracing.sdkCurrentLapTime"] = json!(12.);
        assert!(literal.feed(high,41).is_empty());
        let mut rolled = packet(2,1.,20.,840.);
        rolled["iracing.sdkCurrentLapTime"] = json!(1.);
        assert_eq!(lap(&literal.feed(rolled,42))["data"]["lapTime"],20.);
        assert!(literal.deferred.is_empty());
    }

    #[test]
    fn first_completion_is_skipped_unless_complete_start_was_established() {
        let mut detector = IRacingDetector::new().unwrap();
        for index in 0..40 { detector.feed(packet(1,index as f64*0.5,0.,index as f64*20.),index); }
        assert!(detector.feed(packet(2,0.,20.,800.),40).is_empty());
        assert!(detector.deferred.is_empty());
        assert!(!detector.skip_first_completion);
        let mut complete = prepared();
        complete.feed(packet(2,0.,18.,800.),40);
        assert_eq!(complete.deferred.len(),1);
    }

    #[test]
    fn unexpected_counter_requires_confirmation_and_discards_transient_sample() {
        let mut detector = prepared();
        assert!(detector.feed(packet(4,0.,20.,800.),40).is_empty());
        assert!(detector.feed(packet(1,20.,0.,820.),41).is_empty());
        assert!(detector.pending_unexpected_lap.is_none());
        assert!(detector.feed(packet(4,0.,20.,840.),42).is_empty());
        let events = detector.feed(packet(4,0.5,20.,860.),43);
        let recorded = lap(&events);
        assert_eq!(recorded["data"]["rawFrameCount"],41);
        assert_eq!(recorded["data"]["analysisRecipe"]["ranges"][40]["offset"],"41");
        assert!(recorded["data"]["invalidReason"].as_str().unwrap().contains("lap skip"));
        assert_eq!(detector.physical_lap,Some(4));
        assert!(detector.skip_first_completion);
    }

    #[test]
    fn uid_change_drops_old_deferred_window_and_keeps_new_context_identity() {
        let mut detector = prepared();
        detector.feed(packet(2,0.,18.,800.),40);
        let mut next = packet(2,0.5,20.,820.);
        next["sessionUID"] = json!("next-session");
        next["CarClass"] = json!(9001.5);
        let events = detector.feed(next,41);
        assert_eq!(events[0]["data"]["lapTime"],19.5);
        assert_eq!(events[1]["data"]["reason"],"session-uid-changed");
        assert_eq!(events[2]["data"]["sessionUID"],"next-session");
        assert_eq!(events[2]["data"]["carClass"],9001.5);
        assert!(detector.deferred.is_empty());
        assert!(detector.skip_first_completion);
    }

    #[test]
    fn eof_and_inactivity_do_not_invent_authoritative_native_timing() {
        let mut confirmed = prepared();
        confirmed.feed(packet(2,0.,18.,800.),40);
        assert_eq!(lap(&confirmed.finish("import-eof"))["data"]["lapTime"],18.);
        let mut unconfirmed = prepared();
        unconfirmed.feed(packet(2,0.,0.,800.),40);
        let eof = unconfirmed.finish("import-eof");
        assert_eq!(lap(&eof)["data"]["lapTime"],19.5);
        assert_eq!(lap(&eof)["data"]["invalidReason"],"incomplete");
        assert!(lap(&eof)["data"]["analysisRecipe"]["overrides"].as_array().unwrap().is_empty());
        let mut inactive = prepared();
        inactive.feed_at(packet(2,12.,0.,800.),40,1000);
        assert!(inactive.tick(10_999).is_empty());
        let stale = inactive.tick(11_000);
        assert_eq!(lap(&stale)["data"]["lapTime"],19.5);
        assert_eq!(stale.last().unwrap()["data"]["reason"],"stale");
    }

    #[test]
    fn full_adapter_preserves_uid_class_pi_and_missing_numeric_semantics() {
        for uid in [Value::Null,json!(123.5),json!(""),json!("02:1:0"),json!("custom UID")] {
            let mut value = packet(1,0.,0.,0.);
            value["sessionUID"] = uid.clone();
            value["CarClass"] = json!("GT3");
            value["CarPerformanceIndex"] = json!(711.25);
            value["LapNumber"] = Value::Null;
            value["CurrentLap"] = json!("12");
            value["lmu"] = json!({"carId":7,"trackId":"spa","sessionType":"race"});
            let typed = IRacingInput::from_value(&value);
            assert_eq!(typed.sample.lap_number,0.);
            assert_eq!(typed.sample.current_lap,0.);
            let mut original = OrdinalDetector::new("iracing").unwrap();
            let mut adapter = IRacingDetector::new().unwrap();
            let expected = original.feed_ref_at(&value,5,100);
            let actual = adapter.feed_ref_at(&value,5,100);
            assert_eq!(actual,expected);
            assert_eq!(actual[0]["data"]["sessionUID"],uid);
            assert_eq!(actual[0]["data"]["carClass"],"GT3");
            assert_eq!(actual[0]["data"]["carPerformanceIndex"],711.25);
        }
    }

    #[test]
    fn numeric_uid_adapter_is_exact_including_negative_zero() {
        for text in ["2:1:0","-0:1:0","1.25:2:3"] {
            let uid = IRacingUid::from_text(text);
            assert!(matches!(uid,IRacingUid::Numeric(_)));
            assert!(uid.matches_text(text));
            assert_eq!(uid.value(),json!(text));
        }
        for text in ["02:1:0","2:1:0.0","2:1:0:","NaN:1:0","custom"] {
            assert!(matches!(IRacingUid::from_text(text),IRacingUid::Text(_)));
        }
        assert!(!IRacingUid::Numeric([-0.,1.,0.]).same(&IRacingUid::Numeric([0.,1.,0.])));
    }
    #[test]
    fn full_and_typed_gate_events_match_across_all_delayed_transitions() {
        let mut full = IRacingDetector::new().unwrap();
        let mut typed = IRacingDetector::new().unwrap();
        full.expect_complete_lap_start();
        typed.expect_complete_lap_start();
        let mut packets = Vec::new();
        for index in 0..40 {
            packets.push(json!({"gameId":"iracing","sessionUID":"session","CarClass":4011.0,
                "CarOrdinal":73.0,"TrackOrdinal":21.0,"LapNumber":1,
                "CurrentLap":index as f64*0.5,"DistanceTraveled":index as f64*20.,
                "LastLap":0.,"TimestampMS":index*500,"iracing":{"onPitRoad":false}}));
        }
        let mut boundary = packets.last().unwrap().clone();
        boundary["LapNumber"] = json!(2);
        boundary["CurrentLap"] = json!(0.);
        boundary["LastLap"] = json!(18.);
        packets.push(boundary.clone());
        boundary["CurrentLap"] = json!(0.5);
        boundary["LastLap"] = json!(18.00001);
        packets.push(boundary.clone());
        boundary["CurrentLap"] = json!(1.);
        boundary["LastLap"] = json!(20.);
        packets.push(boundary.clone());
        boundary["LapNumber"] = json!(8);
        packets.push(boundary.clone());
        boundary["LapNumber"] = json!(2);
        packets.push(boundary.clone());
        boundary["LapNumber"] = json!(8);
        packets.push(boundary.clone());
        packets.push(boundary.clone());
        boundary["sessionUID"] = json!("new-session");
        packets.push(boundary);
        for (index, packet) in packets.into_iter().enumerate() {
            let offset = 100 + index as u64*128;
            let host = index as u64*500;
            assert_eq!(full.feed_ref_at(&packet,offset,host),
                typed.feed_typed_at(IRacingInput::from_value(&packet),offset,host),
                "complete ordered events at {offset}");
        }
        assert_eq!(full.tick(100_000),typed.tick(100_000));
        assert_eq!(full.finish("import-eof"),typed.finish("import-eof"));
    }
}
