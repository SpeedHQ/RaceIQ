import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));

/** True when running inside a compiled Bun binary. */
export const IS_COMPILED = sourceDir.startsWith("/$bunfs") || sourceDir.includes("~BUN");

/** Read-only bundled CSV/JSON root. */
export const SHARED_DIR = IS_COMPILED
  ? resolve(dirname(process.execPath), "data")
  : resolve(sourceDir, "..", "..", "data");

/** Read-only game catalogs. */
export const GAMES_DIR = IS_COMPILED
  ? resolve(dirname(process.execPath), "data", "games")
  : resolve(sourceDir, "..", "..", "games");

/** Writable extracted/recorded/generated track root. */
export const USER_TRACKS_DIR = IS_COMPILED
  ? join(process.env.APPDATA ?? homedir(), "RaceIQ", "userdata")
  : resolve(process.env.DATA_DIR ?? resolve(sourceDir, "..", "..", "..", "data"), "userdata");
