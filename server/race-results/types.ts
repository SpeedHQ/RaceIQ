import type { GameId } from "../../shared/games/ids";
import type { RaceEventId } from "../../shared/racing/events/contracts";
import type { RaceResultClaimEvidence, RaceResultEvidence, RaceResultOutcomeStatus, RaceResultProvenance, RaceResultStatus } from "../../shared/racing/results/types";

export type ResultSessionType = "practice" | "qualifying" | "race" | "other" | "unknown";
export type ResultClassification = RaceResultStatus;
export type RaceResultClaimSource = "final-classification" | "lap-data";

/** Adapter-owned result facts for one semantic race-event observation. */
export interface RaceResultSourceEvidence {
  sessionType?: string | null;
  classification?: ResultClassification | null;
  classificationSource?: RaceResultClaimSource | null;
  finishingPosition?: number | null;
  finishingPositionSource?: RaceResultClaimSource | null;
  qualifyingPosition?: number | null;
  qualifyingPositionSource?: RaceResultClaimSource | null;
  isFastestLap?: boolean | null;
  fastestLapSource?: string | null;
  resultReason?: number | null;
  observedAtMs?: number | null;
  sourcePaths?: Partial<Record<"sessionType" | "classification" | "finishingPosition" | "qualifyingPosition" | "isFastestLap" | "resultReason", string>>;
}

export interface RaceSourceObservation {
  gameId: GameId;
  sessionType?: string | null;
  classification?: ResultClassification | null;
  finishingPosition?: number | null;
  qualifyingPosition?: number | null;
  isFastestLap?: boolean | null;
  fastestLapSource?: string | null;
  claims?: RaceResultClaimEvidence[];
  tyreStrategy?: unknown;
  fuelStrategy?: unknown;
  provenance: RaceResultProvenance;
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
  eventIds: RaceEventId[];
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance: RaceResultProvenance;
  outcomeStatus: RaceResultOutcomeStatus;
  evidence: RaceResultEvidence;
  reasons: string[];
}
