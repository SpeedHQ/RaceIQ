/**
 * telemetryToSymptoms — deterministic pass 1 of the auto-tune pipeline.
 *
 * Turns a stint's raw telemetry (+ detected corners) into a compact,
 * human-readable symptom report: per-corner entry/mid/exit balance,
 * brake lockup, suspension bottoming, and (ACC only) tyre pressure/temp
 * deltas. This is the *evidence* the tune-intent LLM reasons over — no
 * setup knowledge lives here, only physics-derived observations.
 */
import type { TelemetryPacket } from "../../shared/types";
import type { Corner } from "../corner-detection";

export type Balance = "oversteer" | "understeer" | "neutral";
export type Phase = "entry" | "mid" | "exit";

export interface PhaseSymptom {
  phase: Phase;
  balance: Balance;
  /** front-minus-rear mean |slip angle| (rad); +ve = understeer. */
  balanceMagnitude: number;
  brakeLockup: boolean;
  bottoming: boolean;
}

export interface CornerSymptom {
  index: number;
  label: string;
  phases: PhaseSymptom[];
}

export interface TyreDeltas {
  FL: number;
  FR: number;
  RL: number;
  RR: number;
}

export interface TuneSymptoms {
  corners: CornerSymptom[];
  aggregate: {
    balance: Balance;
    understeerCorners: string[];
    oversteerCorners: string[];
    lockupCorners: string[];
    bottomingCorners: string[];
    /** psi delta vs the mid of the ACC target window; null when unavailable. */
    tyrePressure: TyreDeltas | null;
  };
}

// Balance is called only when |front-rear| exceeds this many radians (~1.15°).
// Exported so the live-tuning issue detectors (server/ai/tune-issues.ts) reuse
// the exact same thresholds instead of drifting out of sync.
export const BALANCE_THRESHOLD = 0.02;
// Slip ratio magnitude while braking that counts as a locked wheel.
export const LOCKUP_SLIP = 0.15;
// Brake input (0..255 or 0..1) treated as "braking".
export const BRAKE_ON = 0.2;
// Normalised suspension travel treated as bottomed-out.
export const BOTTOM_TRAVEL = 0.95;
// Nominal ACC hot-pressure target window mid (psi).
export const ACC_PRESSURE_TARGET = 27.5;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Normalise a brake reading that may be 0..1 or 0..255 into 0..1. */
export function brakeFrac(p: TelemetryPacket): number {
  const b = p.Brake ?? 0;
  return b > 1 ? b / 255 : b;
}

function classifyBalance(frontSlip: number, rearSlip: number): {
  balance: Balance;
  magnitude: number;
} {
  const magnitude = frontSlip - rearSlip;
  if (magnitude > BALANCE_THRESHOLD) return { balance: "understeer", magnitude };
  if (magnitude < -BALANCE_THRESHOLD) return { balance: "oversteer", magnitude };
  return { balance: "neutral", magnitude };
}

function summarisePhase(phase: Phase, frames: TelemetryPacket[]): PhaseSymptom {
  const frontSlip = mean(
    frames.map((p) => (Math.abs(p.TireSlipAngleFL) + Math.abs(p.TireSlipAngleFR)) / 2),
  );
  const rearSlip = mean(
    frames.map((p) => (Math.abs(p.TireSlipAngleRL) + Math.abs(p.TireSlipAngleRR)) / 2),
  );
  const { balance, magnitude } = classifyBalance(frontSlip, rearSlip);

  const brakeLockup = frames.some(
    (p) =>
      brakeFrac(p) > BRAKE_ON &&
      (Math.abs(p.TireSlipRatioFL) > LOCKUP_SLIP ||
        Math.abs(p.TireSlipRatioFR) > LOCKUP_SLIP ||
        Math.abs(p.TireSlipRatioRL) > LOCKUP_SLIP ||
        Math.abs(p.TireSlipRatioRR) > LOCKUP_SLIP),
  );

  const bottoming = frames.some(
    (p) =>
      p.NormSuspensionTravelFL > BOTTOM_TRAVEL ||
      p.NormSuspensionTravelFR > BOTTOM_TRAVEL ||
      p.NormSuspensionTravelRL > BOTTOM_TRAVEL ||
      p.NormSuspensionTravelRR > BOTTOM_TRAVEL,
  );

  return { phase, balance, balanceMagnitude: magnitude, brakeLockup, bottoming };
}

/** Split a corner's frames into entry/mid/exit thirds by distance. */
function splitPhases(frames: TelemetryPacket[]): Record<Phase, TelemetryPacket[]> {
  const n = frames.length;
  const a = Math.floor(n / 3);
  const b = Math.floor((2 * n) / 3);
  return {
    entry: frames.slice(0, a),
    mid: frames.slice(a, b),
    exit: frames.slice(b),
  };
}

export function telemetryToSymptoms(
  packets: TelemetryPacket[],
  corners: Corner[],
): TuneSymptoms {
  const cornerSymptoms: CornerSymptom[] = [];
  const understeerCorners: string[] = [];
  const oversteerCorners: string[] = [];
  const lockupCorners: string[] = [];
  const bottomingCorners: string[] = [];

  for (const corner of corners) {
    const frames = packets.filter(
      (p) =>
        p.DistanceTraveled >= corner.distanceStart &&
        p.DistanceTraveled <= corner.distanceEnd,
    );
    if (frames.length < 3) continue;

    const split = splitPhases(frames);
    const phases: PhaseSymptom[] = (["entry", "mid", "exit"] as Phase[]).map(
      (phase) => summarisePhase(phase, split[phase]),
    );

    const dominant = phases.filter((p) => p.balance !== "neutral");
    if (dominant.some((p) => p.balance === "understeer")) understeerCorners.push(corner.label);
    if (dominant.some((p) => p.balance === "oversteer")) oversteerCorners.push(corner.label);
    if (phases.some((p) => p.brakeLockup)) lockupCorners.push(corner.label);
    if (phases.some((p) => p.bottoming)) bottomingCorners.push(corner.label);

    cornerSymptoms.push({ index: corner.index, label: corner.label, phases });
  }

  // Aggregate balance: whichever tendency shows in more corners.
  let balance: Balance = "neutral";
  if (understeerCorners.length > oversteerCorners.length) balance = "understeer";
  else if (oversteerCorners.length > understeerCorners.length) balance = "oversteer";

  return {
    corners: cornerSymptoms,
    aggregate: {
      balance,
      understeerCorners,
      oversteerCorners,
      lockupCorners,
      bottomingCorners,
      tyrePressure: tyrePressureDeltas(packets),
    },
  };
}

/** ACC-only: mean hot pressure delta vs target window mid, per corner. */
function tyrePressureDeltas(packets: TelemetryPacket[]): TyreDeltas | null {
  const withPressure = packets.filter((p) => p.TirePressureFrontLeft != null);
  if (withPressure.length === 0) return null;
  return {
    FL: mean(withPressure.map((p) => (p.TirePressureFrontLeft ?? 0))) - ACC_PRESSURE_TARGET,
    FR: mean(withPressure.map((p) => (p.TirePressureFrontRight ?? 0))) - ACC_PRESSURE_TARGET,
    RL: mean(withPressure.map((p) => (p.TirePressureRearLeft ?? 0))) - ACC_PRESSURE_TARGET,
    RR: mean(withPressure.map((p) => (p.TirePressureRearRight ?? 0))) - ACC_PRESSURE_TARGET,
  };
}
