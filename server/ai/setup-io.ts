/**
 * Setup source/sink adapter (docs/architecture/setup-engineer.md).
 *
 * The Setup Engineer tools were originally ACC/AC-EVO-file-specific: "the
 * active setup" always meant a `.json` file under the game's Setups folder.
 * F1 2025 has no such file — its `F1CarSetup` only ever exists as telemetry
 * (`packet.f1.setup`) or as a JSON snapshot we captured from it. This module
 * gives `loadActiveExperimentContext` and the apply/branch tools ONE interface
 * so they don't need to branch on gameId themselves:
 *
 *  - File adapter (acc / ac-evo): read = `resolveGuardedSetupFile`,
 *    write = `writeSetupFile` — unchanged existing behavior.
 *  - Snapshot adapter (f1-2025): read = the test node's `setup_snapshot`
 *    JSON column, write = store the target `F1CarSetup` back onto
 *    `experiment_versions.setup_snapshot` — no file touched.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, resolve, sep } from "path";
import { updateExperimentVersionSetupSnapshot } from "../db/experiment-version-queries";
import { carSetupToKnobValues, parseCarSetup } from "../games/ac-evo/carsetup";
import { patchCarSetup } from "../games/ac-evo/carsetup-writer";
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
export type ExperimentGameId = AccGameId | "f1-2025";

export function isExperimentGameId(gameId: string): gameId is ExperimentGameId {
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
 * yet — same fallback `loadActiveExperimentContext` already used for files).
 */
