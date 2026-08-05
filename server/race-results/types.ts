import type { GameId, TelemetryPacket } from "../../shared/types";

export type ResultSessionType = "practice" | "qualifying" | "race" | "other" | "unknown";
export type ResultClassification = "finished" | "dnf" | "retired" | "qualifying" | "unknown";
export type PitService = "tyres" | "fuel" | "combined" | "unknown";
export type PitLinkage = "linked" | "unlinked" | "unknown";
export type RaceEventType = "pit" | "position-change";

export interface PitEvent {
  eventType?: RaceEventType;
  sequence: number;
  lapNumber: number | null;
  elapsedSeconds: number | null;
  durationSeconds: number | null;
  service: PitService;
  tyreChange: unknown;
  fuelAdded: number | null;
  fuelBefore: number | null;
  fuelAfter: number | null;
  positionBefore?: number | null;
  positionAfter?: number | null;
  linkage: PitLinkage;
  source: Record<string, unknown>;
}

export interface PositionChangeEvent extends PitEvent {
  eventType: "position-change";
  lapNumber: number;
  positionBefore: number;
  positionAfter: number;
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
  positionChanges?: PositionChangeEvent[];
  tyreStrategy?: unknown;
  fuelStrategy?: unknown;
  provenance: Record<string, string>;
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
  provenance: Record<string, string>;
  reasons: string[];
}
