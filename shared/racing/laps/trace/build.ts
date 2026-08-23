import { slipBalanceDegFromAngles } from "@shared/racing/analysis/laps/physics/vehicle";
import { clamp } from "@shared/core/numbers";
import type { SemanticLapFrame } from "@shared/racing/analysis/laps/semantic-frame";
import type { LapTrace, TireAverages, TireTraces } from "./types";

type TraceFrame = SemanticLapFrame;

type CompleteTraceFrame = TraceFrame & {
  readonly distanceM: number;
  readonly throttleInput: number;
  readonly brakeInput: number;
  readonly steeringInput: number;
  readonly speedMps: number;
};

/** u32 wraps at 2^32 ms (~49.7 days) — TimestampMS resets mid-session on long
 *  runs. A single lap never spans that long, but consecutive packets can
 *  still straddle the wrap boundary. */
const U32_MAX = 4294967296;
const WHEEL_CORNERS = ["FL", "FR", "RL", "RR"] as const;

/** Normalize a 0-255 (or already-normalized 0-1) input channel. */
function normChannel(v: number): number {
  return v > 1 ? v / 255 : v;
}

/** Normalize signed Steer (±128) to -1..1. */
function normSteer(v: number): number {
  return clamp(v / 128, -1, 1);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function completeTraceFrame(frame: TraceFrame): frame is CompleteTraceFrame {
  return (
    finiteNumber(frame.observedAtMs) &&
    finiteNumber(frame.distanceM) &&
    finiteNumber(frame.throttleInput) &&
    finiteNumber(frame.brakeInput) &&
    finiteNumber(frame.steeringInput) &&
    finiteNumber(frame.speedMps)
  );
}

function tireAverage(frames: readonly TraceFrame[], select: (frame: TraceFrame) => number | undefined): number | null {
  let sum = 0;
  let count = 0;
  for (const frame of frames) {
    const value = select(frame);
    if (finiteNumber(value) && value > 0) {
      sum += value;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

function tireAverages(frames: readonly TraceFrame[], select: (frame: TraceFrame, corner: (typeof WHEEL_CORNERS)[number]) => number | undefined): TireAverages | null {
  const FL = tireAverage(frames, (frame) => select(frame, "FL"));
  const FR = tireAverage(frames, (frame) => select(frame, "FR"));
  const RL = tireAverage(frames, (frame) => select(frame, "RL"));
  const RR = tireAverage(frames, (frame) => select(frame, "RR"));
  return FL == null || FR == null || RL == null || RR == null ? null : { FL, FR, RL, RR };
}

/**
 * Build a lap trace from its full telemetry — one output sample per real
 * recorded frame, no bucketing, resampling, or interpolation. Pure and
 * side-effect free so it's cheap to unit test. `frac` holds each frame's true
 * distance fraction (DistanceTraveled, offset by sectorTimes.firstDist /
 * lapDist when available, else the packet array's own span), so the rendered
 * line is exactly the recorded signal.
 */
export function downsampleLap(lapId: number, lapNumber: number, isValid: boolean, telemetry: readonly TraceFrame[], sectorTimes: { firstDist: number; lapDist: number } | null): LapTrace | null {
  const frames = telemetry.filter(completeTraceFrame);
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];
  if (!firstFrame || !lastFrame) return null;

  const suppliedDistances = sectorTimes && finiteNumber(sectorTimes.firstDist) && finiteNumber(sectorTimes.lapDist) && sectorTimes.lapDist > 0 ? sectorTimes : null;
  const firstDist = suppliedDistances?.firstDist ?? firstFrame.distanceM;
  const lapDist = suppliedDistances?.lapDist ?? lastFrame.distanceM - firstDist;
  if (!(lapDist > 0) || !Number.isFinite(lapDist)) return null;

  // Elapsed-time source, mirroring the server's sector-time logic
  // (lap-routes): prefer CurrentLap (in-game current lap time, seconds) when
  // it actually progresses across the lap — some games (e.g. AC Evo) stamp
  // TimestampMS with wall-clock Date.now() at parse time, which collapses to
  // near-zero spans for imported/replayed sessions. Fall back to unwrapping
  // TimestampMS (u32, wrap-corrected) when CurrentLap is unreliable.
  const lapElapsed: number[] = [];
  for (const frame of frames) {
    if (!finiteNumber(frame.lapElapsedSeconds)) break;
    lapElapsed.push(frame.lapElapsedSeconds);
  }
  const useCurrentLap = lapElapsed.length === frames.length && lapElapsed.length > 0 && lapElapsed[lapElapsed.length - 1] - lapElapsed[0] >= 1;
  const rawN = frames.length;
  const tsMs: number[] = new Array(rawN);
  tsMs[0] = 0;
  if (useCurrentLap) {
    const t0 = lapElapsed[0];
    for (let i = 1; i < rawN; i++) tsMs[i] = (lapElapsed[i] - t0) * 1000;
  } else {
    let prevRaw = firstFrame.observedAtMs;
    for (let i = 1; i < rawN; i++) {
      const curRaw = frames[i].observedAtMs;
      let delta = curRaw - prevRaw;
      if (delta < 0) delta += U32_MAX;
      tsMs[i] = tsMs[i - 1] + delta;
      prevRaw = curRaw;
    }
  }

  // Keep every complete recorded frame — no bucketing, resampling, or
  // interpolation. Each output sample has finite primary evidence at its true
  // distance fraction.
  const frac = new Float32Array(rawN);
  const throttle = new Float32Array(rawN);
  const brake = new Float32Array(rawN);
  const steer = new Float32Array(rawN);
  const speedKmh = new Float32Array(rawN);
  const timeS = new Float32Array(rawN);

  for (let i = 0; i < rawN; i++) {
    const frame = frames[i];
    frac[i] = clamp((frame.distanceM - firstDist) / lapDist, 0, 1);
    throttle[i] = normChannel(frame.throttleInput);
    brake[i] = normChannel(frame.brakeInput);
    steer[i] = normSteer(frame.steeringInput);
    speedKmh[i] = frame.speedMps * 3.6;
    timeS[i] = tsMs[i] / 1000;
  }

  // Per-corner tire traces — one value per complete recorded frame. A reported
  // zero is held from the last non-zero value so a sensor dropout does not
  // spike the line to zero; a corner with no readings drops the set to null.
  function tireTraceBins(select: (frame: TraceFrame, corner: (typeof WHEEL_CORNERS)[number]) => number | undefined): TireTraces | null {
    const traces: Float32Array[] = [];
    for (const corner of WHEEL_CORNERS) {
      const trace = new Float32Array(rawN);
      let last = 0;
      let seeded = false;
      for (let index = 0; index < rawN; index++) {
        const value = select(frames[index], corner);
        if (finiteNumber(value) && value !== 0) {
          last = value;
          seeded = true;
        }
        trace[index] = last;
      }
      if (!seeded) return null;
      if (trace[0] === 0) {
        let firstValue = 0;
        while (firstValue < rawN && trace[firstValue] === 0) firstValue++;
        for (let index = 0; index < firstValue; index++) trace[index] = trace[firstValue];
      }
      traces.push(trace);
    }
    const [FL, FR, RL, RR] = traces;
    if (!FL || !FR || !RL || !RR) return null;
    return { FL, FR, RL, RR };
  }

  const tire = tireAverages(frames, (frame, corner) =>
    corner === "FL" ? frame.tireTemperature[0] : corner === "FR" ? frame.tireTemperature[1] : corner === "RL" ? frame.tireTemperature[2] : frame.tireTemperature[3],
  );
  const pressure = tireAverages(frames, (frame, corner) =>
    corner === "FL" ? frame.tirePressure[0] : corner === "FR" ? frame.tirePressure[1] : corner === "RL" ? frame.tirePressure[2] : frame.tirePressure[3],
  );
  const tireTempTrace = tireTraceBins((frame, corner) =>
    corner === "FL" ? frame.tireTemperature[0] : corner === "FR" ? frame.tireTemperature[1] : corner === "RL" ? frame.tireTemperature[2] : frame.tireTemperature[3],
  );
  const pressureTrace = tireTraceBins((frame, corner) =>
    corner === "FL" ? frame.tirePressure[0] : corner === "FR" ? frame.tirePressure[1] : corner === "RL" ? frame.tirePressure[2] : frame.tirePressure[3],
  );

  // Per-corner traces with no carry-forward: zero suspension travel or slip is
  // real. An incomplete channel abstains rather than encoding an absence as NaN.
  function directTireTraceBins(select: (frame: TraceFrame, corner: (typeof WHEEL_CORNERS)[number]) => number | undefined): TireTraces | null {
    const traces: Float32Array[] = [];
    let anyNonZero = false;
    for (const corner of WHEEL_CORNERS) {
      const trace = new Float32Array(rawN);
      for (let index = 0; index < rawN; index++) {
        const value = select(frames[index], corner);
        if (!finiteNumber(value)) return null;
        trace[index] = value;
        if (value !== 0) anyNonZero = true;
      }
      traces.push(trace);
    }
    if (!anyNonZero) return null;
    const [FL, FR, RL, RR] = traces;
    return FL && FR && RL && RR ? { FL, FR, RL, RR } : null;
  }

  // Balance: signed axle slip delta in degrees. Shared physics primitive keeps
  // review traces and steering-balance analysis aligned. Incomplete or all-zero
  // evidence abstains.
  let balanceComplete = true;
  let balanceAnyNonZero = false;
  const balance = new Float32Array(rawN);
  for (let index = 0; index < rawN; index++) {
    const value = slipBalanceDegFromAngles(frames[index].tireSlipAngleRad);
    if (value === null) {
      balanceComplete = false;
      break;
    }
    balance[index] = value;
    if (value !== 0) balanceAnyNonZero = true;
  }

  // Lateral/longitudinal g. Axis mapping verified against ACC/AC Evo shared
  // memory's Y-up, Z-forward local coordinate frame: AccelerationX is lateral,
  // AccelerationZ is longitudinal; braking produces negative AccelerationZ.
  let latGComplete = true;
  let longGComplete = true;
  let latGAnyNonZero = false;
  let longGAnyNonZero = false;
  const latG = new Float32Array(rawN);
  const longG = new Float32Array(rawN);
  for (let index = 0; index < rawN; index++) {
    const frame = frames[index];
    if (!finiteNumber(frame.accelerationXMps2)) latGComplete = false;
    else {
      latG[index] = frame.accelerationXMps2 / 9.81;
      if (frame.accelerationXMps2 !== 0) latGAnyNonZero = true;
    }
    if (!finiteNumber(frame.accelerationZMps2)) longGComplete = false;
    else {
      longG[index] = frame.accelerationZMps2 / 9.81;
      if (frame.accelerationZMps2 !== 0) longGAnyNonZero = true;
    }
  }

  const suspTravel = directTireTraceBins((frame, corner) =>
    corner === "FL"
      ? frame.normalizedSuspensionTravel[0]
      : corner === "FR"
        ? frame.normalizedSuspensionTravel[1]
        : corner === "RL"
          ? frame.normalizedSuspensionTravel[2]
          : frame.normalizedSuspensionTravel[3],
  );
  const combinedSlip = directTireTraceBins((frame, corner) =>
    corner === "FL" ? frame.tireCombinedSlip[0] : corner === "FR" ? frame.tireCombinedSlip[1] : corner === "RL" ? frame.tireCombinedSlip[2] : frame.tireCombinedSlip[3],
  );

  // Brake temperatures are carry-forward traces; a zero frame is a dropout.
  const brakeTemp = tireAverages(frames, (frame, corner) =>
    corner === "FL" ? frame.brakeTemperature[0] : corner === "FR" ? frame.brakeTemperature[1] : corner === "RL" ? frame.brakeTemperature[2] : frame.brakeTemperature[3],
  );
  const brakeTempTrace = tireTraceBins((frame, corner) =>
    corner === "FL" ? frame.brakeTemperature[0] : corner === "FR" ? frame.brakeTemperature[1] : corner === "RL" ? frame.brakeTemperature[2] : frame.brakeTemperature[3],
  );

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
    balance: balanceComplete && balanceAnyNonZero ? balance : null,
    latG: latGComplete && latGAnyNonZero ? latG : null,
    longG: longGComplete && longGAnyNonZero ? longG : null,
    suspTravel,
    combinedSlip,
    brakeTemp,
    brakeTempTrace,
  };
}
