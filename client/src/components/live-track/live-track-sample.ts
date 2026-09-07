import type { GameId } from "@shared/games/ids";
import { pointAtLapFraction } from "@shared/racing/tracks/path";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";

export interface LiveTrackPoint {
  x: number;
  z: number;
}

export interface LiveTrackSample {
  simulator: GameId;
  observedAtMs: number;
  trackOrdinal?: number;
  lapNumber?: number;
  distanceM?: number;
  lapFraction?: number;
  positionM?: LiveTrackPoint;
  yawRad?: number;
  speedMps?: number;
}

export function liveTrackSampleFromView(view: LiveTelemetryView): LiveTrackSample {
  return {
    simulator: view.simulator,
    observedAtMs: view.observedAtMs,
    trackOrdinal: view.identity.trackOrdinal,
    lapNumber: view.timing.lapNumber,
    distanceM: view.motion.distanceM,
    lapFraction: view.timing.lapFraction,
    positionM: view.motion.position,
    yawRad: view.motion.attitude?.yaw,
    speedMps: view.motion.speedMps,
  };
}

export function advanceLiveTrackPosition(previous: LiveTrackSample, current: LiveTrackSample, previousPosition: LiveTrackPoint): LiveTrackPoint {
  if (previous.yawRad === undefined || current.yawRad === undefined || current.speedMps === undefined) return previousPosition;
  const elapsedS = (current.observedAtMs - previous.observedAtMs) / 1000;
  if (elapsedS <= 0 || elapsedS > 1) return previousPosition;
  const yawRad = Math.atan2(Math.sin(previous.yawRad) + Math.sin(current.yawRad), Math.cos(previous.yawRad) + Math.cos(current.yawRad));
  return {
    x: previousPosition.x + Math.sin(yawRad) * current.speedMps * elapsedS,
    z: previousPosition.z + Math.cos(yawRad) * current.speedMps * elapsedS,
  };
}

export function pointForLiveTrackSample(
  sample: LiveTrackSample,
  outline: readonly LiveTrackPoint[],
  options: {
    useWorldPosition: boolean;
    deadReckonedPosition?: LiveTrackPoint | null;
    distanceFraction?: number;
  },
): LiveTrackPoint | null {
  if (options.useWorldPosition && sample.positionM) return sample.positionM;
  if (options.useWorldPosition && options.deadReckonedPosition) return options.deadReckonedPosition;
  if (sample.lapFraction !== undefined && Number.isFinite(sample.lapFraction)) {
    return pointAtLapFraction(outline, sample.lapFraction) ?? null;
  }
  if (options.distanceFraction !== undefined && Number.isFinite(options.distanceFraction)) {
    return pointAtLapFraction(outline, options.distanceFraction) ?? null;
  }
  return null;
}
