import { randomBytes } from "node:crypto";
import { existsSync, renameSync } from "node:fs";

import { invalidateTrackRegistry } from "../registry";
import {
  compileTrackRegistryReadModel,
  readTrackRegistryReadModel,
  renderTrackRegistryReadModel,
} from "./read-model";
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
  version: 2;
  oldSourceHash: string;
  newSourceHash: string;
  sourceBackups: Record<string, string>;
  sourceStaged: Record<string, string>;
  registryStaged: string;
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
  const registryStaged = `${resolved.registryPath}.stage.${sessionId}`;
  const reportStaged = `${resolved.reportPath}.stage.${sessionId}`;

  try {
    const filenames = new Set([...renderedCurrent.keys(), ...renderedNext.keys()]);
    for (const filename of filenames) {
      if (renderedCurrent.get(filename) === renderedNext.get(filename)) continue;
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
    const registry = compileTrackRegistryReadModel(nextSource);
    if (registry.sourceHash !== newSourceHash) throw new Error("Track registry staged source hash mismatch");
    writeFile(registryStaged, renderTrackRegistryReadModel(registry));
    writeFile(reportStaged, renderTrackRegistryReport(registry));
    return {
      version: 2,
      oldSourceHash,
      newSourceHash,
      sourceBackups,
      sourceStaged,
      registryStaged,
      reportStaged,
    };
  } catch (error) {
    for (const path of [...Object.values(sourceBackups), ...Object.values(sourceStaged)]) removeIfExists(path);
    removeIfExists(registryStaged);
    removeIfExists(reportStaged);
    throw error;
  }
}

function cleanTrackRegistryUpdateFiles(journal: TrackRegistryUpdateJournal, resolved: TrackRegistryLocations): void {
  for (const path of [...Object.values(journal.sourceStaged), ...Object.values(journal.sourceBackups)]) removeIfExists(path);
  removeIfExists(journal.registryStaged);
  removeIfExists(journal.reportStaged);
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
  const registry = compileTrackRegistryReadModel(validateTrackConfigurationSource(source));
  const nonce = randomBytes(8).toString("hex");
  const registryStaged = `${locations.registryPath}.recovery.${nonce}.tmp`;
  const reportStaged = `${locations.reportPath}.recovery.${nonce}.tmp`;
  try {
    writeFile(registryStaged, renderTrackRegistryReadModel(registry));
    writeFile(reportStaged, renderTrackRegistryReport(registry));
    replaceStagedFile(registryStaged, locations.registryPath);
    replaceStagedFile(reportStaged, locations.reportPath);
    invalidateTrackRegistry();
  } finally {
    removeIfExists(registryStaged);
    removeIfExists(reportStaged);
  }
}

function restoreOldRegistryUpdate(journal: TrackRegistryUpdateJournal, resolved: TrackRegistryLocations): void {
  for (const filename of Object.keys(journal.sourceStaged)) {
    if (!journal.sourceBackups[filename]) removeIfExists(sourceFilePath(resolved, filename));
  }
  for (const [filename, backup] of Object.entries(journal.sourceBackups)) {
    if (!existsSync(backup)) throw new Error(`Missing track registry source backup ${backup}`);
    writeFile(sourceFilePath(resolved, filename), readFile(backup));
  }
  const restored = loadTrackRegistrySource(resolved);
  const restoredHash = sha256OverSourceFiles(renderTrackRegistrySource(restored));
  if (restoredHash !== journal.oldSourceHash) throw new Error("Track registry recovery old-source hash mismatch");
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
  if (journal.version !== 2) throw new Error(`Unsupported track registry update transaction schema version ${journal.version}`);

  if (actualSourceHash(resolved) === journal.newSourceHash) {
    const source = loadTrackRegistrySource(resolved);
    const canonicalHash = sha256OverSourceFiles(renderTrackRegistrySource(source));
    if (canonicalHash !== journal.newSourceHash) throw new Error("Track registry recovery new-source hash mismatch");
    rebuildRegistryArtifacts(source, resolved);
    cleanTrackRegistryUpdateFiles(journal, resolved);
    return;
  }
  restoreOldRegistryUpdate(journal, resolved);
}

/** Mutate canonical source and atomically rebuild source files, JSON read model, and report. */
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
    for (const [filename, staged] of Object.entries(journal.sourceStaged)) replaceStagedFile(staged, sourceFilePath(resolved, filename));
    for (const filename of Object.keys(journal.sourceBackups)) {
      if (!journal.sourceStaged[filename]) removeIfExists(sourceFilePath(resolved, filename));
    }
    replaceStagedFile(journal.registryStaged, resolved.registryPath);
    replaceStagedFile(journal.reportStaged, resolved.reportPath);
    invalidateTrackRegistry();
    const registry = readTrackRegistryReadModel(resolved.registryPath);
    if (registry.sourceHash !== nextHash) throw new Error("Stale track registry read model after update");
    if (readFile(resolved.reportPath) !== renderTrackRegistryReport(registry)) throw new Error("Stale track registry report after update");
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
  if (actual.size !== rendered.size) throw new Error("Non-canonical track registry source file set; run bun run tracks:registry");
  for (const [filename, contents] of rendered) {
    if (actual.get(filename) !== contents) throw new Error(`Non-canonical track registry source ${sourceFilePath(resolved, filename)}; run bun run tracks:registry`);
  }

  const expectedRegistry = compileTrackRegistryReadModel(source);
  const actualRegistry = readTrackRegistryReadModel(resolved.registryPath);
  if (
    renderTrackRegistryReadModel(actualRegistry) !== renderTrackRegistryReadModel(expectedRegistry) ||
    readFile(resolved.registryPath) !== renderTrackRegistryReadModel(expectedRegistry)
  ) {
    throw new Error("Stale generated track registry; run bun run tracks:registry");
  }
  if (readFile(resolved.reportPath) !== renderTrackRegistryReport(expectedRegistry)) {
    throw new Error("Stale track registry report; run bun run tracks:registry");
  }
}
