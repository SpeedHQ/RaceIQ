export type LapPhase = "flying" | "out" | "in" | "pit" | "grid_start";
export type LapCondition = "caution" | "slow_zone" | "formation";
export type PaceEligibility = "eligible" | "excluded";

export const LAP_PHASE_META = {
  flying: { label: "Pace" },
  out: { label: "Out lap" },
  in: { label: "In lap" },
  pit: { label: "Pit lap" },
  grid_start: { label: "Grid start" },
} as const satisfies Record<LapPhase, { label: string }>;

export const LAP_CONDITION_META = {
  caution: { label: "Caution" },
  slow_zone: { label: "Slow zone" },
  formation: { label: "Formation" },
} as const satisfies Record<LapCondition, { label: string }>;

export type LapClassificationTone = "success" | "warning";

export interface LapClassification {
  phase: LapPhase;
  conditions: LapCondition[];
  paceEligibility: PaceEligibility;
}

/**
 * Authoritative timeline facts used to classify a completed lap. Packet
 * buffers are deliberately absent: pit and race-control semantics belong to
 * the race-event coordinator, not to lap storage.
 */
export interface LapTimelineClassificationContext {
  pitPhase: Extract<LapPhase, "out" | "in" | "pit"> | null;
  conditions: LapCondition[];
  gridStart: boolean;
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

function phasePaceEligibility(phase: LapPhase, conditions: LapCondition[]): PaceEligibility {
  return phase === "flying" && conditions.length === 0 ? "eligible" : "excluded";
}

/**
 * Classify one completed lap from coordinator-owned timeline facts. Validity
 * stays independent: classification describes pace eligibility only.
 */
export function classifyLap(context: LapTimelineClassificationContext): LapClassification {
  const conditions = [...new Set(context.conditions)];
  const phase: LapPhase = context.pitPhase ?? (context.gridStart ? "grid_start" : "flying");

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
