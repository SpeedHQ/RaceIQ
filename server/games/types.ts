import type { GameAdapter } from "../../shared/games/types";
import type { GameId } from "../../shared/games/ids";
import type {
  CautionKind,
  PitObservationState,
  RaceSessionPhase,
} from "../../shared/racing/events/contracts";
import type {
  ParticipantKind,
  ParticipantEvidence,
} from "../../shared/racing/quality/contracts";
import type { SourceSequenceObservation } from "../../shared/telemetry/source-sequence";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LapDetectorFactory } from "../lap-detection/types";

export interface FourCornerRaceEventValue {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

export type ParticipantRetirementStatus =
  | "unknown"
  | "active"
  | "finished"
  | "retired"
  | "disqualified";

export interface RaceParticipantObservation {
  participantId: string;
  participantKind: ParticipantKind;
  sourceId: string | null;
  identityState: ParticipantEvidence["identityState"];
  driverId: string | null;
  teamId: string | null;
  displayName: string | null;
  vehicleId: string | null;
  pitState: PitObservationState;
  /** Native pit code is retained without treating a code as stall evidence. */
  nativePitCode: string | number | null;
  position: number | null;
  speedMps: number | null;
  fuelLitres: number | null;
  tireCompound: string | null;
  tireWear: FourCornerRaceEventValue | null;
  /** Component damage in percent, 0 (undamaged) through 100. */
  damage: Readonly<Record<string, number>> | null;
  penaltyValue: number | null;
  incidentCount: number | null;
  retirementStatus: ParticipantRetirementStatus;
  nativeRetirementCode: string | number | null;
}

export interface RaceEventObservation {
  gameId: GameId;
  sessionUid: string | null;
  receivedAtMs: number;
  sourceTimeMs: number;
  sourceSequences: SourceSequenceObservation[];
  lapNumber: number | null;
  currentLapTimeMs: number | null;
  lastLapTimeMs: number | null;
  trackDistanceM: number | null;
  trackDistancePct: number | null;
  worldPosition: { x: number; y: number; z: number } | null;
  sessionPhase: RaceSessionPhase;
  nativeRaceControlCode: string | number | null;
  cautionKind: CautionKind;
  gridStart: boolean | null;
  terminalObserved: boolean | null;
  participants: RaceParticipantObservation[];
  /** True only when absence from this snapshot is meaningful. */
  rosterAuthoritative: boolean;
}

export interface RaceEventObservationContext {
  /** Wall-clock diagnostic receipt time; never used as semantic source time. */
  receivedAtMs: number;
}

/** Server-only runtime behavior owned by each game implementation. */
export interface ServerGameRuntimePolicy {
  /** Pit strategy behavior and history seeding strategy. */
  pit: {
    /** Seed fuel history from prior sessions for this game. */
    seedFuelFromHistory: boolean;
    /** Seed tire-wear history from prior sessions for this game. */
    seedTireWearFromHistory: boolean;
    /** Use distance-based tire-wear curves when enough completed laps exist. */
    useDistanceBasedWearCurves: boolean;
  };

  /** Override packet BestLap from session detector state when native field is weak. */
  bestLapFromSession: boolean;

  /** Collect source positions for track-outline coordinate calibration. */
  requiresTrackCalibration: boolean;

  /** Millimeter travel range for derived suspension normalization fallback. */
  normSuspensionTravelMm: {
    min: number;
    max: number;
  };
}

/** Server-only extensions for game adapters — parsing, AI prompts. */
export interface ServerGameAdapter extends GameAdapter {
  /** Runtime policy knobs for server-side packet processors. */
  runtime: ServerGameRuntimePolicy;

  /** Quick check: does this buffer belong to this game? */
  canHandle(buf: Buffer): boolean;

  /**
   * Parse a UDP buffer into a TelemetryPacket.
   * Return null if the packet should be skipped (e.g. paused).
   * `state` is the per-game parser state from createParserState().
   */
  tryParse(buf: Buffer, state: unknown): TelemetryPacket | null;

  /** Create per-game parser state (e.g. F1's multi-packet accumulator). null = stateless. */
  createParserState(): unknown;

  /** Normalize game-owned facts for the shared deterministic event detectors. */
  toRaceEventObservation(
    packet: TelemetryPacket,
    context: RaceEventObservationContext,
  ): RaceEventObservation;

  /** AI analyst system prompt for this game */
  aiSystemPrompt: string;

  /** Build game-specific context for AI prompt (e.g. F1 DRS/ERS data) */
  buildAiContext?(packets: TelemetryPacket[]): string;

  /** Process names to check if this game is running (e.g. ["acc.exe"]) */
  processNames?: string[];

  /** Stable identity of the detector produced by this adapter. */
  readonly lapDetectorId: string;

  /** Factory that creates the lap detector implementation for this game. */
  createLapDetector: LapDetectorFactory;

  /**
   * Candidate directories (in preference order) where this game stores user
   * setup files, given the user's home dir. First existing one wins; the
   * first entry is created if none exist. Omit for games with no setup files
   * (e.g. f1-2025, whose setups only exist as telemetry snapshots).
   */
  getSetupsDirCandidates?(home: string): string[];
}
