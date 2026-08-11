import type { TelemetryPacket } from "../../telemetry/types";
import { classifyPitCycle } from "./pit-cycle";

export type LapPhase = "flying" | "out" | "in" | "pit" | "grid_start";
export type LapCondition = "caution" | "slow_zone" | "formation";
export type PaceEligibility = "eligible" | "excluded";

export const LAP_PHASE_META = {
  flying: { label: "Pace", tone: "success" as const },
  out: { label: "Out lap", tone: "warning" as const },
  in: { label: "In lap", tone: "warning" as const },
  pit: { label: "Pit lap", tone: "warning" as const },
  grid_start: { label: "Grid start", tone: "warning" as const },
} as const satisfies Record<LapPhase, { label: string; tone: "success" | "warning" }>;

export const LAP_CONDITION_META = {
  caution: { label: "Caution", tone: "warning" as const },
  slow_zone: { label: "Slow zone", tone: "warning" as const },
  formation: { label: "Formation", tone: "warning" as const },
} as const satisfies Record<LapCondition, { label: string; tone: "warning" }>;

export type LapClassificationTone = "success" | "warning";

export interface LapClassification {
  phase: LapPhase;
  conditions: LapCondition[];
  paceEligibility: PaceEligibility;
}

export interface ClassifiedLap {
  phase?: LapPhase | null;
  conditions?: LapCondition[] | null;
  paceEligibility?: PaceEligibility | null;
}

export const DEFAULT_LAP_CLASSIFICATION: LapClassification = {
  phase: "flying",
  conditions: [],
  paceEligibility: "eligible",
};


/** Missing eligibility defaults to eligible only for generic legacy-tolerant helpers. */
export function isPaceEligible(lap: ClassifiedLap): boolean {
  return (lap.paceEligibility ?? DEFAULT_LAP_CLASSIFICATION.paceEligibility) === "eligible";
}

function isF1GridStart(packet: TelemetryPacket): boolean {
  if (packet.gameId !== "f1-2025" || packet.LapNumber !== 1) return false;

  const gridPosition = packet.f1?.gridPosition;
  return (
    gridPosition !== undefined &&
    gridPosition > 0 &&
    packet.RacePosition > 0 &&
    packet.CurrentRaceTime >= 0 &&
    packet.CurrentRaceTime <= 5 &&
    Math.abs(packet.DistanceTraveled) >= 25
  );
}

function classifyConditions(packets: readonly TelemetryPacket[]): LapCondition[] {
  let caution = false;
  let slowZone = false;
  let formation = false;

  for (const packet of packets) {
    if (packet.gameId === "f1-2025") {
      const safetyCarStatus = packet.f1?.safetyCarStatus;
      caution ||= safetyCarStatus === 1 || packet.f1?.vehicleFIAFlags === 3;
      slowZone ||= safetyCarStatus === 2;
      formation ||= safetyCarStatus === 3;
    } else if (packet.gameId === "acc" || packet.gameId === "ac-evo") {
      caution ||= packet.acc?.flagStatus?.toLowerCase() === "yellow";
    }
  }

  const conditions: LapCondition[] = [];
  if (caution) conditions.push("caution");
  if (slowZone) conditions.push("slow_zone");
  if (formation) conditions.push("formation");
  return conditions;
}

function phasePaceEligibility(phase: LapPhase, conditions: LapCondition[]): PaceEligibility {
  return phase === "flying" && conditions.length === 0 ? "eligible" : "excluded";
}

/**
 * Classify one completed lap from canonical packets emitted by game normalizers.
 * Validity stays independent: classification describes pace eligibility only.
 */
export function classifyLap(packets: readonly TelemetryPacket[]): LapClassification {
  const conditions = classifyConditions(packets);
  const pitCycle = classifyPitCycle(packets);
  const phase: LapPhase = pitCycle ?? (
    packets[0] && isF1GridStart(packets[0]) ? "grid_start" : "flying"
  );

  return {
    phase,
    conditions,
    paceEligibility: phasePaceEligibility(phase, conditions),
  };
}

export function lapClassificationLabel(classification: ClassifiedLap): string {
  const phase = classification.phase ?? DEFAULT_LAP_CLASSIFICATION.phase;
  const conditions = classification.conditions ?? DEFAULT_LAP_CLASSIFICATION.conditions;
  const parts: string[] = [];

  if (phase !== "flying") {
    parts.push(LAP_PHASE_META[phase].label);
  }
  for (const condition of conditions) {
    parts.push(LAP_CONDITION_META[condition].label);
  }
  if (parts.length === 0) {
    parts.push(LAP_PHASE_META.flying.label);
  }
  return parts.join(" · ");
}

export function lapClassificationTone(classification: ClassifiedLap): LapClassificationTone {
  return isPaceEligible(classification) ? "success" : "warning";
}
