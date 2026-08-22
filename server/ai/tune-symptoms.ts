/**
 * telemetryToSymptoms — deterministic pass 1 of auto-tune analysis.
 *
 * Consumers receive resolver-backed canonical semantic samples only. Raw
 * telemetry stays at ingest, recording, storage-decode, and resolver bounds.
 */
import type { GameId } from "../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { Corner } from "../lap-analysis/corners";
import { semanticFixedNumbers, semanticNumber } from "../telemetry/semantic-samples";
import { tireTempSymptoms, type TireTempSymptoms } from "./tune-tire-symptoms";
import { damperSymptoms, type DamperSymptoms } from "./tune-damper-symptoms";
import { weightTransferSymptoms, cornerWeightTransfer, type CornerLoad, type WeightTransferSymptoms } from "./tune-weight-transfer";

export const TUNE_SYMPTOM_SEMANTIC_IDS = [
  "timing.distance-traveled",
  "inputs.brake",
  "tires.tire-slip-angle",
  "tires.tire-slip-ratio",
  "suspension.norm-suspension-travel",
  "tires.tire-pressure",
  "tire.temperature.carcass.average",
  "tires.tire-inner-temp",
  "tire.temperature.surface.middle",
  "tire.temperature.surface.outer",
  "motion.speed",
  "motion.acceleration-x",
  "motion.acceleration-y",
  "suspension.wheel-load",
] as const satisfies readonly TelemetryVariableId[];

export type Balance = "oversteer" | "understeer" | "neutral";
export type Phase = "entry" | "mid" | "exit";
export type SpeedBand = "slow" | "medium" | "fast";

const PHASES = ["entry", "mid", "exit"] as const satisfies readonly Phase[];

export interface PhaseSymptom {
  phase: Phase;
  /** Undefined when a complete four-wheel slip-angle channel is unavailable. */
  balance?: Balance;
  /** Front-minus-rear mean |slip angle| (rad); undefined with unavailable slip. */
  balanceMagnitude?: number;
  /** Undefined when brake or complete four-wheel slip-ratio data is unavailable. */
  brakeLockup?: boolean;
  /** Undefined when complete four-wheel suspension travel is unavailable. */
  bottoming?: boolean;
}

export interface CornerSymptom {
  index: number;
  label: string;
  distanceFrac?: number;
  minSpeedKph?: number;
  speedBand?: SpeedBand;
  phases: PhaseSymptom[];
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
    tyrePressure: TyreDeltas | null;
    tyreTemp: TireTempSymptoms | null;
    damper: DamperSymptoms | null;
    weightTransfer: WeightTransferSymptoms | null;
  };
}

export const BALANCE_THRESHOLD = 0.02;
export const LOCKUP_SLIP = 0.15;
export const BRAKE_ON = 0.2;
export const BOTTOM_TRAVEL = 0.95;
export const ACC_PRESSURE_TARGET = 27.5;
const SLOW_CORNER_KPH = 100;
const FAST_CORNER_KPH = 160;
const WHEELS = 4;

export function classifySpeedBand(minSpeedKph?: number): SpeedBand | undefined {
  if (minSpeedKph == null || !Number.isFinite(minSpeedKph)) return undefined;
  if (minSpeedKph < SLOW_CORNER_KPH) return "slow";
  if (minSpeedKph > FAST_CORNER_KPH) return "fast";
  return "medium";
}

function mean(total: number, count: number): number | undefined {
  return count > 0 ? total / count : undefined;
}

/** Convert canonical 0–255 brake input to a 0–1 fraction. */
export function brakeFrac(sample: SemanticTelemetrySample): number | null {
  const brake = semanticNumber(sample, "inputs.brake");
  return brake == null ? null : brake > 1 ? brake / 255 : brake;
}

function classifyBalance(
  frontSlip: number,
  rearSlip: number,
): {
  balance: Balance;
  magnitude: number;
} {
  const magnitude = frontSlip - rearSlip;
  if (magnitude > BALANCE_THRESHOLD) return { balance: "understeer", magnitude };
  if (magnitude < -BALANCE_THRESHOLD) return { balance: "oversteer", magnitude };
  return { balance: "neutral", magnitude };
}

