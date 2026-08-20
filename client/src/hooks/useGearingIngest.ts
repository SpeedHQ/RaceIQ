import { useEffect, useRef } from "react";
import { useUnits } from "./useUnits";
import type { LiveTelemetryView } from "../lib/live-telemetry-view";
import { WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
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
 * Adapt a semantic `LiveTelemetryView` into the `GearingSample` shape the
 * gearing library consumes. `DisplaySpeed` is converted to the user's speed
 * unit (km/h or mph); `DisplayPower` is watts→HP; `IsRaceOn` is boolean→0/1.
 */
export function viewToGearingSample(view: LiveTelemetryView, speedUserUnit: (ms: number) => number): GearingSample {
  return {
    gameId: view.simulator,
    CarOrdinal: view.identity.carOrdinal ?? -1,
    TrackOrdinal: view.identity.trackOrdinal ?? -1,
    sessionUID: view.streamId,
    Accel: view.inputs.throttle ?? 0,
    Brake: view.inputs.brake ?? 0,
    Gear: view.inputs.gear ?? 0,
    IsRaceOn: view.race?.isRaceOn ? 1 : 0,
    CurrentEngineRpm: view.engine.rpm ?? 0,
    EngineMaxRpm: view.engine.maxRpm ?? 0,
    EngineIdleRpm: view.engine.idleRpm ?? 0,
    DisplaySpeed: speedUserUnit(view.motion.speedMps ?? 0),
    AccelerationZ: view.motion.acceleration?.z ?? 0,
    DisplayPower: (view.engine.powerW ?? 0) / WATTS_PER_HORSEPOWER,
    DisplayTorque: view.engine.torqueNm ?? 0,
    LapNumber: view.timing.lapNumber ?? 0,
    DistanceTraveled: view.motion.distanceM ?? 0,
  };
}

/**
 * Single throttled (~10 Hz) ingestion point for the gearing accumulators.
 * Mounted on the live-telemetry host instead of inside GearingDashboard, so
 * dyno samples, the session max speed and the auto start/stops keep working
 * no matter which dashboard mode is active.
 */
export function useGearingIngest(view: LiveTelemetryView | null, options: { autoStopTopSpeed?: () => number } = {}) {
  const { autoStopTopSpeed } = options;
  const units = useUnits();
  const lastIngestAt = useRef(0);

  useEffect(() => {
    if (!view) return;
    const now = performance.now();
    if (now - lastIngestAt.current < 100) return;
    lastIngestAt.current = now;
    const packet = viewToGearingSample(view, units.speed);
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
    if (gearing.autoRecording && topSpeed > 0 && packet.DisplaySpeed >= topSpeed * TOP_SPEED_STOP_RATIO) {
      setGearingRecording(false);
      return; // sample at/above top speed is dirty — drop it
    }
    ingestGearingTelemetry(packet);
  }, [view, autoStopTopSpeed, units]);
}
