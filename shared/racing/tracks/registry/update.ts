import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

import { writeGeneratedTrackRegistry } from "../registry";
import { clearTrackRegistryProjection, compileTrackRegistryProjection, insertTrackRegistryProjection, readTrackRegistryProjection } from "./projection";
import { renderTrackRegistryReport } from "./report";
import {
  assertRemovedMetadataHasNoAssets,
  loadTrackRegistrySource,
  pruneEmptySourceDirectories,
  readFile,
  readTrackRegistrySourceFiles,
  removeIfExists,
  renderTrackRegistrySource,
  resolveTrackRegistryLocations,
  sha256OverSourceFiles,
  shardRoot,
  sourceFilePath,
  validateTrackConfigurationSource,
  writeAtomicFile,
  writeFile,
  type TrackRegistryLocations,
  type TrackRegistryLocationsInput,
  type TrackRegistrySource,
} from "./source";

interface TrackRegistryUpdateJournal {
  version: number;
  oldSourceHash: string;
  newSourceHash: string;
  sourceBackups: Record<string, string>;
  sourceStaged: Record<string, string>;
  databaseBackup: string;
  databaseStaged: string;
  reportBackup: string;
  reportStaged: string;
}

function replaceStagedFile(stagedPath: string, targetPath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(stagedPath, targetPath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (process.platform !== "win32" || !["EACCES", "EBUSY", "EPERM"].includes(String(code)) || attempt >= 4) throw error;
      Bun.gc(true);
      Bun.sleepSync(10 * 2 ** attempt);
    }
  }
}
function stageTrackRegistrySourceUpdate(
  currentSource: TrackRegistrySource,
  nextSource: TrackRegistrySource,
  resolved: TrackRegistryLocations,
  oldSourceHash: string,
  newSourceHash: string,
): TrackRegistryUpdateJournal {
  const sessionId = randomBytes(8).toString("hex");
  const renderedCurrent = renderTrackRegistrySource(currentSource);
  const renderedNext = renderTrackRegistrySource(nextSource);
  const sourceBackups: Record<string, string> = {};
  const sourceStaged: Record<string, string> = {};
  const databaseBackup = `${resolved.databasePath}.backup.${sessionId}`;
  const databaseStaged = `${resolved.databasePath}.stage.${sessionId}`;
  const reportBackup = `${resolved.reportPath}.backup.${sessionId}`;
  const reportStaged = `${resolved.reportPath}.stage.${sessionId}`;

  try {
    const filenames = new Set([...renderedCurrent.keys(), ...renderedNext.keys()]);
    for (const filename of filenames) {
      const sourcePath = sourceFilePath(resolved, filename);
      if (renderedCurrent.has(filename)) {
        const backupPath = `${sourcePath}.backup.${sessionId}`;
        writeFile(backupPath, renderedCurrent.get(filename)!);
        sourceBackups[filename] = backupPath;
      }
      if (renderedNext.has(filename)) {
        const stagedPath = `${sourcePath}.stage.${sessionId}`;
        writeFile(stagedPath, renderedNext.get(filename)!);
        sourceStaged[filename] = stagedPath;
      }
    }
    if (existsSync(resolved.databasePath)) copyFileSync(resolved.databasePath, databaseBackup);
    if (existsSync(resolved.reportPath)) copyFileSync(resolved.reportPath, reportBackup);
    const projection = compileTrackRegistryProjection(nextSource, databaseStaged);
    Bun.gc(true);
    writeFile(reportStaged, renderTrackRegistryReport(projection));
    return {
      version: 1,
      oldSourceHash,
      newSourceHash,
      sourceBackups,
      sourceStaged,
      databaseBackup,
      databaseStaged,
      reportBackup,
      reportStaged,
    };
  } catch (error) {
    for (const path of [...Object.values(sourceBackups), ...Object.values(sourceStaged)]) removeIfExists(path);
    removeIfExists(databaseBackup);
    removeIfExists(databaseStaged);
    removeIfExists(reportBackup);
    removeIfExists(reportStaged);
    throw error;
  }
}
function cleanTrackRegistryUpdateFiles(journal: TrackRegistryUpdateJournal, resolved: TrackRegistryLocations): void {
  for (const path of [...Object.values(journal.sourceStaged), ...Object.values(journal.sourceBackups)]) {
    removeIfExists(path);
  }
  removeIfExists(journal.databaseStaged);
  removeIfExists(journal.databaseBackup);
  removeIfExists(journal.reportStaged);
  removeIfExists(journal.reportBackup);
  removeIfExists(resolved.transactionPath);
  const root = shardRoot(resolved);
  for (const filename of new Set([...Object.keys(journal.sourceStaged), ...Object.keys(journal.sourceBackups)])) {
    pruneEmptySourceDirectories(sourceFilePath(resolved, filename), root);
  }
}

