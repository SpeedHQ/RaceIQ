import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";
import { getAllServerGames } from "../games/registry";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { IRACING_DUMP_MAGIC, readIRacingFramesFromBuffer } from "@raceiq/capture-formats/iracing/dump";
import {
  decompressIfGzipSync,
  iterateSessionFrames,
  iterateSessionCaptureRecords,
  SESSION_SEGMENT_BOUNDARY,
  SESSION_SEGMENT_CONTEXT,
  SESSION_SEGMENT_CONTEXT_END,
} from "./framing";
import { importSessionFrames, type ImportedLap, type ImportSessionOptions } from "./import-pipeline";

const GAME_IDS_BY_FILENAME_PRECEDENCE = [...KNOWN_GAME_IDS].sort(
  (a, b) => b.length - a.length,
);

/** Detect a gameId from an uploaded filename prefix (`<gameId>-...` / `<gameId>_...`). */
export function detectGameIdFromFilename(name: string): GameId | null {
  for (const id of GAME_IDS_BY_FILENAME_PRECEDENCE) {
    if (name.startsWith(`${id}-`) || name.startsWith(`${id}_`)) return id;
  }
  return null;
}

/** Detect a gameId from actual capture frame content. */
export function detectGameIdFromBuffer(bytes: Buffer): GameId | null {
  const buf = decompressIfGzipSync(bytes);
  const games = getAllServerGames();
  let checked = 0;
  const frames = hasLMUDumpMagic(buf) ? readLMUFramesFromBuffer(buf)
    : buf.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)
      ? readIRacingFramesFromBuffer(buf, 20) : iterateSessionFrames(buf);
  for (const frame of frames) {
    for (const game of games) {
      if (game.canHandle(frame)) return game.id;
    }
    checked++;
    if (checked >= 20) break;
  }
  return null;
}
function* canonicalImportFrames(bytes: Buffer) {
  for (const record of iterateSessionCaptureRecords(bytes)) {
    if (record.kind === "frame") yield { frame: record.frame, frameTimeMs: record.frameTimeMs };
    else if (record.kind === "segment-boundary") yield SESSION_SEGMENT_BOUNDARY;
    else if (record.kind === "segment-context") yield SESSION_SEGMENT_CONTEXT;
    else yield SESSION_SEGMENT_CONTEXT_END;
  }
}


/** Replay a canonical session capture through parser, detector, and persistence pipeline. */
export async function importSessionBin(
  bytes: Buffer,
  gameId: GameId,
  options: ImportSessionOptions = {},
): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  const buf = decompressIfGzipSync(bytes);
  const frames = gameId === "lmu" && hasLMUDumpMagic(buf)
    ? readLMUFramesFromBuffer(buf)
    : gameId === "iracing" && buf.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)
      ? readIRacingFramesFromBuffer(buf) : canonicalImportFrames(buf);
  const { packetCount, laps } = await importSessionFrames(
    frames,
    gameId,
    options,
  );
  return { packetCount, laps };
}
