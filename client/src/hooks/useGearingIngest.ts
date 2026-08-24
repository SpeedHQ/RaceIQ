import { useEffect, useRef } from "react";
import { useUnits } from "./useUnits";
import type { LiveTelemetryView } from "../lib/live-telemetry-view";

import {
  getGearingTelemetryState,
  ingestGearingTelemetry,
  isLaunchHold,
  isPullBack,
  playRecordingBeep,
  setGearingRecording,
  trackGearingMaxSpeed,
  trackTrackSpeedSample,
  type GearingSample,
} from "../lib/gearing-telemetry";

/** Fraction of the car's spec top speed that ends a dyno pull (auto-stop). */
const TOP_SPEED_STOP_RATIO = 0.98;

/**
 * Adapt a semantic `LiveTelemetryView` into the canonical `GearingSample`
 * shape the gearing library consumes. Units stay canonical (rpm, watts, Nm,
 * m/s) — presentation converts to the user's unit.
 *
 * Returns null — rejecting the sample — when any required semantic (gear,
 * RPM, speed, power, torque, race state, lap, distance) is unavailable.
 * `LiveTelemetryView` leaves missing/stale/invalid semantics `undefined`,
 * and a `?? 0` fallback would fabricate real values that corrupt the dyno
 * accumulators and lap traces.
 */
export function viewToGearingSample(view: LiveTelemetryView): GearingSample | null {
  const gear = view.inputs.gear;
  const rpm = view.engine.rpm;
  const speedMps = view.motion.speedMps;
  const powerW = view.engine.powerW;
  const torqueNm = view.engine.torqueNm;
  const isRaceOn = view.race?.isRaceOn;
  const lapNumber = view.timing.lapNumber;
  const distanceM = view.motion.distanceM;
  if (
    gear === undefined ||
    rpm === undefined ||
    speedMps === undefined ||
    powerW === undefined ||
    torqueNm === undefined ||
    isRaceOn === undefined ||
    lapNumber === undefined ||
    distanceM === undefined
  ) {
    return null;
  }
  return {
    gameId: view.simulator,
    CarOrdinal: view.identity.carOrdinal ?? -1,
    TrackOrdinal: view.identity.trackOrdinal ?? -1,
    sessionUID: view.streamId,
    Accel: view.inputs.throttle ?? 0,
    Brake: view.inputs.brake ?? 0,
    Gear: gear,
    raceActive: isRaceOn,
    rpm,
    EngineMaxRpm: view.engine.maxRpm ?? 0,
    EngineIdleRpm: view.engine.idleRpm ?? 0,
    speedMps,
    AccelerationZ: view.motion.acceleration?.z ?? 0,
    powerW,
    torqueNm,
    LapNumber: lapNumber,
    DistanceTraveled: distanceM,
  };
}

/** Source-clock sampling interval: ~10 Hz, matching the prior wall-clock throttle. */
export const SOURCE_SAMPLE_INTERVAL_MS = 100;

/** Mutable sampling state advanced by `sourceSampleDue` / `sourceSampleAccept`. */
export interface SourceSampleClock {
  streamId: string | null;
  lastSequence: number;
  lastObservedAtMs: number;
}

/**
 * Whether a live frame is due for ingestion, keyed on the telemetry source's
 * own sequence + observed timestamp rather than the browser's `performance.now()`.
 * The ~10 Hz downsampling is therefore deterministic under delayed or bursty
 * delivery: the accepted subset depends only on source time/order, never on
 * when frames happen to arrive. A stream/session change resets the baseline
 * (the server restarts sequence and observed timestamps per stream), and
 * out-of-order frames are rejected against the last accepted sequence.
 */
export function sourceSampleDue(
  clock: SourceSampleClock,
  frame: { streamId: string; sequence: number; observedAtMs: number },
): boolean {
  if (frame.streamId !== clock.streamId) {
    clock.streamId = frame.streamId;
    clock.lastSequence = -1;
    clock.lastObservedAtMs = 0;
  }
  if (frame.sequence <= clock.lastSequence) return false;
  if (clock.lastSequence >= 0 && frame.observedAtMs - clock.lastObservedAtMs < SOURCE_SAMPLE_INTERVAL_MS) return false;
  return true;
}

/** Advance the sampling window after a frame is actually ingested. */
export function sourceSampleAccept(clock: SourceSampleClock, frame: { sequence: number; observedAtMs: number }): void {
  clock.lastSequence = frame.sequence;
  clock.lastObservedAtMs = frame.observedAtMs;
}

/**
 * Single ~10 Hz ingestion point for the gearing accumulators, throttled on the
 * telemetry source clock (`observedAtMs`/`sequence`) rather than the browser's
 * `performance.now()`, so sampling is deterministic under delayed or bursty
 * delivery. Mounted on the live-telemetry host instead of inside
 * GearingDashboard, so dyno samples, the session max speed and the auto
 * start/stops keep working no matter which dashboard mode is active. Samples
 * missing required semantics are rejected before they reach the accumulators.
 */
export function useGearingIngest(view: LiveTelemetryView | null, options: { autoStopTopSpeed?: () => number } = {}) {
  const { autoStopTopSpeed } = options;
  const units = useUnits();
  const sampleClock = useRef<SourceSampleClock>({ streamId: null, lastSequence: -1, lastObservedAtMs: 0 });

  useEffect(() => {
    if (!view) return;
    if (!sourceSampleDue(sampleClock.current, view)) return;
    const packet = viewToGearingSample(view);
    if (!packet) return; // required semantics unavailable — reject, don't fabricate zeros
    sourceSampleAccept(sampleClock.current, view);
    trackGearingMaxSpeed(packet);
    trackTrackSpeedSample(packet);

    const gearing = getGearingTelemetryState();

    // Auto-start: car stopped with the brake held ~2 s → beep + record.
    if (!gearing.recording && gearing.autoRecording && isLaunchHold(packet)) {
      playRecordingBeep();
      setGearingRecording(true);
    }

    // Auto-stop at the end of a full-throttle pull (throttle lift) — covers
    // cars that can't reach the top-speed trigger.
    if (gearing.recording && gearing.autoRecording && isPullBack(packet)) {
      setGearingRecording(false);
      return; // lift sample is dirty — drop it
    }

    const topSpeed = autoStopTopSpeed?.() ?? 0;
    if (gearing.autoRecording && topSpeed > 0 && units.speed(packet.speedMps) >= topSpeed * TOP_SPEED_STOP_RATIO) {
      setGearingRecording(false);
      return; // sample at/above top speed is dirty — drop it
    }
    ingestGearingTelemetry(packet);
  }, [view, autoStopTopSpeed, units]);
}
