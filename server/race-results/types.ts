import type { GameId, TelemetryPacket } from "../../shared/types";
import type { RaceResultEvidence, RaceResultOutcomeStatus, RaceResultStatus } from "../../shared/race-results";

export type ResultSessionType = "practice" | "qualifying" | "race" | "other" | "unknown";
export type ResultClassification = RaceResultStatus;
export type PitService = "tyres" | "fuel" | "combined" | "unknown";
export type PitLinkage = "linked" | "unlinked" | "unknown";

export interface PitEvent {
  sequence: number;
  lapNumber: number | null;
  elapsedSeconds: number | null;
  durationSeconds: number | null;
  service: PitService;
  tyreChange: unknown;
  fuelAdded: number | null;
  fuelBefore: number | null;
  fuelAfter: number | null;
  linkage: PitLinkage;
  source: Record<string, unknown>;
}

export interface RaceSourceObservation {
  gameId: GameId;
  sessionType?: string | null;
  classification?: ResultClassification | null;
  finishingPosition?: number | null;
  qualifyingPosition?: number | null;
  isFastestLap?: boolean | null;
  fastestLapSource?: string | null;
  packets: TelemetryPacket[];
  pitEvents?: PitEvent[];
  tyreStrategy?: unknown;
  fuelStrategy?: unknown;
  provenance: Record<string, unknown>;
  evidence: RaceResultEvidence;
  reasons: string[];
}

export interface DerivedRaceResult {
  sessionType: ResultSessionType;
  classification: ResultClassification;
  finishingPosition: number | null;
  qualifyingPosition: number | null;
  isPodium: boolean | null;
  isFastestLap: boolean | null;
  pitCount: number;
  events: PitEvent[];
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance: Record<string, unknown>;
  outcomeStatus: RaceResultOutcomeStatus;
  evidence: RaceResultEvidence;
  reasons: string[];
}
