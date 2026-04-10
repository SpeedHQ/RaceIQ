import type { GameAdapter } from "../../shared/games/types";
import type { TelemetryPacket } from "../../shared/types";
import type { LapDetectorFactory } from "../lap-detector-interface";

/** Server-only extensions for game adapters — parsing, AI prompts. */
export interface ServerGameAdapter extends GameAdapter {
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
}
