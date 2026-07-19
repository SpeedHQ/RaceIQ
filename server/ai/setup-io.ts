/**
 * Setup source/sink adapter (docs/setup-engineer-flow-design.md Phase 10).
 *
 * The Setup Engineer tools were originally ACC/AC-EVO-file-specific: "the
 * active setup" always meant a `.json` file under the game's Setups folder.
 * F1 2025 has no such file — its `F1CarSetup` only ever exists as telemetry
 * (`packet.f1.setup`) or as a JSON snapshot we captured from it. This module
 * gives `loadActiveTuningContext` and the apply/branch tools ONE interface
 * so they don't need to branch on gameId themselves:
 *
 *  - File adapter (acc / ac-evo): read = `resolveGuardedSetupFile`,
 *    write = `writeSetupFile` — unchanged existing behavior.
 *  - Snapshot adapter (f1-2025): read = the test node's `setup_snapshot`
 *    JSON column, write = store the target `F1CarSetup` back onto
 *    `tuning_tests.setup_snapshot` — no file touched.
 */
import { updateTuningTestSetupSnapshot } from "../db/tuning-test-queries";
import {
  captureF1SetupFromLaps,
  getSetupsBaseDir,
  resolveGuardedSetupFile,
  setupPathStem,
  type AccGameId,
} from "./setup-engineer-context";
import { writeSetupFile } from "./tune-writer";

export { captureF1SetupFromLaps };

/** Games the Setup Engineer / tuning workspace supports, beyond ACC/AC-EVO. */
export type TuningGameId = AccGameId | "f1-2025";

export function isTuningGameId(gameId: string): gameId is TuningGameId {
  return gameId === "acc" || gameId === "ac-evo" || gameId === "f1-2025";
}

export type SetupReadResult =
  | { ok: true; setup: any; baseDir: string | null; realPath: string | null }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export interface SetupWriteResult {
  /** File path for ACC/AC-EVO; null for F1 (no file written). */
  setupPath: string | null;
  /** F1CarSetup JSON for F1; null for ACC/AC-EVO (setup lives in the file). */
  setupSnapshot: string | null;
  /** Display name used in the applied-changes markdown / new test label. */
  fileName: string;
}

/**
 * Read the "active setup" for a test node, dispatching to the file or
 * snapshot adapter by game. `setupPath`/`setupSnapshot` come from the
 * resolved active test (or the session's base fields when no test exists
 * yet — same fallback `loadActiveTuningContext` already used for files).
 */
export async function readActiveSetup(
  gameId: TuningGameId,
  node: { setupPath: string | null; setupSnapshot?: string | null },
): Promise<SetupReadResult> {
  if (gameId === "f1-2025") {
    if (!node.setupSnapshot) {
      return {
        ok: false,
        status: 400,
        error: "No base setup captured yet — drive a lap or capture the current setup first.",
      };
    }
    try {
      return { ok: true, setup: JSON.parse(node.setupSnapshot), baseDir: null, realPath: null };
    } catch {
      return { ok: false, status: 500, error: "Stored F1 setup snapshot is corrupt JSON." };
    }
  }

  if (!node.setupPath) {
    return { ok: false, status: 400, error: "No base setup on this session — create it from a saved setup first." };
  }
  const guarded = await resolveGuardedSetupFile(gameId, node.setupPath);
  if (!guarded.ok) return guarded;
  return { ok: true, setup: guarded.setup, baseDir: guarded.baseDir, realPath: guarded.realPath };
}

/**
 * Write a new setup after `applyIntents` mutated it — dispatching to the
 * file or snapshot adapter by game. `baseDir`/`realPath` are the values
 * `readActiveSetup` returned for the SAME node (null for F1). `stem` names
 * the new file/label (e.g. the parent's stem + the new branch label).
 */
export function writeAppliedSetup(
  gameId: TuningGameId,
  params: { baseDir: string | null; realPath: string | null; setup: unknown; stem: string; overwrite?: boolean },
): SetupWriteResult {
  if (gameId === "f1-2025") {
    return { setupPath: null, setupSnapshot: JSON.stringify(params.setup), fileName: `${params.stem} (advisory)` };
  }
  if (!params.baseDir || !params.realPath) {
    throw new Error("File-based setup write requires baseDir/realPath");
  }
  const written = writeSetupFile(params.baseDir, params.realPath, params.setup, params.stem, params.overwrite ?? false);
  return { setupPath: written.path, setupSnapshot: null, fileName: written.fileName };
}

/** Filename stem to seed a new branch/apply node's save name. F1 has no file, so a plain label works. */
export function activeSetupStem(gameId: TuningGameId, realPath: string | null, fallback: string): string {
  if (gameId === "f1-2025" || !realPath) return fallback;
  return setupPathStem(realPath);
}

/**
 * Backfill a test node's `setup_snapshot` from the session's laps when it's
 * still null. No-op (and cheap) once a snapshot exists. Returns the
 * resulting snapshot JSON string, or null if nothing was found.
 */
export async function backfillF1SetupSnapshot(
  tuningSessionId: number,
  test: { id: number; setupSnapshot: string | null } | null,
): Promise<string | null> {
  if (!test) return null;
  if (test.setupSnapshot) return test.setupSnapshot;
  const captured = await captureF1SetupFromLaps(tuningSessionId);
  if (!captured) return null;
  await updateTuningTestSetupSnapshot(test.id, captured);
  return captured;
}

// Re-exported so callers that already import from setup-io don't also need
// setup-engineer-context for the ACC/AC-EVO-only setups-folder lookup.
export { getSetupsBaseDir };
