import { persistRecordingJournal, readValidatedRecordingJournal, validateRelocationJournal, cleanupVerifiedRecordingSources, cleanupOwnedRecordingTemporary, verifyRecordingDestinations, cleanupOwnedRecordingDestination, removeEmptyRecordingDirectoryTree } from "@raceiq/recording-storage/operations";
import { hashRecordingFile, isRecordingPathContained as isContained, hasRecordingSymlinkDirectory as hasSymlinkDirectory, enumerateRecordingFiles as enumerate, validateRecordingDirectory } from "@raceiq/recording-storage/filesystem";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm, readdir, unlink, link } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { cacheDelete } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { clearSessionCaptureCache } from "@raceiq/backend-core/session-capture/source-loader";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { db } from "@raceiq/backend-core/db/index";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { isSessionActive } from "@raceiq/backend-core/telemetry/live-pipeline";
import { reserveRecordingStorageOperation } from "@raceiq/backend-core/session-capture/storage-activity";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";
import { hasPendingLayoutMigration } from "./layout-migration";

export type RecordingDirectoryMoveStatus = { operationId: string | null; state: "idle" | "moving" | "complete" | "error"; phase: "copying" | "committing" | "removing-sources" | null; completedFiles: number; totalFiles: number; directory: string; code: string | null; error: string | null };
type Entry = { source: string; destination: string; size: number; sha256: string; published: boolean; publication?: { dev: string; ino: string } };
type Journal = { version: 1; operationId: string; oldDirectory: string; newDirectory: string; oldSetting: string | null; entries: Entry[]; references: { sessionId: number; oldPath: string; newPath: string }[] };
type MoveTestHooks = Partial<{ copyFile: typeof copyFile; saveSettings: typeof saveSettings; unlink: typeof unlink; isSessionActive: typeof isSessionActive }>;
const defaultMoveHooks: Required<MoveTestHooks> = { copyFile, saveSettings, unlink, isSessionActive };
const journalPath = resolve(resolveDataDir(), "recording-directory-move.json");
let status: RecordingDirectoryMoveStatus = { operationId: null, state: "idle", phase: null, completedFiles: 0, totalFiles: 0, directory: resolveRecordingDirectory(), code: null, error: null };
let active = false;

async function hashFile(path: string): Promise<{ size: number; sha256: string }> { return hashRecordingFile(path); }
async function persistJournal(journal: Journal): Promise<void> {
  await persistRecordingJournal(journalPath, journal);
}
async function validateDirectory(input: string): Promise<string> {
  return validateRecordingDirectory(input, { dataDirectory: resolveDataDir(), currentDirectory: resolveRecordingDirectory() });
}
export async function preflightRecordingDirectoryMove(directory: string): Promise<{ current: string; destination: string; containsFiles: boolean }> {
  const destination = await validateDirectory(directory);
  const raw = resolveRecordingDirectory();
  const current = await realpath(raw).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(raw) : Promise.reject(error));
  if (isContained(destination, current)) throw Object.assign(new Error("Recording folders cannot contain one another"), { code: "INVALID_DIRECTORY" });
  return { current, destination, containsFiles: current !== destination && (await readdir(destination)).length > 0 };
}

