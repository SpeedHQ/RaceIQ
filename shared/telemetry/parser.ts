import type { TelemetryPacket } from "./types";
import type { LapIndexPacket } from "./lap-index";

/** Backend-independent game parser operations; state belongs to caller invocation. */
export interface TelemetryParser<State = unknown> {
  canHandle(buf: Buffer): boolean;
  tryParse(buf: Buffer, state: State, timestampMs?: number): TelemetryPacket | null;
  tryParseLapIndex(buf: Buffer, state: State, timestampMs?: number): LapIndexPacket | null;
  primeParserState(buf: Buffer, state: State): void;
  createParserState(): State;
  /** Restore only game-owned parser state; unsupported checkpoint formats must throw. */
  restoreParserCheckpoint?(state: State, payload: Uint8Array): State;
  /** Clear active-driver freshness after restoration without discarding parser context. */
  invalidateDriverEvidence?(state: State): void;
}