export async function readActiveSetup(
  gameId: ExperimentGameId,
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

  // Advisory nodes for file games (e.g. a .carsetup branch whose patch write
  // failed verification, see writeAppliedSetup below) carry no setupPath —
  // their setup only lives in setupSnapshot. Read that back the same way F1
  // does so further branches off an advisory node stay readable.
  if (!node.setupPath && node.setupSnapshot) {
    try {
      return { ok: true, setup: JSON.parse(node.setupSnapshot), baseDir: null, realPath: null };
    } catch {
      return { ok: false, status: 500, error: "Stored setup snapshot is corrupt JSON." };
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
  gameId: ExperimentGameId,
  params: { baseDir: string | null; realPath: string | null; setup: unknown; stem: string; overwrite?: boolean },
): SetupWriteResult {
  if (gameId === "f1-2025") {
    return { setupPath: null, setupSnapshot: JSON.stringify(params.setup), fileName: `${params.stem} (advisory)` };
  }
  // A node with no realPath (e.g. an earlier .carsetup write that fell back
  // to advisory below) has no file to branch from — stay advisory.
  if (!params.baseDir || !params.realPath) {
    return { setupPath: null, setupSnapshot: JSON.stringify(params.setup), fileName: `${params.stem} (advisory)` };
  }
  if (params.realPath.toLowerCase().endsWith(".carsetup")) {
    return writeAppliedCarSetup(params.baseDir, params.realPath, params.setup, params.stem, params.overwrite ?? false);
  }
  const written = writeSetupFile(params.baseDir, params.realPath, params.setup, params.stem, params.overwrite ?? false);
  return { setupPath: written.path, setupSnapshot: null, fileName: written.fileName };
}

/**
 * Byte-patch a binary AC EVO `.carsetup` base with the knobs `applyIntents`
 * changed, writing a NEW sibling file (never overwriting the original —
 * same naming approach as `writeSetupFile`). `setup` is the flat knob-value
 * object (from `carSetupToKnobValues`, mutated by `applyIntents`'s
 * "ac-evo" rule table) that `readActiveSetup`/`resolveGuardedSetupFile`
 * handed the caller for this base.
 *
 * If the patch's mandatory read-back verification fails (a wrong
 * field-number guess, or a knob whose file field can't be located), this
 * degrades to an advisory snapshot branch — same shape F1 2025 uses — so the
 * version node is still created instead of losing the driver's changes.
 */
function writeAppliedCarSetup(
  baseDir: string,
  realPath: string,
  setup: unknown,
  stem: string,
  overwrite: boolean,
): SetupWriteResult {
  const advisory = (): SetupWriteResult => ({
    setupPath: null,
    setupSnapshot: JSON.stringify(setup),
    fileName: `${stem} (advisory)`,
  });

  try {
    const originalBuf = readFileSync(realPath);
    const originalParsed = parseCarSetup(originalBuf);
    if (!originalParsed) return advisory();
    const originalKnobs = carSetupToKnobValues(originalParsed);
    const nextKnobs = setup as Record<string, number>;

    const edits = Object.entries(nextKnobs)
      .filter(([knob, value]) => typeof value === "number" && Number.isFinite(value) && originalKnobs[knob] !== value)
      .map(([knob, value]) => ({ knob, value }));

    if (edits.length === 0) {
      // Nothing patchable changed (e.g. the applied change touched a
      // decode-only knob with no writer mapping) — still write a copy of the
      // original bytes as the new branch's file so the driver has something
      // to load in-game.
      const written = writeBinarySetupFile(baseDir, realPath, originalBuf, stem, overwrite);
      return { setupPath: written.path, setupSnapshot: null, fileName: written.fileName };
    }

    const patched = patchCarSetup(originalBuf, edits);
    const written = writeBinarySetupFile(baseDir, realPath, patched, stem, overwrite);
    return { setupPath: written.path, setupSnapshot: null, fileName: written.fileName };
  } catch {
    // Verification failure, unwritable knob, or any read/patch error — the
    // design's safety rail: never write a save the game might reject or
    // silently corrupt. Degrade to advisory instead of losing the changes.
    return advisory();
  }
}

interface WriteBinaryResult {
  path: string;
  fileName: string;
}

/**
 * Write `data` as a sibling `.carsetup` of `sourcePath`, named from `stem`
 * (auto-incrementing on collision, same scheme as `writeSetupFile`). Never
 * overwrites the original file. `baseDir` is the setups root the destination
 * must stay inside.
 */
function writeBinarySetupFile(baseDir: string, sourcePath: string, data: Buffer, stem: string, overwrite: boolean): WriteBinaryResult {
  const absSource = resolve(sourcePath);
  const dir = dirname(absSource);

  const realBase = realpathSync(resolve(baseDir));
  const realDir = existsSync(dir) ? realpathSync(dir) : dir;
  if (!(realDir + sep).startsWith(realBase + sep) && realDir !== realBase) {
    throw new Error("Destination is outside the Setups folder");
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const cleanStem = sanitizeStem(stem);
  let dest = resolve(dir, `${cleanStem}.carsetup`);
  if (!overwrite) {
    let n = 2;
    while (existsSync(dest)) {
      dest = resolve(dir, `${cleanStem}-${n}.carsetup`);
      n++;
    }
  }

  writeFileSync(dest, data);
  return { path: dest, fileName: dest.split(/[\\/]/).pop() ?? "" };
}

function sanitizeStem(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/\.carsetup$/i, "");
  const cleaned = base.replace(/[^a-zA-Z0-9 _.-]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "setup-engineer";
}

/** Filename stem to seed a new branch/apply node's save name. F1 has no file, so a plain label works. */
export function activeSetupStem(gameId: ExperimentGameId, realPath: string | null, fallback: string): string {
  if (gameId === "f1-2025" || !realPath) return fallback;
  return setupPathStem(realPath);
}

/**
 * Backfill a test node's `setup_snapshot` from the session's laps when it's
 * still null. No-op (and cheap) once a snapshot exists. Returns the
 * resulting snapshot JSON string, or null if nothing was found.
 */
export async function backfillF1SetupSnapshot(
  experimentId: number,
  test: { id: number; setupSnapshot: string | null } | null,
): Promise<string | null> {
  if (!test) return null;
  if (test.setupSnapshot) return test.setupSnapshot;
  const captured = await captureF1SetupFromLaps(experimentId);
  if (!captured) return null;
  await updateExperimentVersionSetupSnapshot(test.id, captured);
  return captured;
}

// Re-exported so callers that already import from setup-io don't also need
// setup-engineer-context for the ACC/AC-EVO-only setups-folder lookup.
export { getSetupsBaseDir };
