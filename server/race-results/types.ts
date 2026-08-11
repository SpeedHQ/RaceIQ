import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type {
  RaceResultClaimEvidence,
  RaceResultEvidence,
  RaceResultOutcomeStatus,
  RaceResultProvenance,
  RaceResultStatus,
} from "../../shared/racing/results/types";

export type ResultSessionType = "practice" | "qualifying" | "race" | "other" | "unknown";
export type ResultClassification = RaceResultStatus;
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
  claims?: RaceResultClaimEvidence[];
  pitEvents?: PitEvent[];
  positionChanges?: PositionChangeEvent[];
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
  events: PitEvent[];
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance: RaceResultProvenance;
  outcomeStatus: RaceResultOutcomeStatus;
  evidence: RaceResultEvidence;
  reasons: string[];
}
