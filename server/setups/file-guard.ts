/**
 * Setup file path guard and parse helper for ACC/AC-EVO/.carsetup setup files.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";

import { tryGetServerGame } from "../games/registry";
import { carSetupToKnobValues } from "../games/ac-evo/carsetup";
import { parseCarSetup } from "../games/ac-evo/carsetup-wire";

export type AccGameId = "acc" | "ac-evo";

/** Whether a resolved path is inside a resolved setup root. */
export function isPathWithinSetupsFolder(
  candidatePath: string,
  basePath: string,
  allowBase = false,
): boolean {
  return candidatePath.startsWith(basePath + sep)
    || (allowBase && candidatePath === basePath);
}

/** Sanitize a requested sibling setup filename stem. */
export function sanitizeSetupStem(filePath: string): string {
  const base = (filePath.split(/[\\/]/).pop() ?? "").replace(/\.carsetup$/i, "");
  return base.replace(/[^a-zA-Z0-9 _.-]/g, "").trim() || "setup-engineer";
}

function errorDetails(error: unknown): { code?: string; message?: string } {
  if (error == null || typeof error !== "object") return {};
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
  return { code, message };
}

/**
 * Locations where a game stores user setup files under the user's profile.
 * Candidate dirs come from the game adapter (`getSetupsDirCandidates`), so
 * per-game paths live with game code instead of being hardcoded here.
 *
 * Read-only by default: returns null when no candidate exists so callers can
 * render the "couldn't find your Setups folder" empty state. It must NOT
 * conjure a folder in the home dir of someone who doesn't even own the game —
 * only write paths (which need somewhere to put the file) pass `create: true`.
 */
export async function getSetupsBaseDir(
  gameId: AccGameId,
  opts: { create?: boolean } = {},
): Promise<string | null> {
  const home = homedir();
  const candidates = tryGetServerGame(gameId)?.getSetupsDirCandidates?.(home) ?? [];
  if (candidates.length === 0) return null;

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  if (!opts.create) return null;

  const primary = candidates[0];
  try {
    mkdirSync(primary, { recursive: true });
    console.log(`[setup-engineer] Setups folder not found, created: ${primary}`);
    return primary;
  } catch {
    return null;
  }
}

export type GuardedSetup =
  | {
      ok: true;
      baseDir: string;
      realPath: string;
      setup: any;
      /** True when source is binary `.carsetup`; `setup` contains decoded knob values. */
      readOnly?: true;
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/**
 * Resolve + guard a setup file path against the game's Setups base dir, then
 * read and parse it. Same realpath/symlink guard the /api/tunes/auto route
 * uses.
 */
export async function resolveGuardedSetupFile(gameId: AccGameId, filePath: string): Promise<GuardedSetup> {
  const baseDir = await getSetupsBaseDir(gameId);
  if (!baseDir) return { ok: false, status: 404, error: "Setups folder not found" };

  const absPath = resolve(filePath);
  if (!existsSync(absPath)) return { ok: false, status: 404, error: "Setup file not found" };

  let realPath: string;
  let realBase: string;
  try {
    realPath = realpathSync(absPath);
    realBase = realpathSync(resolve(baseDir));
  } catch (err: unknown) {
    const { code, message } = errorDetails(err);
    if (code === "ENOENT") return { ok: false, status: 404, error: "Setup file not found" };
    return { ok: false, status: 500, error: `Read failed: ${message}` };
  }

  if (!isPathWithinSetupsFolder(realPath, realBase)) {
    return { ok: false, status: 400, error: "Path must be inside the Setups folder" };
  }

  const lowerPath = realPath.toLowerCase();
  const isCarsetup = lowerPath.endsWith(".carsetup");
  if (!lowerPath.endsWith(".json") && !isCarsetup) {
    return { ok: false, status: 400, error: "Only .json or .carsetup setup files are supported" };
  }

  // Read is separated from parse so a failed read isn't mislabelled as invalid
  // setup content. OneDrive online-only reads fail with EUNKNOWN/EIO under Bun;
  // retry briefly for transient locks or mid-hydration.
  let raw: Buffer | null = null;
  let readErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = readFileSync(realPath);
      readErr = null;
      break;
    } catch (err: unknown) {
      readErr = err;
    }
  }

  if (raw == null) {
    const { code, message } = errorDetails(readErr);
    if (code === "EUNKNOWN" || code === "EIO" || code === "EACCES" || code === "EBUSY") {
      return {
        ok: false,
        status: 409,
        error:
          "Couldn't read the setup file — it's a OneDrive online-only file and OneDrive isn't " +
          "providing its contents (the cloud file provider may not be running). Make sure OneDrive " +
          "is running, or right-click the file in Explorer → \"Always keep on this device\", then try again.",
      };
    }
    return { ok: false, status: 500, error: `Couldn't read setup file: ${message ?? "unknown error"}` };
  }

  // AC EVO `.carsetup` files are binary protobuf. Decode the bytes already
  // read by the guarded/retried path rather than reopening the file.
  if (isCarsetup) {
    let setup: Record<string, number> | null = null;
    try {
      const parsed = parseCarSetup(raw);
      if (parsed) setup = carSetupToKnobValues(parsed);
    } catch {
      // Decode failure must not break session load — fall back to setup: null.
    }
    return { ok: true, baseDir, realPath, setup, readOnly: true };
  }

  let setup: any;
  try {
    setup = JSON.parse(raw.toString("utf-8"));
  } catch (err: unknown) {
    return { ok: false, status: 400, error: `Invalid setup JSON: ${errorDetails(err).message}` };
  }

  return { ok: true, baseDir, realPath, setup };
}