function actualSourceHash(locations: TrackRegistryLocations): string | null {
  try {
    return sha256OverSourceFiles(readTrackRegistrySourceFiles(locations));
  } catch {
    return null;
  }
}

function rebuildRegistryArtifacts(source: TrackRegistrySource, locations: TrackRegistryLocations): void {
  const canonical = validateTrackConfigurationSource(source);
  const sourceHash = sha256OverSourceFiles(renderTrackRegistrySource(canonical));
  if (resolve(locations.databasePath) === resolve(resolveTrackRegistryLocations().databasePath)) {
    writeGeneratedTrackRegistry((database) => {
      clearTrackRegistryProjection(database);
      insertTrackRegistryProjection(database, canonical, sourceHash);
    });
    const projection = readTrackRegistryProjection(locations.databasePath);
    writeAtomicFile(locations.reportPath, renderTrackRegistryReport(projection));
    return;
  }

  const nonce = randomBytes(8).toString("hex");
  const databaseStaged = `${locations.databasePath}.recovery.${nonce}.tmp`;
  const reportStaged = `${locations.reportPath}.recovery.${nonce}.tmp`;
  try {
    const projection = compileTrackRegistryProjection(canonical, databaseStaged);
    writeFile(reportStaged, renderTrackRegistryReport(projection));
    Bun.gc(true);
    replaceStagedFile(databaseStaged, locations.databasePath);
    replaceStagedFile(reportStaged, locations.reportPath);
  } finally {
    removeIfExists(databaseStaged);
    removeIfExists(reportStaged);
  }
}

function restoreOldRegistryUpdate(journal: TrackRegistryUpdateJournal, resolved: TrackRegistryLocations): void {
  for (const filename of Object.keys(journal.sourceStaged)) {
    if (!journal.sourceBackups[filename]) removeIfExists(sourceFilePath(resolved, filename));
  }
  for (const [filename, backup] of Object.entries(journal.sourceBackups)) {
    if (!existsSync(backup)) {
      throw new Error(`Missing track registry source backup ${backup}`);
    }
    copyFileSync(backup, sourceFilePath(resolved, filename));
  }
  const restored = loadTrackRegistrySource(resolved);
  const restoredHash = sha256OverSourceFiles(renderTrackRegistrySource(restored));
  if (restoredHash !== journal.oldSourceHash) {
    throw new Error("Track registry recovery old-source hash mismatch");
  }
  rebuildRegistryArtifacts(restored, resolved);
  cleanTrackRegistryUpdateFiles(journal, resolved);
}

/** Recover interrupted source transaction by completing committed source or restoring backup. */
export function recoverTrackRegistrySourceUpdate(locations: TrackRegistryLocationsInput = {}): void {
  const resolved = resolveTrackRegistryLocations(locations);
  if (!existsSync(resolved.transactionPath)) return;
  let journal: TrackRegistryUpdateJournal;
  try {
    journal = JSON.parse(readFile(resolved.transactionPath)) as TrackRegistryUpdateJournal;
  } catch {
    throw new Error(`Malformed track registry transaction file ${resolved.transactionPath}`);
  }
  if (journal.version !== 1) {
    throw new Error(`Unsupported track registry update transaction schema version ${journal.version}`);
  }

  if (actualSourceHash(resolved) === journal.newSourceHash) {
    const source = loadTrackRegistrySource(resolved);
    const canonicalHash = sha256OverSourceFiles(renderTrackRegistrySource(source));
    if (canonicalHash !== journal.newSourceHash) {
      throw new Error("Track registry recovery new-source hash mismatch");
    }
    rebuildRegistryArtifacts(source, resolved);
    cleanTrackRegistryUpdateFiles(journal, resolved);
    return;
  }
  restoreOldRegistryUpdate(journal, resolved);
}

