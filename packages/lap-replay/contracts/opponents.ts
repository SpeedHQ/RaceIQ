import type { SemanticLapTelemetry, SemanticReplayFrame } from "./replay";
import type { LmuResolvedValueWire } from "@raceiq/shared/telemetry/lmu-context";

export type OpponentLapReference =
  | { kind: "player"; lapId: number }
  | { kind: "opponent"; playerLapId: number; opponentLapId: string; sourceRevision: string };

export type OpponentLapReason =
  | "partial-lap" | "invalid-lap" | "unknown-validity" | "restricted-channels"
  | "missing-timing" | "missing-distance" | "missing-position" | "no-comparable-data";

export interface OpponentLapSummary {
  opponentLapId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  driverName: string | null;
  carName: string | null;
  className: string | null;
  lapNumber: number | null;
  coverage: "complete" | "partial";
  validity: "valid" | "invalid" | "unknown";
  lapTime: LmuResolvedValueWire<number>;
  sectors: readonly { semanticId: string; duration: LmuResolvedValueWire<number> }[];
  comparableSemanticIds: readonly string[];
  mode: "timing-only" | "telemetry" | "unavailable";
  reasons: readonly OpponentLapReason[];
}

export interface OpponentSessionSummary {
  opponentSessionId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  driverName: string | null;
  carName: string | null;
  className: string | null;
  lapIds: readonly string[];
}


export interface OpponentLapCatalog {
  playerLapId: number;
  sourceRevision: string;
  opponentRetention: "retained" | "removed" | "not-recorded";
  opponentAvailability: "complete" | "incomplete" | "missing" | "corrupt" | null;
  sessions: readonly OpponentSessionSummary[];
  laps: readonly OpponentLapSummary[];
}

export interface OpponentLapComparison {
  playerLapId: number;
  sourceRevision: string;
  opponent: OpponentLapSummary;
  mode: "timing-only" | "telemetry";
  lapDeltaSeconds: LmuResolvedValueWire<number>;
  sectorDeltas: readonly { semanticId: string; deltaSeconds: LmuResolvedValueWire<number> }[];
  traces: readonly {
    semanticId: string;
    unit: string;
    distanceMeters: readonly number[];
    player: readonly LmuResolvedValueWire<number>[];
    opponent: readonly LmuResolvedValueWire<number>[];
  }[];
}

export type OpponentComparisonRequest =
  | { opponentLapId: string; sourceRevision: string; step: 1 }
  | { opponentLapId: string; sourceRevision: string; step: 0.1; start: number; end: number };

export type OpponentDataErrorCode =
  | "INVALID_OPPONENT_COMPARISON" | "LAP_NOT_FOUND" | "OPPONENT_LAP_NOT_FOUND"
  | "SOURCE_CHANGED" | "OPPONENT_DATA_REMOVED" | "OPPONENT_DATA_UNAVAILABLE"
  | "STORAGE_IO_ERROR";

export interface OpponentDataError {
  code: OpponentDataErrorCode;
  error: string;
}

export type OpponentSemanticLapTelemetry = Omit<SemanticLapTelemetry, "lapId" | "envelopes"> & {
  opponentLapId: string;
  sourceRevision: string;
  envelopes: readonly SemanticReplayFrame[];
};
