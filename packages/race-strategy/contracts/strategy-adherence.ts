import type { RacePlan } from "@raceiq/shared/racing/live/race-plan";
import type { FourWheels, LiveStrategy, PitEstimateRecord, StintSummary, StrategyFuelUnit } from "@raceiq/shared/racing/live/strategy";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";

export type AdherenceState = "within" | "over" | "unknown";
export type AdherenceBasis = "measured" | "plan" | "unknown";
export type AdherenceReason = "evidence" | "position" | "settings" | "capacity" | "compound" | "energy" | "history" | "infeasible";
export interface AdherencePoint { lap: number; value: number; breakBefore: boolean }
export interface AdherenceCheckpoint {
  lap: number;
  fuelRemaining: number | null;
  tireWear: FourWheels<number | null>;
  compounds: FourWheels<string | null>;
}
export interface AdherenceResource {
  state: AdherenceState;
  basis: AdherenceBasis;
  plannedRate: number | null;
  observedRate: number | null;
  eligibleLaps: number;
  actual: readonly AdherencePoint[];
  reference: readonly AdherencePoint[];
}
export interface AdaptivePitWindow {
  state: "upcoming" | "open" | "overdue" | "finish" | "unknown";
  earliestLap: number | null;
  latestLap: number | null;
  stopsRemaining: number | null;
  limitedBy: "fuel" | "tires" | "energy" | null;
  basis: AdherenceBasis;
  reason: AdherenceReason | null;
}
export interface StrategyAdherenceModel {
  state: AdherenceState;
  currentPosition: number | null;
  plannedStopLaps: readonly number[];
  fuel: AdherenceResource;
  tires: FourWheels<AdherenceResource>;
  window: AdaptivePitWindow;
}
export interface ResolveAdherenceCheckpointsInput {
  plan: RacePlan;
  sessionId: number | null;
  driverKey: string | null;
  stintId: string | null;
  estimates: readonly PitEstimateRecord[];
  laps: readonly Pick<LapMeta, "id" | "sessionId" | "lapNumber">[];
}
export interface BuildStrategyAdherenceInput {
  plan: RacePlan;
  currentLap: number | null;
  lapFraction: number | null;
  fuelRemaining: number | null;
  fuelUnit: StrategyFuelUnit;
  fuelCapacity: number | null;
  tireWear: FourWheels<number | null>;
  virtualEnergy: number | null;
  strategy: LiveStrategy | null;
  currentStint: StintSummary | null;
  checkpoints: readonly AdherenceCheckpoint[];
  thresholds: FourWheels<TireThresholds>;
  evidenceLoading: boolean;
  evidenceError: boolean;
}

/** Implementations: ui/strategy-adherence-model.ts. Inputs use plan fuel units and wear fractions. */
export type ResolveAdherenceCheckpoints = (input: ResolveAdherenceCheckpointsInput) => AdherenceCheckpoint[];
export type BuildStrategyAdherence = (input: BuildStrategyAdherenceInput) => StrategyAdherenceModel;