/** Mutate canonical source and atomically rebuild source files, SQLite projection, and report. */
export function updateTrackRegistrySource(mutator: (draft: TrackRegistrySource) => TrackRegistrySource | void, locations: TrackRegistryLocationsInput = {}): void {
  const resolved = resolveTrackRegistryLocations(locations);
  recoverTrackRegistrySourceUpdate(resolved);
  const current = loadTrackRegistrySource(resolved);
  const currentRendered = renderTrackRegistrySource(current);
  const currentHash = sha256OverSourceFiles(currentRendered);
  const draft = structuredClone(current) as TrackRegistrySource;
  const mutated = mutator(draft) ?? draft;
  const next = validateTrackConfigurationSource(mutated);
  const nextRendered = renderTrackRegistrySource(next);
  const nextHash = sha256OverSourceFiles(nextRendered);
  const currentFiles = readTrackRegistrySourceFiles(resolved);
  const needsCanonicalRewrite = currentFiles.size !== currentRendered.size || [...currentRendered].some(([filename, contents]) => currentFiles.get(filename) !== contents);
  if (currentHash === nextHash && !needsCanonicalRewrite) return;
  assertRemovedMetadataHasNoAssets(currentRendered, nextRendered, resolved);

  const journal = stageTrackRegistrySourceUpdate(current, next, resolved, currentHash, nextHash);
  writeAtomicFile(resolved.transactionPath, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    for (const [filename, staged] of Object.entries(journal.sourceStaged)) {
      renameSync(staged, sourceFilePath(resolved, filename));
    }
    for (const filename of Object.keys(journal.sourceBackups)) {
      if (!journal.sourceStaged[filename]) removeIfExists(sourceFilePath(resolved, filename));
    }
    if (resolve(resolved.databasePath) === resolve(resolveTrackRegistryLocations().databasePath)) {
      writeGeneratedTrackRegistry((database) => {
        clearTrackRegistryProjection(database);
        insertTrackRegistryProjection(database, next, nextHash);
      });
      removeIfExists(journal.databaseStaged);
    } else {
      replaceStagedFile(journal.databaseStaged, resolved.databasePath);
    }
    replaceStagedFile(journal.reportStaged, resolved.reportPath);
    const projection = readTrackRegistryProjection(resolved.databasePath);
    if (projection.sourceHash !== nextHash) {
      throw new Error("Stale track registry projection after update");
    }
    if (readFile(resolved.reportPath) !== renderTrackRegistryReport(projection)) {
      throw new Error("Stale track registry report after update");
    }
  } catch (error) {
    restoreOldRegistryUpdate(journal, resolved);
    throw error;
  }
  cleanTrackRegistryUpdateFiles(journal, resolved);
}

/** Assert source canonicality and exact generated artifact equivalence without modifying files. */
export function assertTrackRegistryArtifactsCurrent(locations: TrackRegistryLocationsInput = {}): void {
  const resolved = resolveTrackRegistryLocations(locations);
  if (existsSync(resolved.transactionPath)) {
    throw new Error(`Pending track registry source update ${resolved.transactionPath}; run bun run tracks:registry`);
  }
  const source = loadTrackRegistrySource(resolved);
  const rendered = renderTrackRegistrySource(source);
  const actual = readTrackRegistrySourceFiles(resolved);
  if (actual.size !== rendered.size) {
    throw new Error("Non-canonical track registry source file set; run bun run tracks:registry");
  }
  for (const [filename, contents] of rendered) {
    if (actual.get(filename) !== contents) {
      throw new Error(`Non-canonical track registry source ${sourceFilePath(resolved, filename)}; run bun run tracks:registry`);
    }
  }

  const disposableDatabase = `${resolved.databasePath}.check.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const expectedProjection = compileTrackRegistryProjection(source, disposableDatabase);
    const actualProjection = readTrackRegistryProjection(resolved.databasePath);
    Bun.gc(true);
    if (JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection)) {
      throw new Error("Stale generated track registry; run bun run tracks:registry");
    }
    if (readFile(resolved.reportPath) !== renderTrackRegistryReport(expectedProjection)) {
      throw new Error("Stale track registry report; run bun run tracks:registry");
    }
  } finally {
    removeIfExists(disposableDatabase);
  }
}
