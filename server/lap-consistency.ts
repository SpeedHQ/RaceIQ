import type { TelemetryPacket } from "../shared/types";
import { lapPath } from "../shared/lib/lap-path";
import type { Corner } from "./corner-detection";

export const LINE_SPREAD_THRESHOLD_M = 1.5;
export const INPUT_VAR_THRESHOLD = 0.02;

export interface CornerConsistency {
  corner: string; // Corner.label
  lateralSpreadM: number; // racing-line spread across laps (metres)
  brakeVar: number; // brake application variance across laps
  throttleVar: number; // throttle application variance across laps
  lowTrust: boolean; // any channel over its threshold
}

export interface LapConsistencyDelta {
  perCorner: CornerConsistency[];
  overall: { lateralSpreadM: number; brakeVar: number; throttleVar: number; lowTrust: boolean };
}

const RESAMPLE_BINS = 200;

interface ResampledLap {
  x: number[];
  z: number[];
  brake: number[];
  throttle: number[];
  span: number;
}

function normChannel(v: number): number {
  return v > 1 ? v / 255 : v;
}

/**
 * Linearly interpolate a value at target distance `d` along a monotonic
 * (non-decreasing) distance array `dist`, using parallel value array `vals`.
 */
function lerpAt(dist: number[], vals: number[], d: number): number {
  const n = dist.length;
  if (n === 0) return 0;
  if (n === 1 || d <= dist[0]) return vals[0];
  if (d >= dist[n - 1]) return vals[n - 1];

  // Binary search for the segment containing d.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid;
    else hi = mid;
  }
  const d0 = dist[lo];
  const d1 = dist[hi];
  const span = d1 - d0;
  if (span <= 0) return vals[lo];
  const t = (d - d0) / span;
  return vals[lo] + (vals[hi] - vals[lo]) * t;
}

function resampleLap(packets: TelemetryPacket[]): ResampledLap | null {
  if (packets.length < 2) return null;

  const { x, z } = lapPath(packets);
  const base = packets[0].DistanceTraveled;
  const dist = packets.map((p) => p.DistanceTraveled - base);
  const brake = packets.map((p) => normChannel(p.Brake));
  const throttle = packets.map((p) => normChannel(p.Accel));

  const span = dist[dist.length - 1];
  if (!(span > 0)) return null;

  const rx: number[] = [];
  const rz: number[] = [];
  const rBrake: number[] = [];
  const rThrottle: number[] = [];
  for (let i = 0; i < RESAMPLE_BINS; i++) {
    const frac = i / (RESAMPLE_BINS - 1);
    const d = frac * span;
    rx.push(lerpAt(dist, x, d));
    rz.push(lerpAt(dist, z, d));
    rBrake.push(lerpAt(dist, brake, d));
    rThrottle.push(lerpAt(dist, throttle, d));
  }

  return { x: rx, z: rz, brake: rBrake, throttle: rThrottle, span };
}

function populationVariance(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

const EMPTY_DELTA: LapConsistencyDelta = {
  perCorner: [],
  overall: { lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false },
};

export function computeLapConsistencyDelta(laps: TelemetryPacket[][], corners: Corner[]): LapConsistencyDelta {
  if (laps.length < 2 || corners.length < 1) return EMPTY_DELTA;

  const resampled = laps.map(resampleLap).filter((r): r is ResampledLap => r !== null);
  if (resampled.length < 2) return EMPTY_DELTA;

  // Per-bin metrics across laps.
  const binLateralSpread: number[] = [];
  const binBrakeVar: number[] = [];
  const binThrottleVar: number[] = [];
  for (let i = 0; i < RESAMPLE_BINS; i++) {
    const xs = resampled.map((r) => r.x[i]);
    const zs = resampled.map((r) => r.z[i]);
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
    const spread = xs.reduce((sum, xi, idx) => sum + Math.hypot(xi - meanX, zs[idx] - meanZ), 0) / xs.length;
    binLateralSpread.push(spread);

    const brakes = resampled.map((r) => r.brake[i]);
    const throttles = resampled.map((r) => r.throttle[i]);
    binBrakeVar.push(populationVariance(brakes));
    binThrottleVar.push(populationVariance(throttles));
  }

  // Reference lap length = median of per-lap spans.
  const spans = resampled.map((r) => r.span).sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  const referenceSpan = spans.length % 2 === 0 ? (spans[mid - 1] + spans[mid]) / 2 : spans[mid];

  const perCorner: CornerConsistency[] = corners.map((corner) => {
    if (!(referenceSpan > 0)) {
      return { corner: corner.label, lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false };
    }
    const fracStart = corner.distanceStart / referenceSpan;
    const fracEnd = corner.distanceEnd / referenceSpan;
    const loFrac = Math.min(fracStart, fracEnd);
    const hiFrac = Math.max(fracStart, fracEnd);

    const binIndices: number[] = [];
    for (let i = 0; i < RESAMPLE_BINS; i++) {
      const frac = i / (RESAMPLE_BINS - 1);
      if (frac >= loFrac && frac <= hiFrac) binIndices.push(i);
    }

    if (binIndices.length === 0) {
      return { corner: corner.label, lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false };
    }

    const lateralSpreadM = binIndices.reduce((sum, i) => sum + binLateralSpread[i], 0) / binIndices.length;
    const brakeVar = binIndices.reduce((sum, i) => sum + binBrakeVar[i], 0) / binIndices.length;
    const throttleVar = binIndices.reduce((sum, i) => sum + binThrottleVar[i], 0) / binIndices.length;
    const lowTrust = lateralSpreadM > LINE_SPREAD_THRESHOLD_M || brakeVar > INPUT_VAR_THRESHOLD || throttleVar > INPUT_VAR_THRESHOLD;

    return {
      corner: corner.label,
      lateralSpreadM: round3(lateralSpreadM),
      brakeVar: round3(brakeVar),
      throttleVar: round3(throttleVar),
      lowTrust,
    };
  });

  const overallLateralSpreadM = binLateralSpread.reduce((a, b) => a + b, 0) / binLateralSpread.length;
  const overallBrakeVar = binBrakeVar.reduce((a, b) => a + b, 0) / binBrakeVar.length;
  const overallThrottleVar = binThrottleVar.reduce((a, b) => a + b, 0) / binThrottleVar.length;
  const overallLowTrust = overallLateralSpreadM > LINE_SPREAD_THRESHOLD_M || overallBrakeVar > INPUT_VAR_THRESHOLD || overallThrottleVar > INPUT_VAR_THRESHOLD;

  return {
    perCorner,
    overall: {
      lateralSpreadM: round3(overallLateralSpreadM),
      brakeVar: round3(overallBrakeVar),
      throttleVar: round3(overallThrottleVar),
      lowTrust: overallLowTrust,
    },
  };
}
