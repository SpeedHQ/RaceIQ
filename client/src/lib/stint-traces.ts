import type { LapMeta, TelemetryPacket } from "@shared/types";

/** Number of distance-fraction samples kept per lap trace. Chosen to keep a
 *  trace small (~8 KB) so a whole stint's worth can be cached without
 *  re-triggering the raw-telemetry memory guard (see useLapTelemetry). */
export const TRACE_SAMPLES = 400;

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
 * Downsample a lap's full telemetry into a fixed-length (TRACE_SAMPLES) trace
 * keyed by distance fraction — pure and side-effect free so it's cheap to
 * unit test. Bins telemetry frames by their position within the lap
 * (DistanceTraveled, offset by sectorTimes.firstDist / lapDist when
 * available, else the packet array's own span) and averages within each bin.
 */
export function downsampleLap(
  lapId: number,
  lapNumber: number,
  isValid: boolean,
  telemetry: TelemetryPacket[],
  sectorTimes: { firstDist: number; lapDist: number } | null,
  n: number = TRACE_SAMPLES,
): LapTrace | null {
  if (telemetry.length === 0) return null;

  const firstDist = sectorTimes?.firstDist ?? telemetry[0].DistanceTraveled;
  const lapDist = sectorTimes?.lapDist ?? telemetry[telemetry.length - 1].DistanceTraveled - firstDist;
  if (!(lapDist > 0)) return null;

  // Unwrap TimestampMS (u32) into a monotonic ms-since-first-sample series by
  // accumulating frame-to-frame deltas, adding a full wrap whenever a delta
  // goes negative (the counter rolled over between these two frames).
  const tsMs: number[] = new Array(telemetry.length);
  tsMs[0] = 0;
  let prevRaw = telemetry[0].TimestampMS;
  for (let i = 1; i < telemetry.length; i++) {
    const curRaw = telemetry[i].TimestampMS;
    let delta = curRaw - prevRaw;
    if (delta < 0) delta += U32_MAX;
    tsMs[i] = tsMs[i - 1] + delta;
    prevRaw = curRaw;
  }

  // Bin frames by fraction into n buckets, averaging within each bucket.
  const sums = {
    throttle: new Float64Array(n),
    brake: new Float64Array(n),
    steer: new Float64Array(n),
    speed: new Float64Array(n),
    time: new Float64Array(n),
    count: new Int32Array(n),
  };
  for (let i = 0; i < telemetry.length; i++) {
    const p = telemetry[i];
    const f = clamp((p.DistanceTraveled - firstDist) / lapDist, 0, 1);
    let bin = Math.floor(f * n);
    if (bin >= n) bin = n - 1;
    sums.throttle[bin] += normChannel(p.Accel);
    sums.brake[bin] += normChannel(p.Brake);
    sums.steer[bin] += normSteer(p.Steer);
    sums.speed[bin] += p.Speed * 3.6;
    sums.time[bin] += tsMs[i] / 1000;
    sums.count[bin]++;
  }

  const frac = new Float32Array(n);
  const throttle = new Float32Array(n);
  const brake = new Float32Array(n);
  const steer = new Float32Array(n);
  const speedKmh = new Float32Array(n);
  const timeS = new Float32Array(n);

  // Carry the last-known value forward across empty bins (sparse telemetry
  // near the start/end of a lap) so lanes don't show spurious zero dips.
  let lastThrottle = 0;
  let lastBrake = 0;
  let lastSteer = 0;
  let lastSpeed = 0;
  let lastTime = 0;
  for (let b = 0; b < n; b++) {
    frac[b] = (b + 0.5) / n;
    const c = sums.count[b];
    if (c > 0) {
      lastThrottle = sums.throttle[b] / c;
      lastBrake = sums.brake[b] / c;
      lastSteer = sums.steer[b] / c;
      lastSpeed = sums.speed[b] / c;
      lastTime = sums.time[b] / c;
    }
    throttle[b] = lastThrottle;
    brake[b] = lastBrake;
    steer[b] = lastSteer;
    speedKmh[b] = lastSpeed;
    timeS[b] = lastTime;
  }

  // Per-corner distance-fraction binned traces (zero/absent frames skipped,
  // carry-forward across empty bins like the main channels).
  function tireTraceBins(sel: (p: TelemetryPacket, corner: "FL" | "FR" | "RL" | "RR") => number | undefined): TireTraces | null {
    const corners: ("FL" | "FR" | "RL" | "RR")[] = ["FL", "FR", "RL", "RR"];
    const out: Partial<TireTraces> = {};
    let anyMissing = false;
    for (const c of corners) {
      const sum = new Float64Array(n);
      const cnt = new Int32Array(n);
      for (const p of telemetry) {
        const v = sel(p, c) ?? 0;
        if (v === 0) continue;
        const f = clamp((p.DistanceTraveled - firstDist) / lapDist, 0, 1);
        let bin = Math.floor(f * n);
        if (bin >= n) bin = n - 1;
        sum[bin] += v;
        cnt[bin]++;
      }
      const arr = new Float32Array(n);
      let last = 0;
      let seeded = false;
      for (let b = 0; b < n; b++) {
        if (cnt[b] > 0) {
          last = sum[b] / cnt[b];
          seeded = true;
        }
        arr[b] = last;
      }
      if (!seeded) {
        anyMissing = true;
        break;
      }
      // Backfill leading bins (before the first sample) with the first value.
      let firstIdx = 0;
      while (firstIdx < n && cnt[firstIdx] === 0) firstIdx++;
      if (firstIdx > 0 && firstIdx < n) {
        const firstVal = arr[firstIdx];
        for (let b = 0; b < firstIdx; b++) arr[b] = firstVal;
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

  return { lapId, lapNumber, isValid, n, frac, throttle, brake, steer, speedKmh, timeS, tire, pressure, tireTempTrace, pressureTrace };
}

/** Linearly interpolate a trace channel at fraction `f` (0..1). */
export function sampleAt(trace: LapTrace, channel: "throttle" | "brake" | "steer" | "speedKmh" | "timeS", f: number): number {
  const arr = trace[channel];
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const pos = clamp(f, 0, 1) * (n - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(n - 1, i0 + 1);
  const t = pos - i0;
  return arr[i0] + (arr[i1] - arr[i0]) * t;
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
