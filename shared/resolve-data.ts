import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const _raw = dirname(fileURLToPath(import.meta.url));

/** True when running inside a compiled Bun binary. */
export const IS_COMPILED = _raw.startsWith("/$bunfs") || _raw.includes("~BUN");

/**
 * shared/ in dev, data/ next to the exe in compiled.
 * Read-only bundled data (.csv, .json).
 */
export const SHARED_DIR = IS_COMPILED
  ? resolve(dirname(process.execPath), "data")
  : _raw;

/**
 * Writable user data directory for extracted/recorded/generated files.
 * Compiled: %APPDATA%/RaceIQ/userdata
 * Dev: ./data/userdata
 */
export const USER_TRACKS_DIR = IS_COMPILED
  ? join(process.env.APPDATA ?? homedir(), "RaceIQ", "userdata")
  : resolve(process.env.DATA_DIR ?? resolve(_raw, "..", "data"), "userdata");
