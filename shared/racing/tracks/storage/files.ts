import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { GameIdSchema } from "@shared/games/ids";
import { USER_TRACKS_DIR } from "@shared/platform/runtime/data-paths";

export const userDir = USER_TRACKS_DIR;

export function validateGameId(gameId: string): string {
  return GameIdSchema.parse(gameId);
}

export function userGameDir(gameId: string): string {
  const dir = resolve(userDir, gameId);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }
  return dir;
}

export function readDataFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function listDataFiles(dir: string, filter: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir).filter(filter).map((file) => resolve(dir, file));
  } catch {
    return [];
  }
}
