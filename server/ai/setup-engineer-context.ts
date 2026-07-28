/**
 * Shared session-bound context for the tool-using Setup Engineer agent
 * (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * Deliberately NOT part of `server/routes/tune-routes.ts` so the Mastra tools
 * (`mastra/tools/setup-engineer.ts`) can import just this — a small module —
 * instead of pulling in the whole Hono route file. Also used by tune-routes.ts
 * itself so the setup-file-guard logic has exactly one implementation.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";

import { tryGetServerGame } from "../games/registry";

import type { GameId } from "../../shared/types";
import { getLapById, getLapsForTuningSession } from "../db/queries";
import { getTuningSession } from "../db/tuning-session-queries";
import { listTuningTests, updateTuningTestSetupSnapshot } from "../db/tuning-test-queries";
import { detectCorners } from "../corner-detection";
import { telemetryToSymptoms, type TuneSymptoms } from "./tune-symptoms";
import { telemetryToTrackConditions, type TrackConditions } from "./track-conditions";
import { loadCleanLapAggregate } from "./clean-lap-aggregate";
import { parseCarSetup, carSetupToKnobValues } from "../games/ac-evo/carsetup";

// Re-exported so existing importers (the get_track_conditions tool) keep a
// single import site; the implementation lives in track-conditions.ts.
export { formatTrackConditions } from "./track-conditions";
export type { TrackConditions } from "./track-conditions";

// Re-exported so callers of the Phase 1 clean-lap aggregate have a single
// import site alongside the rest of the setup-engineer context helpers; the
// implementation lives in clean-lap-aggregate.ts.
export type { Confidence, ConsistencyReport, LapBreakdownRow, CleanLapAggregate } from "./clean-lap-aggregate";

export type AccGameId = "acc" | "ac-evo";

/**
 * Locations where a game stores user setup files under the user's profile.
 * Candidate dirs come from the game adapter (`getSetupsDirCandidates`), so
 * per-game paths live with the game code instead of being hardcoded here.
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
  try { setup = JSON.parse(raw); }
  catch (err: any) { return { ok: false, status: 400, error: `Invalid setup JSON: ${err.message}` }; }

  return { ok: true, baseDir, realPath, setup };
}

/** Filename stem (no directory, no .json/.carsetup) of a setup path — for the versioned save name. */
export function setupPathStem(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? "setup").replace(/\.(json|carsetup)$/i, "");
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

/**
 * Phase 1 clean-lap aggregate for a tuning session (optionally scoped to one
 * branch/test). Thin wrapper so setup-engineer callers import everything from
 * this module instead of reaching into clean-lap-aggregate.ts directly.
 */
export async function computeSessionAggregate(sessionId: number, testId?: number) {
  return loadCleanLapAggregate(sessionId, testId ? { testId } : undefined);
}

export type TuningGameId = AccGameId | "f1-2025";

/**
 * Only ACC/AC-EVO write a real setup file the user loads from the in-game
 * setup menu. F1 2025 and Forza expose no loadable setup file — applies
 * there are advisory-only diffs the user keys into the setup screen.
 */
export function gameHasSetupFile(gameId: TuningGameId): boolean {
  return gameId === "acc" || gameId === "ac-evo";
}

