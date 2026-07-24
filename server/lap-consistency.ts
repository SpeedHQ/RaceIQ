import type { TelemetryPacket } from "../shared/types";
import { lapPath } from "../shared/lib/lap-path";
import type { Corner } from "./corner-detection";

export const LINE_SPREAD_THRESHOLD_M = 1.5;
/** Mean lateral spread (metres) at which the line-consistency score hits 0.
 *  ~1.5m reads ~70, ~3m ~40 — a car-width of scatter is already poor. */
export const LINE_SPREAD_FULL_SCALE_M = 5;
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

/** Per-corner trimmed (10th-90th percentile) racing-line spread, plus the
 *  full per-bin trace for charting. */
export interface CornerLineSpread {
  corner: string; // Corner.label
  lateralSpreadM: number; // trimmed (p90-p10) racing-line spread, metres
  lowTrust: boolean;
}

export interface LineSpreadTrace {
  /** Lap-distance fraction (0..1) for each bin, RESAMPLE_BINS entries. */
  fracs: number[];
  /** Trimmed (p90-p10) lateral spread in metres at each bin. */
  spreadM: number[];
  perCorner: CornerLineSpread[];
  /** True when the overall trimmed spread (or any corner) exceeds LINE_SPREAD_THRESHOLD_M. */
  lowTrust: boolean;
  /** 0-100 racing-line consistency: how repeatable the driven line is across
   *  the pool. 100 = laps trace the same line; falls linearly with the mean
   *  lateral spread, reaching 0 at LINE_SPREAD_FULL_SCALE_M. */
  consistencyScore: number;
  /** Mean trimmed lateral spread across the lap (metres) — the raw figure the
   *  score is derived from. */
  overallSpreadM: number;
  /** Number of laps that fed the trace (after resampling). */
  lapCount: number;
  /** Per-lap RAW per-frame racing line (full resolution, variable length — for
   *  the zoom window), one per lap that survived resampling. World-space metres.
   *  `brake`/`throttle` are 0..1 per frame, used to color the zoom by input state.
   *  `frac` is each frame's normalized distance fraction (0..1 by DistanceTraveled)
   *  so the zoom can locate a distance-fraction cursor without assuming uniform
   *  frame spacing. */
  lapLines: { lapId: number; x: number[]; z: number[]; brake: number[]; throttle: number[]; frac: number[] }[];
}

const RESAMPLE_BINS = 200;

