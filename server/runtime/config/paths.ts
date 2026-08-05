import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/**
 * Centralized path resolution for dev vs compiled Bun binary.
 *
 * Dev:      paths relative to the source tree (import.meta)
 * Compiled: paths relative to the exe directory (process.execPath)
 *
 * In compiled Bun binaries, import.meta.url resolves to a virtual
 * filesystem (/$bunfs on Linux, B:\~BUN\root\ on Windows) so all
 * disk reads must use the exe directory instead.
 *
 * Directory layout:
 *   SHARED_DIR  — read-only bundled static data
 *   GAMES_DIR   — read-only game catalogs
 *   PUBLIC_DIR  — client static assets
 *   USER_DATA_DIR — writable user data (db, settings, extracted tracks, recordings)
 */

const _raw = dirname(fileURLToPath(import.meta.url));
export const IS_COMPILED = _raw.startsWith("/$bunfs") || _raw.includes("~BUN");

/** Root of the project (dev) or directory containing the exe (compiled). */
export const ROOT_DIR = IS_COMPILED
  ? dirname(process.execPath)
  : resolve(_raw, "../../..");

/** shared/data in dev, data/ next to the exe in compiled. */
export const SHARED_DIR = IS_COMPILED
  ? resolve(ROOT_DIR, "data")
  : resolve(ROOT_DIR, "shared", "data");

/** shared/games in dev, data/games next to the exe in compiled. */
export const GAMES_DIR = IS_COMPILED
  ? resolve(ROOT_DIR, "data", "games")
  : resolve(ROOT_DIR, "shared", "games");

/** client/public in dev, public/ next to the exe in compiled. */
export const PUBLIC_DIR = IS_COMPILED
  ? resolve(ROOT_DIR, "public")
  : resolve(ROOT_DIR, "client", "public");

/**
 * Writable user data directory.
 * Compiled: %APPDATA%/RaceIQ (Windows) or ./data
 * Dev: ./data
 * Used for: database, settings, logs, extracted tracks, recorded outlines, curbs.
 */
export const USER_DATA_DIR = IS_COMPILED
  ? join(process.env.APPDATA ?? homedir(), "RaceIQ")
  : resolve(ROOT_DIR, "data");

/** User-generated track data (extracted, recorded, curbs). */
export const USER_TRACKS_DIR = resolve(USER_DATA_DIR, "userdata");