export type ActiveTuningContext =
  | {
      ok: true;
      gameId: TuningGameId;
      session: NonNullable<Awaited<ReturnType<typeof getTuningSession>>>;
      tests: Awaited<ReturnType<typeof listTuningTests>>;
      activeTest: Awaited<ReturnType<typeof listTuningTests>>[number] | null;
      /** File games only — null for F1 (no on-disk setup). */
      baseDir: string | null;
      /** File games only — null for F1 (no on-disk setup). */
      realPath: string | null;
      setup: any;
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/**
 * Resolve everything the Setup Engineer tools need for a session in one call:
 * the session row, its version history, the active (checked-out) test, and
 * the active setup JSON — read via the file adapter (ACC/AC-EVO) or the
 * `setup_snapshot` adapter (F1, `server/ai/setup-io.ts`). Single source of
 * truth so `preview_change` / `apply_changes` / `get_setup` can't
 * disagree about what "active" means.
 */
export async function loadActiveTuningContext(sessionId: number): Promise<ActiveTuningContext> {
  const session = await getTuningSession(sessionId);
  if (!session) return { ok: false, status: 404, error: "Tuning session not found" };

  const gameId = session.gameId as GameId;
  if (gameId !== "acc" && gameId !== "ac-evo" && gameId !== "f1-2025") {
    return { ok: false, status: 400, error: "The setup engineer only supports ACC, AC-EVO and F1 2025" };
  }

  const tests = await listTuningTests(sessionId);
  // Head-resolved: the checked-out version the chat works from. Falls back to
  // the mainline tip when no head is set (back-compat with pre-branching sessions).
  const activeTest =
    session.headTestId != null
      ? (tests.find((t) => t.id === session.headTestId) ?? (tests.length ? tests[tests.length - 1]! : null))
      : (tests.length ? tests[tests.length - 1]! : null);

  if (gameId === "f1-2025") {
    let setupSnapshot = activeTest?.setupSnapshot ?? null;
    if (!setupSnapshot && activeTest) {
      setupSnapshot = await captureF1SetupFromLaps(sessionId);
      if (setupSnapshot) await updateTuningTestSetupSnapshot(activeTest.id, setupSnapshot);
    }
    if (!setupSnapshot) {
      return {
        ok: false,
        status: 400,
        error: "No base setup captured yet — drive a lap or capture the current setup first.",
      };
    }
    let setup: any;
    try { setup = JSON.parse(setupSnapshot); }
    catch { return { ok: false, status: 500, error: "Stored F1 setup snapshot is corrupt JSON." }; }
    return { ok: true, gameId, session, tests, activeTest, baseDir: null, realPath: null, setup };
  }

  const setupPath = activeTest?.setupPath ?? session.baseSetupPath ?? null;
  if (!setupPath) {
    return { ok: false, status: 400, error: "No base setup on this session — create it from a saved setup first." };
  }
  const guarded = await resolveGuardedSetupFile(gameId, setupPath);
  if (!guarded.ok) return { ok: false, status: guarded.status, error: guarded.error };
  return { ok: true, gameId, session, tests, activeTest, baseDir: guarded.baseDir, realPath: guarded.realPath, setup: guarded.setup };
}

/**
 * Scan an F1 tuning session's laps (newest first) for the first one whose
 * telemetry carries `f1?.setup`, returning it as a JSON string ready for
 * `setup_snapshot`. Used both to backfill a node's snapshot lazily (above)
 * and by the live "capture current setup" route. There is no server-side
 * live-packet bus outside per-connection lap-detector state, so "current"
 * pragmatically means the most recently completed lap's setup.
 */
export async function captureF1SetupFromLaps(tuningSessionId: number): Promise<string | null> {
  const sessionLaps = await getLapsForTuningSession(tuningSessionId); // newest first
  for (const meta of sessionLaps) {
    const lap = await getLapById(meta.id);
    if (!lap) continue;
    for (const p of lap.telemetry) {
      const s = (p as any).f1?.setup;
      if (s && typeof s === "object") return JSON.stringify(s);
    }
  }
  return null;
}

/**
 * Readable markdown summary of an `apply_changes` tool call, posted as an
 * assistant message into the setup-chat thread so it persists inline in the
 * conversation (reload-safe) instead of a transient client-only card.
 * Lists each applied change as `Component: from → to`; notes when nothing
 * moved.
 */
export function buildAppliedChangesMarkdown(
  /** Display label (e.g. "v1.4") — matches the version tree, NOT the raw
   *  storage version number. */
  label: string,
  applied: { component: string; from: number; to: number }[],
  fileName: string,
  /** F1 has no setup file to load — omit the "load in-game" line and post
   *  an advisory-only diff (design "Apply output" section). */
  hasFile: boolean = true,
  /** One-line goal of the change ("faster straight speed") — shown under the header. */
  goal?: string | null,
): string {
  const header = goal ? `**Applied — ${label}** — _${goal}_` : `**Applied — ${label}**`;
  const loadLine = hasFile ? `Load \`${fileName}\` in-game from the setup menu.` : `Advisory only — apply these values in the in-game setup screen.`;
  if (applied.length === 0) {
    return `${header}\n\nNo changes were needed — the setup already fits.\n\n${loadLine}`;
  }
  const lines = applied.map((c) => `- ${c.component}: ${c.from} → ${c.to}`).join("\n");
  return `${header}\n${lines}\n\n${loadLine}`;
}
