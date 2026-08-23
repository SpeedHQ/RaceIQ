export type LapPhase = "flying" | "out" | "in" | "pit" | "grid_start";
export type LapCondition = "caution" | "slow_zone" | "formation";
export type PaceEligibility = "eligible" | "excluded";

export interface LapClassification {
  phase: LapPhase;
  conditions: LapCondition[];
  paceEligibility: PaceEligibility;
}

export const DEFAULT_LAP_CLASSIFICATION: LapClassification = {
  phase: "flying",
  conditions: [],
  paceEligibility: "eligible",
};
