import type { TelemetryPacket } from "./types";

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
  /** Signed per-frame axle slip delta in degrees: mean(|slipFL|,|slipFR|) −
   *  mean(|slipRL|,|slipRR|). Positive = front slips more (understeer),
   *  negative = rear slips more (oversteer). Null when the game reports no
   *  slip-angle data (all frames exactly 0). */
  balance: Float32Array | null;
  /** Lateral g (AccelerationX / 9.81). Null when the source field is absent. */
  latG: Float32Array | null;
  /** Longitudinal g (AccelerationZ / 9.81). Negative under braking. Null
   *  when the source field is absent. */
  longG: Float32Array | null;
  /** Per-corner normalized suspension travel (0..1). ACC: absolute
   *  compression (0 = full droop). AC Evo: centred at 0.5 (neutral ride
   *  height). Null when absent (e.g. F1, which hardcodes 0). */
  suspTravel: TireTraces | null;
  /** Per-corner combined tire slip magnitude. Null when absent. */
  combinedSlip: TireTraces | null;
  /** Per-lap average brake temp per corner (°C, game units), skipping zero
   *  frames. Null when the lap has no usable brake temp data. */
  brakeTemp: TireAverages | null;
  /** Per-sample brake temp per corner (zero frames skipped, carry-forward like
   *  tire temp). Null when absent. */
  brakeTempTrace: TireTraces | null;
}

export function clamp(v: number, lo: number, hi: number): number {
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

  // Per-corner traces with no carry-forward: unlike tire temp/pressure, a
  // frame reading exactly 0 (full droop, zero slip) is a real value, not a
  // sensor dropout. The whole channel drops to null only when every frame
  // across every corner is exactly 0 — the same sentinel games without the
  // field use (e.g. F1 hardcodes NormSuspensionTravel* to 0).
  function rawTireTraceBins(sel: (p: TelemetryPacket, corner: "FL" | "FR" | "RL" | "RR") => number | undefined): TireTraces | null {
    const corners: ("FL" | "FR" | "RL" | "RR")[] = ["FL", "FR", "RL", "RR"];
    const out: Partial<TireTraces> = {};
    let anyNonZero = false;
    for (const c of corners) {
      const arr = new Float32Array(rawN);
      for (let i = 0; i < rawN; i++) {
        const v = sel(telemetry[i], c) ?? 0;
        arr[i] = v;
        if (v !== 0) anyNonZero = true;
      }
      out[c] = arr;
    }
    return anyNonZero ? (out as TireTraces) : null;
  }

  const RAD_TO_DEG = 180 / Math.PI;

  // Balance: signed axle slip delta in degrees. Radians is ACC/AC Evo shared
  // memory's native unit for TireSlipAngle*; converted here so the chart
  // reads in a driver-familiar unit. Null when the game reports no slip
  // angle at all (every frame exactly 0 on every corner).
  let balanceAnyNonZero = false;
  const balance = new Float32Array(rawN);
  for (let i = 0; i < rawN; i++) {
    const p = telemetry[i] as unknown as Record<string, number>;
    const sFL = p.TireSlipAngleFL ?? 0;
    const sFR = p.TireSlipAngleFR ?? 0;
    const sRL = p.TireSlipAngleRL ?? 0;
    const sRR = p.TireSlipAngleRR ?? 0;
    if (sFL !== 0 || sFR !== 0 || sRL !== 0 || sRR !== 0) balanceAnyNonZero = true;
    const front = (Math.abs(sFL) + Math.abs(sFR)) / 2;
    const rear = (Math.abs(sRL) + Math.abs(sRR)) / 2;
    balance[i] = (front - rear) * RAD_TO_DEG;
  }

  // Lateral/longitudinal g. Axis mapping verified against ACC/AC Evo shared
  // memory's Y-up, Z-forward local coordinate frame: AccelerationX is the
  // lateral (right) component, AccelerationZ is the longitudinal (forward)
  // component — braking produces a negative AccelerationZ, matching the
  // parsers' own comments on acceleration/velocity/angular-velocity axis
  // order (server/games/acc/parser.ts, server/games/ac-evo/parser.ts).
  let latGAnyNonZero = false;
  let longGAnyNonZero = false;
  const latG = new Float32Array(rawN);
  const longG = new Float32Array(rawN);
  for (let i = 0; i < rawN; i++) {
    const p = telemetry[i] as unknown as Record<string, number | undefined>;
    const accX = p.AccelerationX ?? 0;
    const accZ = p.AccelerationZ ?? 0;
    if (accX !== 0) latGAnyNonZero = true;
    if (accZ !== 0) longGAnyNonZero = true;
    latG[i] = accX / 9.81;
    longG[i] = accZ / 9.81;
  }

  const suspTravel = rawTireTraceBins((p, c) => (p as unknown as Record<string, number>)[`NormSuspensionTravel${c}`]);
  const combinedSlip = rawTireTraceBins((p, c) => (p as unknown as Record<string, number>)[`TireCombinedSlip${c}`]);

  // Brake temp: same corner->field mapping as pressure, and it's a temperature
  // so a zero reading is a sensor dropout — carry-forward via tireTraceBins.
  const brakeTempKey = (c: "FL" | "FR" | "RL" | "RR") =>
    c === "FL" ? "BrakeTempFrontLeft" : c === "FR" ? "BrakeTempFrontRight" : c === "RL" ? "BrakeTempRearLeft" : "BrakeTempRearRight";
  const brakeTemp = tireAverages(telemetry, (p, c) => (p as unknown as Record<string, number | undefined>)[brakeTempKey(c)]);
  const brakeTempTrace = tireTraceBins((p, c) => (p as unknown as Record<string, number | undefined>)[brakeTempKey(c)]);

  return {
    lapId,
    lapNumber,
    isValid,
    n: rawN,
    frac,
    throttle,
    brake,
    steer,
    speedKmh,
    timeS,
    tire,
    pressure,
    tireTempTrace,
    pressureTrace,
    balance: balanceAnyNonZero ? balance : null,
    latG: latGAnyNonZero ? latG : null,
    longG: longGAnyNonZero ? longG : null,
    suspTravel,
    combinedSlip,
    brakeTemp,
    brakeTempTrace,
  };
}

