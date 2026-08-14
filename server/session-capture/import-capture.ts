import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { getAllServerGames } from "../games/registry";
import { decompressIfGzipSync, iterateSessionFrameRecords, iterateSessionFrames, META_FRAME_MAGIC } from "./framing";
import { importSessionFrames, InvalidImportDataError, type ImportedLap, type ImportSessionFramesOptions } from "./import-pipeline";
import { sha256ContentHash } from "./identity";

const GAME_IDS_BY_FILENAME_PRECEDENCE = [...KNOWN_GAME_IDS].sort((a, b) => b.length - a.length);

/** Detect a gameId from an uploaded filename prefix (`<gameId>-...` / `<gameId>_...`). */
export function detectGameIdFromFilename(name: string): GameId | null {
  for (const id of GAME_IDS_BY_FILENAME_PRECEDENCE) {
    if (name.startsWith(`${id}-`) || name.startsWith(`${id}_`)) return id;
  }
  return null;
}

function* iterateGameDetectionFrames(bytes: Buffer): Generator<Buffer> {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === META_FRAME_MAGIC) {
    yield* iterateSessionFrames(bytes);
    return;
  }

  for (const { frame } of iterateSessionFrameRecords(bytes, 0)) {
    yield frame;
  }
}

/** Detect a gameId from actual capture frame content. */
export function detectGameIdFromBuffer(bytes: Buffer): GameId | null {
  const buf = decompressIfGzipSync(bytes);
  const games = getAllServerGames();
  let checked = 0;
  for (const frame of iterateGameDetectionFrames(buf)) {
    for (const game of games) {
      if (game.canHandle(frame)) return game.id;
    }
    checked++;
    if (checked >= 20) break;
  }
  return null;
}

/** Replay a canonical session capture through parser, detector, and persistence pipeline. */
export async function importSessionBin(bytes: Buffer, gameId: GameId, options: ImportSessionFramesOptions = {}): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  let buf: Buffer;
  try {
    buf = decompressIfGzipSync(bytes);
  } catch (cause) {
    throw new InvalidImportDataError("Import compression stream is corrupt", { cause });
  }
  const sourceArchiveVerification = options.sourceArchiveVerification ?? {
    state: "verified" as const,
    sourceGeneration: sha256ContentHash(bytes),
  };
  const { packetCount, laps } = await importSessionFrames(iterateSessionFrames(buf), gameId, {
    ...options,
    sourceArchiveVerification,
  });
  return { packetCount, laps };
}