export async function relocateRecordingDirectoryUnderReservation(directory: string): Promise<void> {
  const requested = await validateDirectory(directory);
  const current = await realpath(resolveRecordingDirectory()).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(resolveRecordingDirectory()) : Promise.reject(error));
  if (requested === current) return;
  if (isContained(requested, current)) throw Object.assign(new Error("Recording folders cannot contain one another"), { code: "INVALID_DIRECTORY" });
  const operationId = randomUUID();
  status = { operationId, state: "moving", phase: "copying", completedFiles: 0, totalFiles: 0, directory: current, code: null, error: null };
  try {
    await executeMove(requested, operationId, defaultMoveHooks);
    status = { ...status, state: "complete", phase: null, directory: resolveRecordingDirectory() };
  } catch (error) {
    const rawCode = error instanceof Error && "code" in error ? String(error.code) : "STORAGE_IO_ERROR";
    status = { ...status, state: "error", phase: null, code: rawCode, error: error instanceof Error ? error.message : String(error), directory: resolveRecordingDirectory() };
    throw error;
  }
}
async function updateReferences(references: Journal["references"], pathKey: "oldPath" | "newPath"): Promise<void> {
  await db.transaction(async (tx) => {
    for (const reference of references) {
      await tx.update(sessions).set({ rawFile: reference[pathKey] }).where(eq(sessions.id, reference.sessionId)).run();
    }
  });
  clearSessionCaptureCache();
  for (const reference of references) {
    const rows = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, reference.sessionId)).all();
    for (const row of rows) cacheDelete(row.id);
  }
}
async function cleanupSources(journal: Journal, removeSource: typeof unlink = unlink): Promise<void> {
  await cleanupVerifiedRecordingSources(journal, journalPath, hashFile, { unlink: removeSource });
}
async function cleanupOwnedTemporary(entry: Entry, operationId: string, root: string): Promise<void> {
  await cleanupOwnedRecordingTemporary(entry, operationId, root, hashFile);
}
async function executeMove(directory: string, operationId: string, hooks: Required<MoveTestHooks>): Promise<void> {
  const setting = loadSettings().recordingDirectory;
  const rawOld = resolveRecordingDirectory();
  const oldDirectory = await realpath(rawOld).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(rawOld) : Promise.reject(error));
  const newDirectory = await validateDirectory(directory);
  if (oldDirectory === newDirectory) return;
  const lexicalOldDirectory = resolve(rawOld);
  const rows = await db.select({ id: sessions.id, rawFile: sessions.rawFile }).from(sessions).all();
  const files = new Set(await enumerate(oldDirectory, newDirectory)); const references: Journal["references"] = [];
  for (const row of rows) {
    if (!row.rawFile) continue;
    const rawPath = resolve(row.rawFile);
    if (isContained(newDirectory, rawPath)) continue;
    const aliasBase = isContained(lexicalOldDirectory, rawPath) ? lexicalOldDirectory : oldDirectory;
    if (await hasSymlinkDirectory(aliasBase, rawPath)) continue;
    try {
      const sourceInfo = await lstat(rawPath);
      if (!sourceInfo.isFile()) continue;
      const canonicalSource = await realpath(rawPath);
      if (!isContained(oldDirectory, canonicalSource) || isContained(newDirectory, canonicalSource)) continue;
      references.push({ sessionId: row.id, oldPath: row.rawFile, newPath: resolve(newDirectory, relative(oldDirectory, canonicalSource)) });
      files.add(canonicalSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!isContained(lexicalOldDirectory, rawPath) || isContained(newDirectory, rawPath)) continue;
      references.push({ sessionId: row.id, oldPath: row.rawFile, newPath: resolve(newDirectory, relative(lexicalOldDirectory, rawPath)) });
    }
  }
  const entries: Entry[] = [];
  for (const source of files) {
    const digest = await hashFile(source);
    entries.push({ source, destination: resolve(newDirectory, relative(oldDirectory, source)), ...digest, published: false });
  }
  const journal: Journal = { version: 1, operationId, oldDirectory, newDirectory, oldSetting: setting, entries, references };
  await persistJournal(journal);
  status = { ...status, phase: "copying", totalFiles: entries.length, completedFiles: 0 };
  const temporaryFiles: string[] = [];
  let referencesUpdated = false;
  try {
    for (const entry of entries) {
      if (await hasSymlinkDirectory(newDirectory, entry.destination)) throw Object.assign(new Error(`Destination path contains a symbolic link: ${entry.destination}`), { code: "DESTINATION_CONFLICT" });
      await mkdir(dirname(entry.destination), { recursive: true });
      const temporary = `${entry.destination}.move-${operationId}.tmp`;
      await hooks.copyFile(entry.source, temporary, constants.COPYFILE_EXCL);
      temporaryFiles.push(temporary);
      const out = await open(temporary, "r+"); try { await out.sync(); } finally { await out.close(); }
      const digest = await hashFile(temporary);
      if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw Object.assign(new Error("Copied recording verification failed"), { code: "STORAGE_IO_ERROR" });
      const stagedInfo = await lstat(temporary, { bigint: true });
      entry.publication = { dev: String(stagedInfo.dev), ino: String(stagedInfo.ino) };
      await persistJournal(journal);
      try { await link(temporary, entry.destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error(`Destination recording already exists: ${entry.destination}`), { code: "DESTINATION_CONFLICT" });
        throw error;
      }
      await unlink(temporary);
      temporaryFiles.pop();
      entry.published = true;
      await persistJournal(journal);
      const finalFile = await open(entry.destination, "r+");
      try { await finalFile.sync(); } finally { await finalFile.close(); }
      status = { ...status, completedFiles: status.completedFiles + 1 };
    }
    status = { ...status, phase: "committing" };
    await updateReferences(references, "newPath"); referencesUpdated = true;
    hooks.saveSettings({ ...loadSettings(), recordingDirectory: newDirectory });
    status = { ...status, directory: newDirectory, phase: "removing-sources" };
    await cleanupSources(journal, hooks.unlink);
  } catch (error) {
    if (resolveRecordingDirectory() !== newDirectory) {
      if (referencesUpdated) await updateReferences(references, "oldPath");
      for (const temporary of temporaryFiles) await rm(temporary, { force: true });
      for (const entry of entries) {
        if ((!entry.published && !entry.publication) || await hasSymlinkDirectory(newDirectory, entry.destination)) continue;
        try {
          await cleanupOwnedRecordingDestination(entry, newDirectory, hashFile);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
      }
      await removeEmptyDestinationDirs(journal);
      await rm(journalPath, { force: true });
    } else {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "SOURCE_CLEANUP_FAILED" });
    }
    throw error;
  }
}

