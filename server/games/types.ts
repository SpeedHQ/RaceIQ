import type { GameAdapter } from "../../shared/games/types";
import type { TelemetryPacket } from "../../shared/types";
import type { LapDetectorFactory } from "../lap-detection/types";

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

  /** AI analyst system prompt for this game */
  aiSystemPrompt: string;

  /** Build game-specific context for AI prompt (e.g. F1 DRS/ERS data) */
  buildAiContext?(packets: TelemetryPacket[]): string;

  /** Process names to check if this game is running (e.g. ["acc.exe"]) */
  processNames?: string[];

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
