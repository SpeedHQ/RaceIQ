import { KNOWN_GAME_IDS, type GameId } from "../../shared/types";
import { getAllServerGames } from "../games/registry";
import {
  decompressIfGzipSync,
  iterateSessionFrames,
} from "./framing";
import { importSessionFrames, type ImportedLap } from "./import-pipeline";

/** Detect a gameId from an uploaded filename prefix (`<gameId>-...` / `<gameId>_...`). */
export function detectGameIdFromFilename(name: string): GameId | null {
  const sorted = [...KNOWN_GAME_IDS].sort((a, b) => b.length - a.length);
  for (const id of sorted) {
    if (name.startsWith(`${id}-`) || name.startsWith(`${id}_`)) return id;
  }
  return null;
}

/** Detect a gameId from actual capture frame content. */
export function detectGameIdFromBuffer(bytes: Buffer): GameId | null {
  const buf = decompressIfGzipSync(bytes);
  const games = getAllServerGames();
  let checked = 0;
  for (const frame of iterateSessionFrames(buf)) {
    for (const game of games) {
      if (game.canHandle(frame)) return game.id;
    }
    checked++;
    if (checked >= 20) break;
  }
  return null;
}

/** Replay a canonical session capture through parser, detector, and persistence pipeline. */
export async function importSessionBin(
  bytes: Buffer,
  gameId: GameId,
): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  const buf = decompressIfGzipSync(bytes);
  const { packetCount, laps } = await importSessionFrames(
    iterateSessionFrames(buf),
    gameId,
  );
  return { packetCount, laps };
}