async function removeEmptyDestinationDirs(journal: Journal): Promise<void> {
  await removeEmptyRecordingDirectoryTree(journal.newDirectory, journal.entries.map((entry) => entry.destination));
}
export function getRecordingDirectoryMoveStatus(): RecordingDirectoryMoveStatus { return { ...status, directory: resolveRecordingDirectory() }; }
export async function startRecordingDirectoryMove(directory: string, overrides?: MoveTestHooks): Promise<{ operationId: string; noOp?: boolean }> {
  const release = reserveRecordingStorageOperation("directory-move");
  if (active) { release(); throw Object.assign(new Error("A recording move is already active"), { code: "MOVE_ACTIVE" }); }
  active = true;
  const hooks = overrides ? { ...defaultMoveHooks, ...overrides } : defaultMoveHooks;
  let requested: string;
  let current: string;
  try {
    if (await hasPendingLayoutMigration()) throw Object.assign(new Error("Complete pending recording layout migration before moving the recording folder"), { code: "LAYOUT_MIGRATION_PENDING" });
    requested = await validateDirectory(directory);
    current = await realpath(resolveRecordingDirectory()).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(resolveRecordingDirectory()) : Promise.reject(error));
    const pending = await readFile(journalPath, "utf8").then((contents) => JSON.parse(contents) as Journal).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw Object.assign(new Error("Recording storage recovery is required"), { code: "RECOVERY_REQUIRED" });
    });
    if (pending && !(await validateRelocationJournal(pending, { dataDirectory: resolveDataDir() }))) {
      throw Object.assign(new Error("Recording storage recovery is required"), { code: "RECOVERY_REQUIRED" });
    }
    if (pending && (pending.newDirectory !== requested || current !== requested)) throw Object.assign(new Error("Finish recovery for the previous destination first"), { code: "RECOVERY_REQUIRED" });
    if (pending) {
      await verifyRecordingDestinations(pending.entries, hashFile);
      await cleanupSources(pending, hooks.unlink);
      status = { operationId: pending.operationId, state: "complete", phase: null, completedFiles: pending.entries.length, totalFiles: pending.entries.length, directory: current, code: null, error: null };
      release();
      active = false;
      return { operationId: pending.operationId, noOp: true };
    }
    if (requested === current) {
      release();
      active = false;
      return { operationId: "", noOp: true };
    }
  } catch (error) {
    release();
    active = false;
    throw error;
  }
  const operationId = randomUUID();
  let admit!: () => void;
  let rejectAdmission!: (error: unknown) => void;
  const admitted = new Promise<void>((resolveAdmission, reject) => { admit = resolveAdmission; rejectAdmission = reject; });
  void withSessionCaptureMaintenanceLock(async () => {
    try {
      if (hooks.isSessionActive()) throw Object.assign(new Error("Recording is active"), { code: "RECORDING_ACTIVE" });
      const lockedOld = await realpath(resolveRecordingDirectory()).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(resolveRecordingDirectory()) : Promise.reject(error));
      if (isContained(requested, lockedOld)) throw Object.assign(new Error("Recording folders cannot contain one another"), { code: "INVALID_DIRECTORY" });
      status = { operationId, state: "moving", phase: "copying", completedFiles: 0, totalFiles: 0, directory: current, code: null, error: null };
      admit();
      try {
        await executeMove(requested, operationId, hooks);
        status = { ...status, state: "complete", phase: null, directory: resolveRecordingDirectory() };
      } catch (error) {
        const rawCode = error instanceof Error && "code" in error ? String(error.code) : "STORAGE_IO_ERROR";
        const known = ["INVALID_DIRECTORY", "DESTINATION_CONFLICT", "SOURCE_CLEANUP_FAILED", "INSUFFICIENT_SPACE", "UNSUPPORTED_FILESYSTEM"];
        status = { ...status, state: "error", phase: null, code: rawCode === "ENOSPC" ? "INSUFFICIENT_SPACE" : known.includes(rawCode) ? rawCode : "STORAGE_IO_ERROR", error: error instanceof Error ? error.message : String(error), directory: resolveRecordingDirectory() };
      }
    } catch (error) {
      rejectAdmission(error);
    } finally {
      release();
      active = false;
    }
  });
  await admitted;
  return { operationId };
}
export async function recoverRecordingDirectoryMove(): Promise<void> {
  let journal: Journal | null;
  try {
    journal = await readValidatedRecordingJournal<Journal>(journalPath, async (value) => validateRelocationJournal(value, { dataDirectory: resolveDataDir() }));
  } catch { throw new Error("[RecordingStorage] Recovery required: relocation journal is invalid"); }
  if (!journal) return;
  const configured = resolveRecordingDirectory();
  const selected = await realpath(configured).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(configured);
    throw error;
  });
  const oldRoot = await realpath(journal.oldDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(journal.oldDirectory);
    throw error;
  });
  const newRoot = await realpath(journal.newDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(journal.newDirectory);
    throw error;
  });
  if (oldRoot !== journal.oldDirectory || newRoot !== journal.newDirectory) throw new Error("[RecordingStorage] Recovery required: journal roots are not canonical");
  if (selected !== journal.oldDirectory && selected !== journal.newDirectory) throw new Error("[RecordingStorage] Recovery required: settings directory matches neither relocation root");
  if (selected === journal.oldDirectory) {
    try {
      await updateReferences(journal.references, "oldPath");
      for (const entry of journal.entries) {
        if (entry.published !== false || entry.publication) {
          const info = await lstat(entry.destination, { bigint: true }).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          });
          if (info) {
            if (!info.isFile()) throw new Error("Published destination is not a regular file");
            if (!entry.publication || String(info.dev) === entry.publication.dev && String(info.ino) === entry.publication.ino) {
              const digest = await hashFile(entry.destination);
              if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Published destination changed");
              await rm(entry.destination);
            }
          }
        }
        await cleanupOwnedTemporary(entry, journal.operationId, journal.newDirectory);
      }
      await removeEmptyDestinationDirs(journal);
      await rm(journalPath, { force: true });
    } catch { throw new Error("[RecordingStorage] Recovery required: rollback could not restore storage"); }
    return;
  }
  try {
    for (const entry of journal.entries) {
      if (!(await lstat(entry.destination)).isFile()) throw new Error("Destination is not a regular file");
      const digest = await hashFile(entry.destination);
      if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Destination verification failed");
      await cleanupOwnedTemporary(entry, journal.operationId, journal.newDirectory);
    }
    await updateReferences(journal.references, "newPath");
  } catch { throw new Error("[RecordingStorage] Recovery required: committed destination verification failed"); }
  try {
    await cleanupSources(journal);
    status = { operationId: journal.operationId, state: "complete", phase: null, completedFiles: journal.entries.length, totalFiles: journal.entries.length, directory: journal.newDirectory, code: null, error: null };
  } catch (error) {
    status = { operationId: journal.operationId, state: "error", phase: null, completedFiles: journal.entries.length, totalFiles: journal.entries.length, directory: journal.newDirectory, code: "SOURCE_CLEANUP_FAILED", error: error instanceof Error ? error.message : String(error) };
  }
}