function summarisePhase(phase: Phase, frames: readonly SemanticTelemetrySample[]): PhaseSymptom {
  let frontSlipTotal = 0;
  let rearSlipTotal = 0;
  let slipFrames = 0;
  let hasBrakeAndSlip = false;
  let brakeLockup = false;
  let hasTravel = false;
  let bottoming = false;

  for (const frame of frames) {
    const angles = semanticFixedNumbers(frame, "tires.tire-slip-angle", WHEELS);
    if (angles) {
      frontSlipTotal += (Math.abs(angles[0]) + Math.abs(angles[1])) / 2;
      rearSlipTotal += (Math.abs(angles[2]) + Math.abs(angles[3])) / 2;
      slipFrames += 1;
    }

    const brake = brakeFrac(frame);
    const ratios = semanticFixedNumbers(frame, "tires.tire-slip-ratio", WHEELS);
    if (brake != null && ratios) {
      hasBrakeAndSlip = true;
      if (brake > BRAKE_ON && (Math.abs(ratios[0]) > LOCKUP_SLIP || Math.abs(ratios[1]) > LOCKUP_SLIP || Math.abs(ratios[2]) > LOCKUP_SLIP || Math.abs(ratios[3]) > LOCKUP_SLIP)) {
        brakeLockup = true;
      }
    }

    const travel = semanticFixedNumbers(frame, "suspension.norm-suspension-travel", WHEELS);
    if (travel) {
      hasTravel = true;
      if (travel[0] > BOTTOM_TRAVEL || travel[1] > BOTTOM_TRAVEL || travel[2] > BOTTOM_TRAVEL || travel[3] > BOTTOM_TRAVEL) {
        bottoming = true;
      }
    }
  }

  const frontSlip = mean(frontSlipTotal, slipFrames);
  const rearSlip = mean(rearSlipTotal, slipFrames);
  const balance = frontSlip == null || rearSlip == null ? undefined : classifyBalance(frontSlip, rearSlip);
  return {
    phase,
    ...(balance ? { balance: balance.balance, balanceMagnitude: balance.magnitude } : {}),
    ...(hasBrakeAndSlip ? { brakeLockup } : {}),
    ...(hasTravel ? { bottoming } : {}),
  };
}

function splitPhases(frames: readonly SemanticTelemetrySample[]): Record<Phase, readonly SemanticTelemetrySample[]> {
  const firstThird = Math.floor(frames.length / 3);
  const secondThird = Math.floor((2 * frames.length) / 3);
  return {
    entry: frames.slice(0, firstThird),
    mid: frames.slice(firstThird, secondThird),
    exit: frames.slice(secondThird),
  };
}

export function telemetryToSymptoms(gameId: GameId, samples: readonly SemanticTelemetrySample[], corners: readonly Corner[]): TuneSymptoms {
  if (!gameId) throw new Error("gameId is required for tune symptom analysis");
  const cornerSymptoms: CornerSymptom[] = [];
  const understeerCorners: string[] = [];
  const oversteerCorners: string[] = [];
  const lockupCorners: string[] = [];
  const bottomingCorners: string[] = [];

  const firstDistance = samples.length > 0 ? semanticNumber(samples[0], "timing.distance-traveled") : null;
  const lastDistance = samples.length > 0 ? semanticNumber(samples[samples.length - 1], "timing.distance-traveled") : null;
  const lapSpan = firstDistance != null && lastDistance != null ? lastDistance - firstDistance : null;

  if (firstDistance != null && lapSpan != null) {
    for (const corner of corners) {
      const frames: SemanticTelemetrySample[] = [];
      for (const sample of samples) {
        const distance = semanticNumber(sample, "timing.distance-traveled");
        if (distance == null) continue;
        const relativeDistance = distance - firstDistance;
        if (relativeDistance >= corner.distanceStart && relativeDistance <= corner.distanceEnd) {
          frames.push(sample);
        }
      }
      if (frames.length < 3) continue;

      const split = splitPhases(frames);
      const phases: PhaseSymptom[] = PHASES.map((phase) => summarisePhase(phase, split[phase]));
      if (phases.some((phase) => phase.balance === "understeer")) understeerCorners.push(corner.label);
      if (phases.some((phase) => phase.balance === "oversteer")) oversteerCorners.push(corner.label);
      if (phases.some((phase) => phase.brakeLockup === true)) lockupCorners.push(corner.label);
      if (phases.some((phase) => phase.bottoming === true)) bottomingCorners.push(corner.label);

      const midpoint = (corner.distanceStart + corner.distanceEnd) / 2;
      const distanceFrac = lapSpan > 0 ? Math.min(1, Math.max(0, midpoint / lapSpan)) : undefined;
      cornerSymptoms.push({
        index: corner.index,
        label: corner.label,
        distanceFrac,
        minSpeedKph: corner.minSpeedKph,
        speedBand: classifySpeedBand(corner.minSpeedKph),
        phases,
        load: cornerWeightTransfer(gameId, frames),
      });
    }
  }

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
      tyrePressure: tyrePressureDeltas(gameId, samples),
      tyreTemp: tireTempSymptoms(gameId, samples),
      damper: damperSymptoms(gameId, samples),
      weightTransfer: weightTransferSymptoms(gameId, samples),
    },
  };
}

function tyrePressureDeltas(gameId: GameId, samples: readonly SemanticTelemetrySample[]): TyreDeltas | null {
  if (gameId !== "acc" && gameId !== "ac-evo") return null;
  let fl = 0;
  let fr = 0;
  let rl = 0;
  let rr = 0;
  let count = 0;
  for (const sample of samples) {
    const pressure = semanticFixedNumbers(sample, "tires.tire-pressure", WHEELS);
    if (!pressure) continue;
    fl += pressure[0];
    fr += pressure[1];
    rl += pressure[2];
    rr += pressure[3];
    count += 1;
  }
  if (count === 0) return null;
  return {
    FL: fl / count - ACC_PRESSURE_TARGET,
    FR: fr / count - ACC_PRESSURE_TARGET,
    RL: rl / count - ACC_PRESSURE_TARGET,
    RR: rr / count - ACC_PRESSURE_TARGET,
  };
}
