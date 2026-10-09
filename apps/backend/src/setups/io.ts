import { createHash } from "node:crypto";
/** Setup source/sink adapter for file-backed and snapshot-backed games. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { writeSetupFile } from "@raceiq/backend-core/ai/tune-writer";
import { carSetupToKnobValues } from "@raceiq/game-ac-evo/carsetup";
import { parseCarSetup } from "@raceiq/game-ac-evo/carsetup-wire";
import { patchCarSetup } from "@raceiq/game-ac-evo/carsetup-writer";
import type { ExperimentGameId } from "../experiments/setup-lineage";
import { getSvmFieldAccess } from "@raceiq/game-lmu-metadata/setups/capabilities";
import type { SvmDocument, SvmEdit } from "@raceiq/game-lmu-metadata/setups/svm";
import { getSvmFieldDescriptor } from "@raceiq/game-lmu-metadata/setups/fields";
import { saveLMUSetup } from "./lmu";
import { isPathWithinSetupsFolder, sanitizeSetupStem, resolveGuardedSetupFile } from "./file-guard";

export type SetupReadResult =
  | { ok: true; setup: any; baseDir: string | null; realPath: string | null }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export interface SetupWriteResult {
  /** Relative LMU Settings path, absolute ACC/AC-EVO path, or null for F1. */
  setupPath: string | null;
  /** Snapshot JSON for advisory/F1 setups; null for real setup files. */
  setupSnapshot: string | null;
  /** Display name used in applied-changes markdown / new version label. */
  fileName: string;
}

function advisorySetup(setup: unknown, stem: string): SetupWriteResult {
  return {
    setupPath: null,
    setupSnapshot: JSON.stringify(setup),
    fileName: `${stem} (advisory)`,
  };
}

function readSetupSnapshot(snapshot: string, corruptError: string): SetupReadResult {
  try {
    return { ok: true, setup: JSON.parse(snapshot), baseDir: null, realPath: null };
  } catch {
    return { ok: false, status: 500, error: corruptError };
  }
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
    return readSetupSnapshot(node.setupSnapshot, "Stored F1 setup snapshot is corrupt JSON.");
  }

  // Advisory nodes for file games carry no setupPath; read their snapshot so
  // subsequent branches remain usable.
  if (!node.setupPath && node.setupSnapshot) {
    return readSetupSnapshot(node.setupSnapshot, "Stored setup snapshot is corrupt JSON.");
  }

  if (!node.setupPath) {
    return { ok: false, status: 400, error: "No base setup on this session — create it from a saved setup first." };
  }
  const guarded = await resolveGuardedSetupFile(gameId, node.setupPath);
  if (!guarded.ok) return guarded;
  return { ok: true, setup: guarded.setup, baseDir: guarded.baseDir, realPath: guarded.realPath };
}

/** Write newly applied setup through file or snapshot adapter. */
export async function writeAppliedSetup(
  gameId: ExperimentGameId,
  params: {
    baseDir: string | null;
    realPath: string | null;
    setup: unknown;
    sourceSetup?: unknown;
    stem: string;
    overwrite?: boolean;
  },
): Promise<SetupWriteResult> {
  if (gameId === "f1-2025") return advisorySetup(params.setup, params.stem);
  if (gameId === "lmu") {
    if (!params.realPath || !isSvmDocument(params.setup) || !isSvmDocument(params.sourceSetup)) {
      throw new Error("LMU setup context is invalid");
    }
    return writeAppliedLMUSetup(params.realPath, params.sourceSetup, params.setup, params.stem);
  }
  if (!params.baseDir || !params.realPath) return advisorySetup(params.setup, params.stem);
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

function isSvmDocument(value: unknown): value is SvmDocument {
  return typeof value === "object" && value !== null
    && "originalBytes" in value && value.originalBytes instanceof Uint8Array
    && "settings" in value && value.settings instanceof Map;
}

async function writeAppliedLMUSetup(sourcePath: string, source: SvmDocument, setup: SvmDocument, stem: string): Promise<SetupWriteResult> {
  const edits: SvmEdit[] = [];
  for (const [id, setting] of setup.settings) {
    const sourceSetting = source.settings.get(id);
    if (!sourceSetting || sourceSetting.index === setting.index || !getSvmFieldAccess(source, id).editable) continue;
    if (!getSvmFieldDescriptor(id)) continue;
    edits.push({ id, delta: setting.index - sourceSetting.index });
  }
  if (edits.length === 0) throw new Error("No editable LMU setup changes to save");
  const result = await saveLMUSetup({
    source: { kind: "file", path: sourcePath, sha256: createHash("sha256").update(source.originalBytes).digest("hex") },
    fileName: `${sanitizeSetupStem(stem)}.svm`,
    edits,
  });
  if (!result.ok) throw new Error(result.error);
  return { setupPath: result.value.path, setupSnapshot: null, fileName: result.value.fileName };
}
/** Byte-patch a binary AC EVO setup; degrade to safe advisory snapshot on failure. */
function writeAppliedCarSetup(
  baseDir: string,
  realPath: string,
  setup: unknown,
  stem: string,
  overwrite: boolean,
): SetupWriteResult {
  try {
    const originalBuf = readFileSync(realPath);
    const originalParsed = parseCarSetup(originalBuf);
    if (!originalParsed) return advisorySetup(setup, stem);
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
    return advisorySetup(setup, stem);
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
  const dir = dirname(resolve(sourcePath));
  const realBase = realpathSync(resolve(baseDir));
  const realDir = existsSync(dir) ? realpathSync(dir) : dir;
  if (!isPathWithinSetupsFolder(realDir, realBase, true)) {
    throw new Error("Destination is outside the Setups folder");
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const cleanStem = sanitizeSetupStem(stem);
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

