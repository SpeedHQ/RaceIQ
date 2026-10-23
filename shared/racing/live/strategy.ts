import type { GameId } from "../../games/ids";

export type FourWheels<T> = [T, T, T, T];
export type StrategyFuelUnit = "L" | "tankFraction";
export interface CompatibilityContext {
  fuelSemanticVersion: string | null;
  tireSemanticVersions: FourWheels<string | null>;
  virtualEnergySemanticVersion?: string | null;
  setupKey: string | null;
  conditions: { weather: string | null; airTemperatureC: number | null; trackTemperatureC: number | null };
}
export interface SourceOrder { epochOrdinal: number; sequence: number }
export interface MetricRate {
  value: number | null;
  unit: "L/lap" | "tankFraction/lap" | "wearFraction/lap" | "energyFraction/lap";
  eligibleLaps: number;
  source: "history" | "current-stint" | null;
  provisional: boolean;
  unavailableReason: string | null;
}
export interface StintSummary {
  id: string;
  sessionId: number;
  driverKey: string;
  ordinal: number;
  status: "active" | "completed" | "interrupted";
  gameId: GameId;
  trackId: string;
  carId: string;
  pi: number | null;
  compounds: FourWheels<string | null>;
  compatibility: CompatibilityContext;
  startedAt: string;
  endedAt: string | null;
  firstLapNumber: number | null;
  lastLapNumber: number | null;
  boundary: { reason: string; confidence: "observed" | "inferred" | "unknown" };
  completedLaps: number;
  fuel: MetricRate;
  tires: FourWheels<MetricRate>;
  /** Full-stint eligible lap statistics; absent on evidence saved before this version. */
  rateStatistics?: {
    fuel: { p50: number | null; p95: number | null };
    tires: FourWheels<{ p50: number | null; p95: number | null }>;
  };
  /** Same percentiles for laps measured on cold tires only. */
  coldRateStatistics?: { p50: number | null; p95: number | null };
  coldTireRateStatistics?: FourWheels<{ p50: number | null; p95: number | null }>;
  coldLaps?: number;
  virtualEnergy?: MetricRate;
  measuredFuelUsed: number | null;
  fuelUnit: StrategyFuelUnit;
  fuelCoverage: "complete" | "partial" | "unavailable";
  averageLapSeconds: number | null;
  paceLaps: number;
  exclusions: { reason: string; count: number }[];
  algorithmVersion: string;
  revision: number;
}
export interface HistoricalBaseline {
  fuel: MetricRate;
  tires: FourWheels<MetricRate>;
  evidence: { metric: "fuel" | "fl" | "fr" | "rl" | "rr"; sessionId: number; stintId: string; eligibleLaps: number; endedAt: string }[];
  lastObservedAt: string | null;
  limitations: string[];
  historyRevision: number;
}
export interface PitEstimateRecord {
  id: string;
  sessionId: number;
  driverKey: string;
  stintId: string;
  gameId: GameId;
  trackId: string;
  carId: string;
  pi: number | null;
  compounds: FourWheels<string | null>;
  observedAt: string;
  sourceOrder: SourceOrder;
  sourceCoordinate: { epoch: string; domain: "session" | "wall-clock"; milliseconds: number };
  trigger: "lap-completed" | "limiter-changed" | "stint-ended";
  pitInLaps: number | null;
  estimatedPitTime: { sessionElapsedSeconds: number | null };
  limitedBy: "fuel" | "tires" | null;
  tyreChangeSuggestion: "consider-change" | "not-indicated" | "unavailable";
  fuelChangeSuggestion: "consider-refuel" | "not-indicated" | "unavailable";
  fuel: MetricRate;
  tires: FourWheels<MetricRate>;
  sourceSnapshot: { fuelRemaining: number | null; fuelUnit: StrategyFuelUnit; wear: FourWheels<number | null>; lapId: number | null };
  compatibility: CompatibilityContext;
  baseline: HistoricalBaseline | null;
  algorithmVersion: string;
}
export interface LiveStrategy {
  sessionId: number;
  driverKey: string;
  stintId: string;
  revision: number;
  historyRevision: number;
  fuel: MetricRate;
  tires: FourWheels<MetricRate>;
  baseline: HistoricalBaseline | null;
  persistence: "ok" | "error";
}
export interface StrategyUpdatedMessage {
  type: "strategy-updated";
  sessionId: number;
  driverKey: string;
  stintId: string;
  revision: number;
}
export interface StrategyHistoryUpdatedMessage {
  type: "strategy-history-updated";
  gameId: GameId;
  driverKey: string;
  historyRevision: number;
}
export interface StrategyEstimatesClearedMessage {
  type: "strategy-estimates-cleared";
  gameId: GameId;
  sessionId: number;
  driverKey: string;
}
export interface PitEstimatePage { estimates: PitEstimateRecord[]; nextCursor: string | null }
