import type { LapTrace } from "@shared/laps/trace/types";
import { clamp } from "@shared/math/numbers";

export { downsampleLap } from "@shared/laps/trace/build";
export { base64ToF32, decodeLapTrace } from "@shared/laps/trace/codec";
// Trace construction + wire codec are shared so the server can build LapTrace
// payloads too. Re-export the pieces existing client imports expect unchanged.
export type { EncodedLapTrace, LapTrace, TireAverages, TireTraces } from "@shared/laps/trace/types";

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

// Stint pace stats are shared with the server-side driver-profile aggregator.
export type { StintStats } from "@shared/laps/stint-stats";
export { stintStats } from "@shared/laps/stint-stats";