interface ResampledLap {
  lapId: number;
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

function resampleLap(packets: TelemetryPacket[], lapId: number): ResampledLap | null {
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

  return { lapId, x: rx, z: rz, brake: rBrake, throttle: rThrottle, span };
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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Shortest distance from point P to segment AB. */
function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Half-window (in bins) searched for each lap's nearest point to a mean-line
 *  point. ~10% of the lap, far wider than any realistic longitudinal desync,
 *  yet small enough to stay cheap. */
const NEAREST_WINDOW = RESAMPLE_BINS / 10;

/**
 * Per-bin across-track distance of each lap from the mean line, measured as the
 * shortest distance from each mean-line point to that lap's own polyline
 * (searched within a local window).
 *
 * Laps are resampled independently over their own distance span, so equal
 * fractions do NOT map to the same physical track point — braking zones and
 * corners desync longitudinally when drivers brake at different points. Reading
 * the raw point-to-point distance folds that longitudinal shift into the metric
 * as tens of metres of phantom "spread". Taking the nearest point on the lap's
 * polyline instead cancels the longitudinal component entirely, leaving the
 * true lateral (racing-line) deviation — which is what this metric is about.
 *
 * Returns `distances[bin]` = one unsigned metre value per lap.
 */
function lateralDistancesPerBin(resampled: ResampledLap[]): number[][] {
  const meanX = new Array<number>(RESAMPLE_BINS);
  const meanZ = new Array<number>(RESAMPLE_BINS);
  for (let i = 0; i < RESAMPLE_BINS; i++) {
    meanX[i] = resampled.reduce((a, r) => a + r.x[i], 0) / resampled.length;
    meanZ[i] = resampled.reduce((a, r) => a + r.z[i], 0) / resampled.length;
  }

  const out: number[][] = [];
  for (let i = 0; i < RESAMPLE_BINS; i++) {
    const px = meanX[i];
    const pz = meanZ[i];
    const lo = Math.max(0, i - NEAREST_WINDOW);
    const hi = Math.min(RESAMPLE_BINS - 1, i + NEAREST_WINDOW);
    out.push(
      resampled.map((r) => {
        let best = Number.POSITIVE_INFINITY;
        for (let k = lo; k < hi; k++) {
          const d = pointSegmentDistance(px, pz, r.x[k], r.z[k], r.x[k + 1], r.z[k + 1]);
          if (d < best) best = d;
        }
        return best;
      }),
    );
  }
  return out;
}

/** Linear-interpolation percentile of an already-sorted-ascending array; 0 when empty. */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

const MIN_LINE_SPREAD_LAPS = 3;

/**
 * Full per-bin racing-line spread trace, trimmed to the 10th-90th percentile
 * range of each bin's per-lap lateral deviations from the mean line — this
 * suppresses a single blunder/outlier lap from dominating the metre figure
 * the way a plain mean or min/max would. Returns null when fewer than 3
 * valid resampled laps are available (need enough laps for a meaningful
 * percentile trim).
 */
export function computeLineSpreadTrace(laps: TelemetryPacket[][], lapIds: number[], corners: Corner[]): LineSpreadTrace | null {
  const resampled = laps.map((packets, i) => resampleLap(packets, lapIds[i])).filter((r): r is ResampledLap => r !== null);
  if (resampled.length < MIN_LINE_SPREAD_LAPS) return null;

  const offsets = lateralDistancesPerBin(resampled);
  const fracs: number[] = [];
  const spreadM: number[] = [];
  for (let i = 0; i < RESAMPLE_BINS; i++) {
    fracs.push(i / (RESAMPLE_BINS - 1));
    // Trimmed p90-p10 range of the per-lap lateral distances = the width of the
    // racing-line bundle at this point, with one blunder lap suppressed.
    const dev = offsets[i].slice().sort((a, b) => a - b);
    spreadM.push(percentile(dev, 0.9) - percentile(dev, 0.1));
  }

  // Reference lap length = median of per-lap spans (same approach as
  // computeLapConsistencyDelta) so corner fractions line up with the bins.
  const spans = resampled.map((r) => r.span).sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  const referenceSpan = spans.length % 2 === 0 ? (spans[mid - 1] + spans[mid]) / 2 : spans[mid];

  const perCorner: CornerLineSpread[] = corners.map((corner) => {
    if (!(referenceSpan > 0)) return { corner: corner.label, lateralSpreadM: 0, lowTrust: false };
    const fracStart = corner.distanceStart / referenceSpan;
    const fracEnd = corner.distanceEnd / referenceSpan;
    const loFrac = Math.min(fracStart, fracEnd);
    const hiFrac = Math.max(fracStart, fracEnd);

    const binIndices: number[] = [];
    for (let i = 0; i < RESAMPLE_BINS; i++) {
      if (fracs[i] >= loFrac && fracs[i] <= hiFrac) binIndices.push(i);
    }
    if (binIndices.length === 0) return { corner: corner.label, lateralSpreadM: 0, lowTrust: false };

    const lateralSpreadM = binIndices.reduce((sum, i) => sum + spreadM[i], 0) / binIndices.length;
    return { corner: corner.label, lateralSpreadM: round3(lateralSpreadM), lowTrust: lateralSpreadM > LINE_SPREAD_THRESHOLD_M };
  });

  const overallSpreadM = spreadM.reduce((a, b) => a + b, 0) / spreadM.length;
  const lowTrust = overallSpreadM > LINE_SPREAD_THRESHOLD_M || perCorner.some((c) => c.lowTrust);
  const consistencyScore = Math.max(0, Math.min(100, Math.round(100 - (overallSpreadM / LINE_SPREAD_FULL_SCALE_M) * 100)));

  // lapLines are drawn in a small zoomed window, so they use the RAW per-frame
  // path (not the 200-bin metric resample, which is ~15-25m/point — far too
  // coarse for a ±30m zoom). Only laps that survived resampling are included,
  // in the same order.
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const round4 = (v: number) => Math.round(v * 10000) / 10000;
  const survivingIds = new Set(resampled.map((r) => r.lapId));
  const lapLines: LineSpreadTrace["lapLines"] = [];
  for (let i = 0; i < laps.length; i++) {
    if (!survivingIds.has(lapIds[i])) continue;
    const packets = laps[i];
    const { x, z } = lapPath(packets);
    // Per-frame normalized distance fraction (matches the resample's DistanceTraveled
    // basis) so the zoom locates a distance-fraction cursor at the right physical point.
    const base = packets[0].DistanceTraveled;
    const span = packets[packets.length - 1].DistanceTraveled - base;
    const frac = span > 0 ? packets.map((p) => round4(clamp01((p.DistanceTraveled - base) / span))) : packets.map((_, k) => round4(k / Math.max(1, packets.length - 1)));
    lapLines.push({
      lapId: lapIds[i],
      x: x.map(round2),
      z: z.map(round2),
      brake: packets.map((p) => round2(normChannel(p.Brake))),
      throttle: packets.map((p) => round2(normChannel(p.Accel))),
      frac,
    });
  }

  return {
    fracs,
    spreadM: spreadM.map(round3),
    perCorner,
    lowTrust,
    consistencyScore,
    overallSpreadM: round3(overallSpreadM),
    lapCount: resampled.length,
    lapLines,
  };
}

const EMPTY_DELTA: LapConsistencyDelta = {
  perCorner: [],
  overall: { lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false },
};

export function computeLapConsistencyDelta(laps: TelemetryPacket[][], corners: Corner[]): LapConsistencyDelta {
  if (laps.length < 2 || corners.length < 1) return EMPTY_DELTA;

  const resampled = laps.map((packets, i) => resampleLap(packets, i)).filter((r): r is ResampledLap => r !== null);
  if (resampled.length < 2) return EMPTY_DELTA;

  // Per-bin metrics across laps.
  const offsets = lateralDistancesPerBin(resampled);
  const binLateralSpread: number[] = [];
  const binBrakeVar: number[] = [];
  const binThrottleVar: number[] = [];
  for (let i = 0; i < RESAMPLE_BINS; i++) {
    // Mean across-track distance (longitudinal desync removed via nearest point).
    const offs = offsets[i];
    binLateralSpread.push(offs.reduce((sum, v) => sum + v, 0) / offs.length);

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
