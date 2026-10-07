import type { TelemetryPacket } from "./types";
import type { LapIndexPacket } from "./lap-index";

/** Backend-independent game parser operations; state belongs to caller invocation. */
export interface TelemetryParser<State = unknown> {
  canHandle(buf: Buffer): boolean;
  tryParse(buf: Buffer, state: State, timestampMs?: number): TelemetryPacket | null;
  tryParseLapIndex(buf: Buffer, state: State, timestampMs?: number): LapIndexPacket | null;
  primeParserState(buf: Buffer, state: State): void;
  createParserState(): State;
}
