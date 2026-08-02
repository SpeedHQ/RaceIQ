/** Setup source/sink adapter for file-backed and snapshot-backed games. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, resolve, sep } from "path";

import { updateExperimentVersionSetupSnapshot } from "../db/experiment-version-queries";
import { carSetupToKnobValues } from "../games/ac-evo/carsetup";
import { parseCarSetup } from "../games/ac-evo/carsetup-wire";
import { patchCarSetup } from "../games/ac-evo/carsetup-writer";
import {
  captureF1SetupFromLaps,
  type ExperimentGameId,
} from "../experiments/setup-lineage";
import { resolveGuardedSetupFile, setupPathStem } from "./file-guard";
import { writeSetupFile } from "../ai/tune-writer";


export type SetupReadResult =
  | { ok: true; setup: any; baseDir: string | null; realPath: string | null }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export interface SetupWriteResult {
  /** File path for ACC/AC-EVO; null for F1 (no file written). */
  setupPath: string | null;
  /** F1CarSetup JSON for F1; null for ACC/AC-EVO. */
  setupSnapshot: string | null;
  /** Display name used in applied-changes markdown / new test label. */
  fileName: string;
}

/** Read active setup, dispatching to file or snapshot adapter by game. */
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

  // Advisory nodes for file games carry no setupPath; read their snapshot so
  // subsequent branches remain usable.
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

/** Write newly applied setup through file or snapshot adapter. */
export function writeAppliedSetup(
  gameId: ExperimentGameId,
  params: {
    baseDir: string | null;
    realPath: string | null;
    setup: unknown;
    stem: string;
    overwrite?: boolean;
  },
): SetupWriteResult {
  if (gameId === "f1-2025") {
    return {
      setupPath: null,
      setupSnapshot: JSON.stringify(params.setup),
      fileName: `${params.stem} (advisory)`,
    };
  }
  if (!params.baseDir || !params.realPath) {
    return {
      setupPath: null,
      setupSnapshot: JSON.stringify(params.setup),
      fileName: `${params.stem} (advisory)`,
    };
  }
  if (params.realPath.toLowerCase().endsWith(".carsetup")) {
    return writeAppliedCarSetup(
      params.baseDir,
      params.realPath,
      params.setup,
      params.stem,
      params.overwrite ?? false,
    );
  }
  const written = writeSetupFile(
    params.baseDir,
    params.realPath,
    params.setup,
    params.stem,
    params.overwrite ?? false,
  );
  return { setupPath: written.path, setupSnapshot: null, fileName: written.fileName };
}

/** Byte-patch a binary AC EVO setup; degrade to safe advisory snapshot on failure. */
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
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .filter(([knob, value]) => originalKnobs[knob] !== value)
      .map(([knob, value]) => ({ knob, value }));

    if (edits.length === 0) {
      const written = writeBinarySetupFile(baseDir, realPath, originalBuf, stem, overwrite);
      return { setupPath: written.path, setupSnapshot: null, fileName: written.fileName };
    }

    const patched = patchCarSetup(originalBuf, edits);
    const written = writeBinarySetupFile(baseDir, realPath, patched, stem, overwrite);
    return { setupPath: written.path, setupSnapshot: null, fileName: written.fileName };
  } catch {
    return advisory();
  }
}

interface WriteBinaryResult {
  path: string;
  fileName: string;
}

/** Write binary setup sibling inside guarded setup root. */
function writeBinarySetupFile(
  baseDir: string,
  sourcePath: string,
  data: Buffer,
  stem: string,
  overwrite: boolean,
): WriteBinaryResult {
  const absSource = resolve(sourcePath);
  const dir = dirname(absSource);
  const realBase = realpathSync(resolve(baseDir));
  const realDir = existsSync(dir) ? realpathSync(dir) : dir;
  if (!(realDir + sep).startsWith(realBase + sep) && realDir !== realBase) {
    throw new Error("Destination is outside the Setups folder");
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const base = (stem.split(/[\\/]/).pop() ?? "").replace(/\.carsetup$/i, "");
  const cleanStem = base.replace(/[^a-zA-Z0-9 _.-]/g, "").trim() || "setup-engineer";
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

/** Filename stem for a new branch/apply node save name. */
export function activeSetupStem(
  gameId: ExperimentGameId,
  realPath: string | null,
  fallback: string,
): string {
  if (gameId === "f1-2025" || !realPath) return fallback;
  return setupPathStem(realPath);
}

/** Backfill a test node's F1 setup snapshot from newest session laps. */
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
