/**
 * telemetryToSymptoms — deterministic pass 1 of the auto-tune pipeline.
 *
 * Turns a stint's raw telemetry (+ detected corners) into a compact,
 * human-readable symptom report: per-corner entry/mid/exit balance,
 * brake lockup, suspension bottoming, and (ACC only) tyre pressure/temp
 * deltas. This is the *evidence* the tune-intent LLM reasons over — no
 * setup knowledge lives here, only physics-derived observations.
 */
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { Corner } from "../lap-analysis/corners";
import { tireTempSymptoms } from "./tune-tire-symptoms";
import { damperSymptoms } from "./tune-damper-symptoms";
import { weightTransferSymptoms, cornerWeightTransfer } from "./tune-weight-transfer";

export type TireTempSymptoms = NonNullable<ReturnType<typeof tireTempSymptoms>>;
export type DamperSymptoms = NonNullable<ReturnType<typeof damperSymptoms>>;
export type CornerLoad = ReturnType<typeof cornerWeightTransfer>;
export type WeightTransferSymptoms = NonNullable<ReturnType<typeof weightTransferSymptoms>>;

export type Balance = "oversteer" | "understeer" | "neutral";
export type Phase = "entry" | "mid" | "exit";
export type SpeedBand = "slow" | "medium" | "fast";

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
  /** Corner mid-point as a fraction of lap distance (0-1), for sector bucketing
   *  and track-map placement. Undefined when lap distance can't be derived. */
  distanceFrac?: number;
  /** Apex speed (km/h) from detectCorners; undefined when unavailable. */
  minSpeedKph?: number;
  /** Slow/medium/fast band derived from minSpeedKph. Drives band-specific
   *  rules in tune-recommend.ts; undefined when apex speed is unknown. */
  speedBand?: SpeedBand;
  phases: PhaseSymptom[];
  /** Per-corner weight-transfer read (lateral load-transfer distribution).
   *  Undefined when the wheelLoad channel is absent for this game. */
  load?: CornerLoad;
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
    /** Per-tyre thermal profile (camber/pressure/thermal reads); null when the
     *  acc-family temp channels are absent (older games / legacy laps). */
    tyreTemp: TireTempSymptoms | null;
    /** Per-corner damper profile (travel usage + shaft-velocity reads); null
     *  when the suspension-travel channel is flat/absent. */
    damper: DamperSymptoms | null;
    /** Stint-level weight-transfer read (LLTD, static bias, dive, g envelope);
     *  load-derived fields null when the wheelLoad channel is absent. */
    weightTransfer: WeightTransferSymptoms | null;
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
const SLOW_CORNER_KPH = 100;
const FAST_CORNER_KPH = 160;

/** Bucket an apex speed into slow/medium/fast; undefined when speed unknown. */
export function classifySpeedBand(minSpeedKph?: number): SpeedBand | undefined {
  if (minSpeedKph == null || !Number.isFinite(minSpeedKph)) return undefined;
  if (minSpeedKph < SLOW_CORNER_KPH) return "slow";
  if (minSpeedKph > FAST_CORNER_KPH) return "fast";
  return "medium";
}

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

  // Lap distance span, for placing each corner as a 0-1 fraction along the lap.
  const lapStart = packets.length > 0 ? packets[0].DistanceTraveled : 0;
  const lapSpan = packets.length > 0 ? packets[packets.length - 1].DistanceTraveled - lapStart : 0;

  for (const corner of corners) {
    // detectCorners reports corner bounds relative to lap start, so match
    // frames on the same relative distance — not absolute DistanceTraveled,
    // which is cumulative and only coincides when a lap starts at 0.
    const frames = packets.filter((p) => {
      const rel = p.DistanceTraveled - lapStart;
      return rel >= corner.distanceStart && rel <= corner.distanceEnd;
    });
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

    // Corner mid-point is already relative to lap start, so it maps directly
    // onto the lap-distance span.
    const mid = (corner.distanceStart + corner.distanceEnd) / 2;
    const distanceFrac = lapSpan > 0 ? Math.min(1, Math.max(0, mid / lapSpan)) : undefined;
    cornerSymptoms.push({
      index: corner.index,
      label: corner.label,
      distanceFrac,
      minSpeedKph: corner.minSpeedKph,
      speedBand: classifySpeedBand(corner.minSpeedKph),
      phases,
      load: cornerWeightTransfer(frames),
    });
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
      tyreTemp: tireTempSymptoms(packets),
      damper: damperSymptoms(packets),
      weightTransfer: weightTransferSymptoms(packets),
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
