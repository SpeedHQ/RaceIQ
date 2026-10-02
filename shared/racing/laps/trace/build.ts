import { slipBalanceDeg } from "@shared/racing/analysis/laps/physics/vehicle";
import { clamp } from "@shared/core/numbers";
import type { TelemetryPacket } from "@shared/telemetry/types";
import type { LapTrace, TireAverages, TireTraces } from "./types";

/** u32 wraps at 2^32 ms (~49.7 days) — TimestampMS resets mid-session on long
 *  runs. A single lap never spans that long, but consecutive packets can
 *  still straddle the wrap boundary. */
const U32_MAX = 4294967296;

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

  // Balance: signed axle slip delta in degrees. The shared physics helper is
  // also used by steering-balance analysis, so review traces and analysis
  // cannot drift. Null when every corner reports exactly zero on every frame.
  let balanceAnyNonZero = false;
  const balance = new Float32Array(rawN);
  for (let i = 0; i < rawN; i++) {
    const p = telemetry[i];
    const sFL = p.TireSlipAngleFL ?? 0;
    const sFR = p.TireSlipAngleFR ?? 0;
    const sRL = p.TireSlipAngleRL ?? 0;
    const sRR = p.TireSlipAngleRR ?? 0;
    if (sFL !== 0 || sFR !== 0 || sRL !== 0 || sRR !== 0) balanceAnyNonZero = true;
    balance[i] = slipBalanceDeg(p);
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
