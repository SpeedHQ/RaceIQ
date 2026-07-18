/**
 * Shared session-bound context for the tool-using Setup Engineer agent
 * (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * Deliberately NOT part of `server/routes/tune-routes.ts` so the Mastra tools
 * (`mastra/tools/setup-engineer.ts`) can import just this — a small module —
 * instead of pulling in the whole Hono route file. Also used by tune-routes.ts
 * itself so the setup-file-guard logic has exactly one implementation.
 */
import { existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";

import type { GameId } from "../../shared/types";
import { getLapById, getLapsForTuningSession } from "../db/queries";
import { getTuningSession } from "../db/tuning-session-queries";
import { listTuningTests } from "../db/tuning-test-queries";
import { detectCorners } from "../corner-detection";
import { telemetryToSymptoms, type TuneSymptoms } from "./tune-symptoms";
import { telemetryToTrackConditions, type TrackConditions } from "./track-conditions";

// Re-exported so existing importers (the get_track_conditions tool) keep a
// single import site; the implementation lives in track-conditions.ts.
export { formatTrackConditions } from "./track-conditions";
export type { TrackConditions } from "./track-conditions";

export type AccGameId = "acc" | "ac-evo";

/** Locations where ACC / AC-EVO store user setup files under the user's profile. */
export async function getSetupsBaseDir(gameId: AccGameId): Promise<string | null> {
  const home = homedir();
  const gameDir = gameId === "acc" ? "Assetto Corsa Competizione" : "Assetto Corsa EVO";
  const candidates = [
    resolve(home, "Documents", gameDir, "Setups"),
    resolve(home, "OneDrive", "Documents", gameDir, "Setups"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export type GuardedSetup =
  | { ok: true; baseDir: string; realPath: string; setup: any }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/**
 * Resolve + guard a setup file path against the game's Setups base dir, then
 * read and parse it. Same realpath/symlink guard the /api/tunes/auto route
 * uses.
 */
export async function resolveGuardedSetupFile(
  gameId: AccGameId,
  filePath: string,
): Promise<GuardedSetup> {
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
  if (!realPath.toLowerCase().endsWith(".json")) {
    return { ok: false, status: 400, error: "Only .json setup files can be auto-tuned" };
  }

  // Read is separated from parse so a failed read isn't mislabelled as bad JSON.
  // OneDrive "online-only" (Files On-Demand) setups have metadata on disk but no
  // local content — reads fail with EUNKNOWN/EIO under Bun. Retry briefly (covers
  // a transient lock or mid-hydration), then return an actionable message.
  let raw: string | null = null;
  let readErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { raw = readFileSync(realPath, "utf-8"); readErr = null; break; }
    catch (err: any) { readErr = err; }
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

  let setup: any;
  try { setup = JSON.parse(raw); }
  catch (err: any) { return { ok: false, status: 400, error: `Invalid setup JSON: ${err.message}` }; }

  return { ok: true, baseDir, realPath, setup };
}

/** Filename stem (no directory, no .json) of a setup path — for the versioned save name. */
export function setupPathStem(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? "setup").replace(/\.json$/i, "");
}

/**
 * Deterministic symptom report for a tuning session's representative lap — the
 * fastest valid lap the session owns (plan Phase D). Loads its telemetry
 * frames, detects corners, and runs telemetryToSymptoms. Returns null when the
 * session has no analysable lap yet (legacy/empty telemetry laps still let
 * chat work, just with less symptom context).
 */
export async function computeSessionSymptoms(tuningSessionId: number): Promise<TuneSymptoms | null> {
  const lap = await loadRepresentativeLap(tuningSessionId);
  if (!lap) return null;
  const corners = detectCorners(lap.telemetry);
  return telemetryToSymptoms(lap.telemetry, corners);
}

/**
 * The session's representative lap — the fastest valid lap it owns, with enough
 * telemetry to analyse (≥30 frames). Single source of truth so symptom and
 * track-condition reads always describe the same lap. Returns null when no such
 * lap exists yet.
 */
export async function loadRepresentativeLap(
  tuningSessionId: number,
): Promise<Awaited<ReturnType<typeof getLapById>> | null> {
  const sessionLaps = await getLapsForTuningSession(tuningSessionId);
  let best: (typeof sessionLaps)[number] | null = null;
  for (const l of sessionLaps) {
    if (!l.isValid || l.lapTime <= 0) continue;
    if (best == null || l.lapTime < best.lapTime) best = l;
  }
  if (!best) return null;
  const lap = await getLapById(best.id);
  if (!lap || lap.telemetry.length < 30) return null;
  return lap;
}

/**
 * Deterministic weather / track-surface conditions for a tuning session's
 * representative lap. Reads the same fastest-valid lap as `computeSessionSymptoms`
 * so temps, rain and grip line up with the symptom report. Returns null when the
 * session has no analysable lap yet. The extraction itself lives in
 * `track-conditions.ts` so the Lap Analyst can reuse it on raw packets.
 */
export async function computeSessionTrackConditions(
  tuningSessionId: number,
): Promise<TrackConditions | null> {
  const lap = await loadRepresentativeLap(tuningSessionId);
  if (!lap) return null;
  return telemetryToTrackConditions(lap.telemetry);
}

export type ActiveTuningContext =
  | {
      ok: true;
      gameId: AccGameId;
      session: NonNullable<Awaited<ReturnType<typeof getTuningSession>>>;
      tests: Awaited<ReturnType<typeof listTuningTests>>;
      activeTest: Awaited<ReturnType<typeof listTuningTests>>[number] | null;
      baseDir: string;
      realPath: string;
      setup: any;
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/**
 * Resolve everything the Setup Engineer tools need for a session in one call:
 * the session row, its version history, the active (latest) test, and the
 * guarded/parsed active setup JSON. Single source of truth so `preview_change`
 * / `apply_changes` / `get_current_setup` can't disagree about what "active"
 * means.
 */
export async function loadActiveTuningContext(sessionId: number): Promise<ActiveTuningContext> {
  const session = await getTuningSession(sessionId);
  if (!session) return { ok: false, status: 404, error: "Tuning session not found" };

  const gameId = session.gameId as GameId;
  if (gameId !== "acc" && gameId !== "ac-evo") {
    return { ok: false, status: 400, error: "The setup engineer only supports ACC and AC-EVO" };
  }

  const tests = await listTuningTests(sessionId);
  // Head-resolved: the checked-out version the chat works from. Falls back to
  // the mainline tip when no head is set (back-compat with pre-branching sessions).
  const activeTest =
    session.headTestId != null
      ? (tests.find((t) => t.id === session.headTestId) ?? (tests.length ? tests[tests.length - 1]! : null))
      : (tests.length ? tests[tests.length - 1]! : null);
  const setupPath = activeTest?.setupPath ?? session.baseSetupPath ?? null;
  if (!setupPath) {
    return { ok: false, status: 400, error: "No base setup on this session — create it from a saved setup first." };
  }

  const guarded = await resolveGuardedSetupFile(gameId, setupPath);
  if (!guarded.ok) return { ok: false, status: guarded.status, error: guarded.error };

  return { ok: true, gameId, session, tests, activeTest, baseDir: guarded.baseDir, realPath: guarded.realPath, setup: guarded.setup };
}

/**
 * Readable markdown summary of an `apply_changes` tool call, posted as an
 * assistant message into the setup-chat thread so it persists inline in the
 * conversation (reload-safe) instead of a transient client-only card.
 * Lists each applied change as `Component: from → to`; notes when nothing
 * moved.
 */
export function buildAppliedChangesMarkdown(
  version: number,
  applied: { component: string; from: number; to: number }[],
  fileName: string,
): string {
  const header = `**Applied — v${version}**`;
  const loadLine = `Load \`${fileName}\` in-game from the setup menu.`;
  if (applied.length === 0) {
    return `${header}\n\nNo changes were needed — the setup already fits.\n\n${loadLine}`;
  }
  const lines = applied.map((c) => `- ${c.component}: ${c.from} → ${c.to}`).join("\n");
  return `${header}\n${lines}\n\n${loadLine}`;
}
