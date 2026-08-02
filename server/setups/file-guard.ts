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
      /** True when the source is a binary `.carsetup` — knob values are
       *  readable (decoded) but the file can never be written back. */
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
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, status: 404, error: "Setup file not found" };
    return { ok: false, status: 500, error: `Read failed: ${err.message}` };
  }

  if (!(realPath + sep).startsWith(realBase + sep)) {
    return { ok: false, status: 400, error: "Path must be inside the Setups folder" };
  }

  const isCarsetup = realPath.toLowerCase().endsWith(".carsetup");
  if (!realPath.toLowerCase().endsWith(".json") && !isCarsetup) {
    return { ok: false, status: 400, error: "Only .json or .carsetup setup files are supported" };
  }

  // Read is separated from parse so a failed read isn't mislabelled as bad JSON.
  // OneDrive "online-only" (Files On-Demand) setups have metadata on disk but no
  // local content — reads fail with EUNKNOWN/EIO under Bun. Retry briefly (covers
  // a transient lock or mid-hydration), then return an actionable message.
  let raw: string | null = null;
  let readErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = readFileSync(realPath, "utf-8");
      readErr = null;
      break;
    } catch (err: any) {
      readErr = err;
    }
  }

  if (raw == null) {
    const code = readErr?.code;
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
    return { ok: false, status: 500, error: `Couldn't read setup file: ${readErr?.message ?? "unknown error"}` };
  }

  // .carsetup (AC EVO Saved Games\ACE format) is binary protobuf — decode it
  // so the tuning model sees real knob values (advisory only: there's no
  // encoder, so these sessions can never write a setup back — readOnly).
  if (isCarsetup) {
    let setup: Record<string, number> | null = null;
    try {
      const parsed = parseCarSetup(readFileSync(realPath));
      if (parsed) setup = carSetupToKnobValues(parsed);
    } catch {
      // Decode failure must not break session load — fall back to setup: null.
    }
    return { ok: true, baseDir, realPath, setup, readOnly: true };
  }

  let setup: any;
  try {
    setup = JSON.parse(raw);
  } catch (err: any) {
    return { ok: false, status: 400, error: `Invalid setup JSON: ${err.message}` };
  }

  return { ok: true, baseDir, realPath, setup };
}

/** Filename stem (no directory, no .json/.carsetup) of a setup path — for the versioned save name. */
export function setupPathStem(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? "setup").replace(/\.(json|carsetup)$/i, "");
}
