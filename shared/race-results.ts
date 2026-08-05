import type { GameId } from "./types";

export const RACE_RESULT_PROCESSOR_ID = "race-result-v1";

export type RaceResultStatus = "finished" | "dnf" | "retired" | "qualifying" | "unknown";
export interface RaceResult {
  id: number;
  sessionId: number;
  gameId: GameId;
  processorVersion: string;
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
  events: Array<{
    eventType?: "pit" | "position-change";
    sequence: number;
    lapNumber: number | null;
    elapsedSeconds: number | null;
    durationSeconds: number | null;
    service: "tyres" | "fuel" | "combined" | "unknown";
    tyreChange: unknown;
    fuelAdded: number | null;
    fuelBefore: number | null;
    fuelAfter: number | null;
    positionBefore?: number | null;
    positionAfter?: number | null;
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
  unknown: number;
  podiums: number;
  fastestLaps: number;
  pitStops: number;
  pitDurationSeconds: number | null;
  qualifyingToRaceMovement: number | null;
  tyreStrategyAvailable: boolean;
  fuelStrategyAvailable: boolean;
}
