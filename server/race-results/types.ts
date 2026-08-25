import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type {
  RaceEventId,
} from "../../shared/racing/events/contracts";
import type {
  RaceResultClaimEvidence,
  RaceResultEvidence,
  RaceResultOutcomeStatus,
  RaceResultProvenance,
  RaceResultStatus,
} from "../../shared/racing/results/types";

export type ResultSessionType = "practice" | "qualifying" | "race" | "other" | "unknown";
export type ResultClassification = RaceResultStatus;

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
