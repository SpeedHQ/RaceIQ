import type { LapMeta, TelemetryPacket } from "@shared/types";

/** u32 wraps at 2^32 ms (~49.7 days) — TimestampMS resets mid-session on long
 *  runs. A single lap never spans that long, but consecutive packets can
 *  still straddle the wrap boundary. */
const U32_MAX = 4294967296;

export interface TireAverages {
  FL: number;
  FR: number;
  RL: number;
  RR: number;
}

/** Per-sample (distance-fraction binned) traces for each tire corner. */
export interface TireTraces {
  FL: Float32Array;
  FR: Float32Array;
  RL: Float32Array;
  RR: Float32Array;
}

export interface LapTrace {
  lapId: number;
  lapNumber: number;
  isValid: boolean;
  n: number;
  /** Distance fraction 0..1 for each sample. */
  frac: Float32Array;
  throttle: Float32Array;
  brake: Float32Array;
  /** Signed -1..1 (negative = left, positive = right). */
  steer: Float32Array;
  speedKmh: Float32Array;
  /** Seconds elapsed since the first sample, derived from TimestampMS
   *  (wrap-corrected) — used to compute time-at-distance deltas between laps. */
  timeS: Float32Array;
  /** Per-lap average tire temp (°C-ish, game units), skipping zero frames.
   *  Null when the lap has no usable tire temp data. */
  tire: TireAverages | null;
  /** Per-lap average tire pressure, skipping zero frames. Null when absent
   *  (e.g. non-ACC games with no TirePressure* fields). */
  pressure: TireAverages | null;
  /** Per-sample tire temp per corner (zero frames skipped, carry-forward
   *  across empty bins). Null when the lap has no usable tire temp data. */
  tireTempTrace: TireTraces | null;
  /** Per-sample tire pressure per corner. Null when absent. */
  pressureTrace: TireTraces | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalize a 0-255 (or already-normalized 0-1) input channel. */
function normChannel(v: number): number {
  return v > 1 ? v / 255 : v;
}

/** Normalize signed Steer (±128) to -1..1. */
function normSteer(v: number): number {
  return clamp(v / 128, -1, 1);
}

function avgSkippingZero(vals: number[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of vals) {
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

function tireAverages(pkts: TelemetryPacket[], sel: (p: TelemetryPacket, corner: "FL" | "FR" | "RL" | "RR") => number | undefined): TireAverages | null {
  const corners: ("FL" | "FR" | "RL" | "RR")[] = ["FL", "FR", "RL", "RR"];
  const out: Partial<TireAverages> = {};
  let anyMissing = false;
  for (const c of corners) {
    const avg = avgSkippingZero(pkts.map((p) => sel(p, c) ?? 0));
    if (avg == null) {
      anyMissing = true;
      break;
    }
    out[c] = avg;
  }
  if (anyMissing) return null;
  return out as TireAverages;
}

/**
 * Build a lap trace from its full telemetry — one output sample per real
 * recorded frame, no bucketing, resampling, or interpolation. Pure and
 * side-effect free so it's cheap to unit test. `frac` holds each frame's true
 * distance fraction (DistanceTraveled, offset by sectorTimes.firstDist /
 * lapDist when available, else the packet array's own span), so the rendered
 * line is exactly the recorded signal.
 */
export function downsampleLap(lapId: number, lapNumber: number, isValid: boolean, telemetry: TelemetryPacket[], sectorTimes: { firstDist: number; lapDist: number } | null): LapTrace | null {
  if (telemetry.length === 0) return null;

  const firstDist = sectorTimes?.firstDist ?? telemetry[0].DistanceTraveled;
  const lapDist = sectorTimes?.lapDist ?? telemetry[telemetry.length - 1].DistanceTraveled - firstDist;
  if (!(lapDist > 0)) return null;

  // Elapsed-time source, mirroring the server's sector-time logic
  // (lap-routes): prefer CurrentLap (in-game current lap time, seconds) when
  // it actually progresses across the lap — some games (e.g. AC Evo) stamp
  // TimestampMS with wall-clock Date.now() at parse time, which collapses to
  // near-zero spans for imported/replayed sessions. Fall back to unwrapping
  // TimestampMS (u32, wrap-corrected) when CurrentLap is unreliable.
  const lapProgression = telemetry[telemetry.length - 1].CurrentLap - telemetry[0].CurrentLap;
  const useCurrentLap = lapProgression >= 1;
  const tsMs: number[] = new Array(telemetry.length);
  tsMs[0] = 0;
  if (useCurrentLap) {
    const t0 = telemetry[0].CurrentLap;
    for (let i = 1; i < telemetry.length; i++) tsMs[i] = (telemetry[i].CurrentLap - t0) * 1000;
  } else {
    let prevRaw = telemetry[0].TimestampMS;
    for (let i = 1; i < telemetry.length; i++) {
      const curRaw = telemetry[i].TimestampMS;
      let delta = curRaw - prevRaw;
      if (delta < 0) delta += U32_MAX;
      tsMs[i] = tsMs[i - 1] + delta;
      prevRaw = curRaw;
    }
  }

  // Keep EVERY recorded frame — no bucketing, no resampling, no interpolation.
  // Each output sample is one real telemetry frame at its true distance
  // fraction, so the rendered line is exactly the recorded signal. `frac` is
  // monotonic but not uniformly spaced (dense in slow corners, sparse on
  // straights); consumers locate a fraction via `sampleAt`'s frac search.
  const rawN = telemetry.length;
  const frac = new Float32Array(rawN);
  const throttle = new Float32Array(rawN);
  const brake = new Float32Array(rawN);
  const steer = new Float32Array(rawN);
  const speedKmh = new Float32Array(rawN);
  const timeS = new Float32Array(rawN);

  for (let i = 0; i < rawN; i++) {
    const p = telemetry[i];
    frac[i] = clamp((p.DistanceTraveled - firstDist) / lapDist, 0, 1);
    throttle[i] = normChannel(p.Accel);
    brake[i] = normChannel(p.Brake);
    steer[i] = normSteer(p.Steer);
    speedKmh[i] = p.Speed * 3.6;
    timeS[i] = tsMs[i] / 1000;
  }

  // Per-corner tire traces — again one value per real frame. Zero readings
  // (sensor absent that frame) are held from the last non-zero value so a
  // dropout doesn't spike the line to zero; a corner with no readings at all
  // drops the whole set to null.
  function tireTraceBins(sel: (p: TelemetryPacket, corner: "FL" | "FR" | "RL" | "RR") => number | undefined): TireTraces | null {
    const corners: ("FL" | "FR" | "RL" | "RR")[] = ["FL", "FR", "RL", "RR"];
    const out: Partial<TireTraces> = {};
    let anyMissing = false;
    for (const c of corners) {
      const arr = new Float32Array(rawN);
      let last = 0;
      let anySeeded = false;
      for (let i = 0; i < rawN; i++) {
        const v = sel(telemetry[i], c) ?? 0;
        if (v !== 0) {
          last = v;
          anySeeded = true;
        }
        arr[i] = last;
      }
      if (!anySeeded) {
        anyMissing = true;
        break;
      }
      // Backfill any leading zeros (before the first reading) with the first
      // real value so the trace doesn't start at zero.
      if (arr[0] === 0) {
        let firstIdx = 0;
        while (firstIdx < rawN && arr[firstIdx] === 0) firstIdx++;
        if (firstIdx < rawN) for (let i = 0; i < firstIdx; i++) arr[i] = arr[firstIdx];
      }
      out[c] = arr;
    }
    return anyMissing ? null : (out as TireTraces);
  }

  const tire = tireAverages(telemetry, (p, c) => (p as unknown as Record<string, number>)[`TireTemp${c}`]);
  const pressure = tireAverages(telemetry, (p, c) => {
    const key = c === "FL" ? "TirePressureFrontLeft" : c === "FR" ? "TirePressureFrontRight" : c === "RL" ? "TirePressureRearLeft" : "TirePressureRearRight";
    return (p as unknown as Record<string, number | undefined>)[key];
  });

  const tireTempTrace = tireTraceBins((p, c) => (p as unknown as Record<string, number>)[`TireTemp${c}`]);
  const pressureTrace = tireTraceBins((p, c) => {
    const key = c === "FL" ? "TirePressureFrontLeft" : c === "FR" ? "TirePressureFrontRight" : c === "RL" ? "TirePressureRearLeft" : "TirePressureRearRight";
    return (p as unknown as Record<string, number | undefined>)[key];
  });

  return { lapId, lapNumber, isValid, n: rawN, frac, throttle, brake, steer, speedKmh, timeS, tire, pressure, tireTempTrace, pressureTrace };
}

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
 * non-tuning-excluded, non-legacy laps, excluding the stint's first lap
 * (lapNumber === Math.min(...)) which is treated as an out-lap.
 */
export function stintStats(laps: LapMeta[]): StintStats {
  const eligible = laps.filter((l) => l.isValid && !l.isLegacy && !l.tuningExcluded);
  const minLapNumber = eligible.length > 0 ? Math.min(...eligible.map((l) => l.lapNumber)) : null;
  const scored = eligible.filter((l) => l.lapNumber !== minLapNumber);
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
