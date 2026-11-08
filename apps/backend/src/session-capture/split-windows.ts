import { PARSER_BOOTSTRAP_VERSION } from "@raceiq/capture-formats/session/framing";
import { prepareSplitWindows, type DetectedLapWindow, type LapWindow, type Progress } from "@raceiq/capture-splitting";
import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";

export type { DetectedLapWindow };
type SplitWindowGameAdapter = Pick<ServerGameAdapter,
  "id" | "appendsDelayedFinishFrame" | "createParserState" | "captureParserCheckpoint" | "restoreParserCheckpoint" | "tryParse">
  & Partial<Pick<ServerGameAdapter, "primeParserState">>;

/** Bind game-owned parser operations to package-owned generic preparation. */
export function prepareLapWindowsForSplit(
  source: SessionCaptureSource,
  windows: readonly DetectedLapWindow[],
  game: SplitWindowGameAdapter,
  signal?: AbortSignal,
  onProgress?: (progress: Progress) => void,
): Promise<LapWindow[]> {
  if (game.id !== source.gameId) throw new Error(`Split game ${game.id} does not match source game ${source.gameId}`);
  return prepareSplitWindows({
    windows,
    source: () => iterateSessionCaptureRecordsFromSource(source, { strict: true }),
    codec: {
      gameId: game.id,
      appendsDelayedFinishFrame: game.appendsDelayedFinishFrame,
      createState: () => game.createParserState(),
      ...(game.captureParserCheckpoint ? { captureCheckpoint: (state: unknown) => game.captureParserCheckpoint!(state) } : {}),
      ...(game.restoreParserCheckpoint ? { restoreCheckpoint: (state: unknown, payload: Uint8Array) => game.restoreParserCheckpoint!(state, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)) } : {}),
      ...(game.tryParse ? { parseFrame: (frame: Uint8Array, state: unknown) => game.tryParse(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), state) } : {}),
      ...(game.primeParserState ? { primeFrame: (frame: Uint8Array, state: unknown) => game.primeParserState!(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), state) } : {}),
    },
    bootstrapVersion: PARSER_BOOTSTRAP_VERSION,
    signal,
    onProgress,
  });
}
