/**
 * Resolver-backed weight-transfer diagnosis. Acceleration is canonical m/s²;
 * wheel-load values must be complete FL, FR, RL, RR arrays in canonical N.
 */
import type { GameId } from "../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { semanticFixedNumbers, semanticNumber } from "../telemetry/semantic-samples";

type BalanceLean = "front" | "rear" | "even";

export interface CornerLoad {
  lltdFront: number | null;
  peakLatG: number | null;
}

export interface WeightTransferSymptoms {
  lltdFront: number | null;
  lltdLean: BalanceLean;
  frontStaticBias: number | null;
  peakLatG: number | null;
  peakBrakeG: number | null;
  peakAccelG: number | null;
  brakeDiveLoadN: number | null;
}

const CORNER_LAT_G = 0.4;
const LONG_G = 0.3;
const LLTD_LEAN_BAND = 0.04;
const STATIC_G = 0.15;
const MIN_FRAMES = 30;
const G = 9.81;
const WHEELS = 4;

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function latG(sample: SemanticTelemetrySample): number | null {
  const acceleration = semanticNumber(sample, "motion.acceleration-y");
  return acceleration == null ? null : Math.abs(acceleration) / G;
}

function longG(sample: SemanticTelemetrySample): number | null {
  const acceleration = semanticNumber(sample, "motion.acceleration-x");
  return acceleration == null ? null : acceleration / G;
}

function lltdFrontOf(frames: readonly SemanticTelemetrySample[]): number | null {
  const frontTransfer: number[] = [];
  const rearTransfer: number[] = [];
  for (const frame of frames) {
    const lateralG = latG(frame);
    const wheelLoad = semanticFixedNumbers(frame, "suspension.wheel-load", WHEELS);
    if (lateralG == null || lateralG <= CORNER_LAT_G || !wheelLoad) continue;
    frontTransfer.push(Math.abs(wheelLoad[0] - wheelLoad[1]));
    rearTransfer.push(Math.abs(wheelLoad[2] - wheelLoad[3]));
  }
  if (frontTransfer.length < 3) return null;
  const front = mean(frontTransfer);
  const rear = mean(rearTransfer);
  if (front == null || rear == null || front + rear <= 0) return null;
  return front / (front + rear);
}

function lltdLean(lltdFront: number | null): BalanceLean {
  if (lltdFront == null) return "even";
  if (lltdFront > 0.5 + LLTD_LEAN_BAND) return "front";
  if (lltdFront < 0.5 - LLTD_LEAN_BAND) return "rear";
  return "even";
}

function peak(frames: readonly SemanticTelemetrySample[], valueOf: (frame: SemanticTelemetrySample) => number | null): number | null {
  let result: number | null = null;
  for (const frame of frames) {
    const value = valueOf(frame);
    if (value != null && (result == null || value > result)) result = value;
  }
  return result;
}

export function cornerWeightTransfer(gameId: GameId, frames: readonly SemanticTelemetrySample[]): CornerLoad {
  if (!gameId) throw new Error("gameId is required for weight-transfer analysis");
  return { lltdFront: lltdFrontOf(frames), peakLatG: peak(frames, latG) };
}

export function weightTransferSymptoms(gameId: GameId, samples: readonly SemanticTelemetrySample[]): WeightTransferSymptoms | null {
  if (!gameId) throw new Error("gameId is required for weight-transfer analysis");
  const moving: SemanticTelemetrySample[] = [];
  for (const sample of samples) {
    const speed = semanticNumber(sample, "motion.speed");
    if (speed != null && speed > 5) moving.push(sample);
  }
  if (moving.length < MIN_FRAMES) return null;

  const lltdFront = lltdFrontOf(moving);
  const staticFrontLoads: number[] = [];
  const staticTotals: number[] = [];
  const brakingFrontLoads: number[] = [];
  for (const sample of moving) {
    const lateralG = latG(sample);
    const longitudinalG = longG(sample);
    const wheelLoad = semanticFixedNumbers(sample, "suspension.wheel-load", WHEELS);
    if (lateralG == null || longitudinalG == null || !wheelLoad) continue;
    const frontLoad = wheelLoad[0] + wheelLoad[1];
    if (lateralG < STATIC_G && Math.abs(longitudinalG) < STATIC_G) {
      staticFrontLoads.push(frontLoad);
      staticTotals.push(frontLoad + wheelLoad[2] + wheelLoad[3]);
    }
    if (longitudinalG < -LONG_G) brakingFrontLoads.push(frontLoad);
  }

  const staticFront = staticFrontLoads.length >= 3 ? mean(staticFrontLoads) : null;
  const staticTotal = staticTotals.length >= 3 ? mean(staticTotals) : null;
  const frontStaticBias = staticFront != null && staticTotal != null && staticTotal > 0 ? staticFront / staticTotal : null;
  const brakingFront = brakingFrontLoads.length >= 3 ? mean(brakingFrontLoads) : null;
  return {
    lltdFront,
    lltdLean: lltdLean(lltdFront),
    frontStaticBias,
    peakLatG: peak(moving, latG),
    peakBrakeG: peak(moving, (sample) => {
      const value = longG(sample);
      return value == null ? null : Math.max(0, -value);
    }),
    peakAccelG: peak(moving, (sample) => {
      const value = longG(sample);
      return value == null ? null : Math.max(0, value);
    }),
    brakeDiveLoadN: staticFront != null && brakingFront != null ? brakingFront - staticFront : null,
  };
}

export function formatWeightTransferSymptoms(w: WeightTransferSymptoms | null): string {
  if (!w) return "Weight-transfer data unavailable for this game.";
  const leanWord: Record<BalanceLean, string> = {
    front: "front-biased (understeer-prone)",
    rear: "rear-biased (oversteer-prone)",
    even: "even",
  };
  const parts: string[] = [];
  if (w.peakLatG != null || w.peakBrakeG != null || w.peakAccelG != null) {
    parts.push(`peak g: ${w.peakLatG?.toFixed(1) ?? "unavailable"} lat, ${w.peakBrakeG?.toFixed(1) ?? "unavailable"} brake, ${w.peakAccelG?.toFixed(1) ?? "unavailable"} accel`);
  }
  if (w.lltdFront != null) parts.push(`LLTD ${(w.lltdFront * 100).toFixed(0)}% front (${leanWord[w.lltdLean]})`);
  if (w.frontStaticBias != null) parts.push(`static ${(w.frontStaticBias * 100).toFixed(0)}% front`);
  if (w.brakeDiveLoadN != null) parts.push(`brake dive +${w.brakeDiveLoadN.toFixed(0)}N front`);
  return `Weight transfer: ${parts.length > 0 ? parts.join("; ") : "data unavailable"}.`;
}