// ─── Wire encoding: base64 Float32 columns ──────────────────────────────────
// LapTrace is all Float32Array channels; a batch of 50 laps × ~3000 frames is
// far cheaper to ship as base64'd raw buffers than JSON number arrays (~2× the
// bytes + a per-number text parse). Encode each channel to base64, decode back
// to Float32Array on the client. See server /api/laps/traces + useStintTraces.

export interface EncodedTireTraces {
  FL: string;
  FR: string;
  RL: string;
  RR: string;
}

export interface EncodedLapTrace {
  lapId: number;
  lapNumber: number;
  isValid: boolean;
  n: number;
  frac: string;
  throttle: string;
  brake: string;
  steer: string;
  speedKmh: string;
  timeS: string;
  tire: TireAverages | null;
  pressure: TireAverages | null;
  tireTempTrace: EncodedTireTraces | null;
  pressureTrace: EncodedTireTraces | null;
  balance: string | null;
  latG: string | null;
  longG: string | null;
  suspTravel: EncodedTireTraces | null;
  combinedSlip: EncodedTireTraces | null;
  brakeTemp: TireAverages | null;
  brakeTempTrace: EncodedTireTraces | null;
}

/** Float32Array → base64 of its raw little-endian bytes. Copies the exact
 *  [byteOffset, byteLength) window so a subarray view doesn't leak siblings. */
export function f32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = "";
  const CHUNK = 0x8000; // avoid String.fromCharCode arg-count limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → Float32Array. Byte length is always a multiple of 4 (Float32). */
export function base64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength >>> 2);
}

function encodeTireTraces(t: TireTraces | null): EncodedTireTraces | null {
  if (!t) return null;
  return { FL: f32ToBase64(t.FL), FR: f32ToBase64(t.FR), RL: f32ToBase64(t.RL), RR: f32ToBase64(t.RR) };
}

function decodeTireTraces(t: EncodedTireTraces | null): TireTraces | null {
  if (!t) return null;
  return { FL: base64ToF32(t.FL), FR: base64ToF32(t.FR), RL: base64ToF32(t.RL), RR: base64ToF32(t.RR) };
}

export function encodeLapTrace(t: LapTrace): EncodedLapTrace {
  return {
    lapId: t.lapId,
    lapNumber: t.lapNumber,
    isValid: t.isValid,
    n: t.n,
    frac: f32ToBase64(t.frac),
    throttle: f32ToBase64(t.throttle),
    brake: f32ToBase64(t.brake),
    steer: f32ToBase64(t.steer),
    speedKmh: f32ToBase64(t.speedKmh),
    timeS: f32ToBase64(t.timeS),
    tire: t.tire,
    pressure: t.pressure,
    tireTempTrace: encodeTireTraces(t.tireTempTrace),
    pressureTrace: encodeTireTraces(t.pressureTrace),
    balance: t.balance ? f32ToBase64(t.balance) : null,
    latG: t.latG ? f32ToBase64(t.latG) : null,
    longG: t.longG ? f32ToBase64(t.longG) : null,
    suspTravel: encodeTireTraces(t.suspTravel),
    combinedSlip: encodeTireTraces(t.combinedSlip),
    brakeTemp: t.brakeTemp,
    brakeTempTrace: encodeTireTraces(t.brakeTempTrace),
  };
}

export function decodeLapTrace(e: EncodedLapTrace): LapTrace {
  return {
    lapId: e.lapId,
    lapNumber: e.lapNumber,
    isValid: e.isValid,
    n: e.n,
    frac: base64ToF32(e.frac),
    throttle: base64ToF32(e.throttle),
    brake: base64ToF32(e.brake),
    steer: base64ToF32(e.steer),
    speedKmh: base64ToF32(e.speedKmh),
    timeS: base64ToF32(e.timeS),
    tire: e.tire,
    pressure: e.pressure,
    tireTempTrace: decodeTireTraces(e.tireTempTrace),
    pressureTrace: decodeTireTraces(e.pressureTrace),
    balance: e.balance ? base64ToF32(e.balance) : null,
    latG: e.latG ? base64ToF32(e.latG) : null,
    longG: e.longG ? base64ToF32(e.longG) : null,
    suspTravel: decodeTireTraces(e.suspTravel),
    combinedSlip: decodeTireTraces(e.combinedSlip),
    brakeTemp: e.brakeTemp,
    brakeTempTrace: decodeTireTraces(e.brakeTempTrace),
  };
}
