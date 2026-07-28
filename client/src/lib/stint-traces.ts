import type { LapMeta } from "@shared/types";
import { clamp, type LapTrace } from "@shared/stint-trace";

// Trace construction + wire codec live in @shared/stint-trace so the server can
// build LapTraces too (batch /api/laps/traces endpoint). Re-export the pieces
// existing client imports expect from here, unchanged.
export type { LapTrace, TireAverages, TireTraces, EncodedLapTrace } from "@shared/stint-trace";
export { downsampleLap, decodeLapTrace, base64ToF32 } from "@shared/stint-trace";

/** Linearly interpolate a trace channel at distance fraction `f` (0..1).
 *  Samples are the raw recorded frames, so `frac` is monotonic but not evenly
 *  spaced — locate the bracketing samples by binary search on `frac`. */
export function sampleAt(trace: LapTrace, channel: "throttle" | "brake" | "steer" | "speedKmh" | "timeS", f: number): number {
  const arr = trace[channel];
  const fr = trace.frac;
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const target = clamp(f, 0, 1);
  if (target <= fr[0]) return arr[0];
  if (target >= fr[n - 1]) return arr[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = fr[hi] - fr[lo];
  const t = span > 0 ? (target - fr[lo]) / span : 0;
  return arr[lo] + (arr[hi] - arr[lo]) * t;
}

/** Index of the trace frame nearest distance fraction `f` (0..1). Use to read
 *  a frame-aligned side array (e.g. a per-frame delta) at a given fraction,
 *  since `frac` is monotonic but unevenly spaced. */
export function indexAtFrac(trace: LapTrace, f: number): number {
  const fr = trace.frac;
  const n = fr.length;
  if (n <= 1) return 0;
  const target = clamp(f, 0, 1);
  if (target <= fr[0]) return 0;
  if (target >= fr[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] <= target) lo = mid;
    else hi = mid;
  }
  return target - fr[lo] <= fr[hi] - target ? lo : hi;
}

/** Per-point consistency score across a set of traces (all laps, one
 *  channel): 100 minus a scaled standard deviation, floored at 0. Mirrors
 *  the mockup's `Math.max(0, 100 - (sd/range)*400)`. */
export function consistencyAt(traces: LapTrace[], f: number, channel: "throttle" | "brake" | "steer"): number | null {
  if (traces.length < 2) return null;
  const vals = traces.map((t) => sampleAt(t, channel, f));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  const sd = Math.sqrt(variance);
  const range = channel === "steer" ? 2 : 1;
  return Math.max(0, 100 - (sd / range) * 400);
}

export interface StintStats {
  /** clamp(100 - (sd/mean)*100*28, 0, 100); undefined when n < 2. */
  consistency: number | undefined;
  sdS: number | undefined;
  bestS: number | undefined;
  meanS: number | undefined;
  /** OLS slope of lapTime vs lapNumber (s/lap); undefined when n < 3. */
  degSlopeSPerLap: number | undefined;
  n: number;
}

/**
 * Stint-level stats computed purely from LapMeta lap times — valid,
 * non-experiment-excluded laps, excluding the stint's first lap
 * (lapNumber === Math.min(...)) which is treated as an out-lap.
 *
 * Pass `dropOutLap: false` when `laps` is already a curated pool (e.g. the
 * evaluation laps from selectEvaluationLaps) — that pool has dropped the
 * out-lap itself, so dropping the lowest lap number again would silently
 * throw away one legitimate fast lap and make `n` disagree with the caller's
 * own lap count.
 */
export function stintStats(laps: LapMeta[], opts?: { dropOutLap?: boolean }): StintStats {
  const dropOutLap = opts?.dropOutLap ?? true;
  const eligible = laps.filter((l) => l.isValid && !l.experimentExcluded);
  const minLapNumber = dropOutLap && eligible.length > 0 ? Math.min(...eligible.map((l) => l.lapNumber)) : null;
  const scored = minLapNumber === null ? eligible : eligible.filter((l) => l.lapNumber !== minLapNumber);
  const n = scored.length;

  if (n === 0) {
    return { consistency: undefined, sdS: undefined, bestS: undefined, meanS: undefined, degSlopeSPerLap: undefined, n };
  }

  const times = scored.map((l) => l.lapTime);
  const bestS = Math.min(...times);
  const meanS = times.reduce((a, b) => a + b, 0) / n;

  let sdS: number | undefined;
  let consistency: number | undefined;
  if (n >= 2) {
    const variance = times.reduce((a, t) => a + (t - meanS) ** 2, 0) / n;
    sdS = Math.sqrt(variance);
    consistency = meanS > 0 ? clamp(100 - (sdS / meanS) * 100 * 28, 0, 100) : undefined;
  }

  let degSlopeSPerLap: number | undefined;
  if (n >= 3) {
    const xs = scored.map((l) => l.lapNumber);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = meanS;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (times[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    degSlopeSPerLap = den > 0 ? num / den : 0;
  }

  return { consistency, sdS, bestS, meanS, degSlopeSPerLap, n };
}
