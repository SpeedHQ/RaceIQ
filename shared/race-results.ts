import type { GameId } from "./types";

export type RaceResultSourceStatus = "direct" | "derived" | "simplified" | "unavailable";
export type RaceResultOutcomeStatus = "confirmed" | "provisional" | "unavailable";
export type RaceResultStatus =
  | "finished"
  | "dnf"
  | "disqualified"
  | "not-classified"
  | "retired"
  | "qualifying"
  | "unknown";

export interface RaceResultEvidence {
  fieldStatus: {
    sessionType: RaceResultSourceStatus;
    classification: RaceResultSourceStatus;
    finishingPosition: RaceResultSourceStatus;
    qualifyingPosition: RaceResultSourceStatus;
    isPodium: RaceResultSourceStatus;
    isFastestLap: RaceResultSourceStatus;
    pitEvents: RaceResultSourceStatus;
    tyreStrategy: RaceResultSourceStatus;
    fuelStrategy: RaceResultSourceStatus;
  };
  conflicts: string[];
}

export interface RaceResult {
  id: number;
  sessionId: number;
  gameId: GameId;
  sessionType: string;
  classification: RaceResultStatus;
  finishingPosition: number | null;
  qualifyingPosition: number | null;
  isPodium: boolean | null;
  isFastestLap: boolean | null;
  pitCount: number;
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance: unknown;
  reasons: string[];
  outcomeStatus: RaceResultOutcomeStatus;
  evidence: RaceResultEvidence;
  events: Array<{
    sequence: number;
    lapNumber: number | null;
    elapsedSeconds: number | null;
    durationSeconds: number | null;
    service: "tyres" | "fuel" | "combined" | "unknown";
    tyreChange: unknown;
    fuelAdded: number | null;
    fuelBefore: number | null;
    fuelAfter: number | null;
    linkage: "linked" | "unlinked" | "unknown";
    source: unknown;
  }>;
}

export interface RaceResultAggregate {
  gameId: GameId;
  sessions: number;
  finished: number;
  dnf: number;
  retired: number;
  qualifying: number;
  disqualified: number;
  notClassified: number;
  unknown: number;
  podiums: number;
  fastestLaps: number;
  pitStops: number;
  pitDurationSeconds: number | null;
  qualifyingToRaceMovement: number | null;
  tyreStrategyAvailable: boolean;
  fuelStrategyAvailable: boolean;
  confirmed: number;
  provisional: number;
  unavailable: number;
}
