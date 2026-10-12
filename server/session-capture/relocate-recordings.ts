import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, readdir, unlink, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { clearSessionCaptureCache } from "./source-loader";
import { laps } from "../db/schema";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { resolveDataDir } from "../runtime/config/data-dir";
import { loadSettings, saveSettings } from "../runtime/config/settings";
import { resolveRecordingDirectory } from "../runtime/config/recording-directory";
import { isSessionActive } from "../telemetry/live-pipeline";
import { getRecordingStorageActivity, RecordingStorageBusyError, setRecordingStorageRelocating } from "./storage-activity";
import { withSessionCaptureMaintenanceLock } from "./cleanup";

export type RecordingDirectoryMoveStatus = { operationId: string | null; state: "idle" | "moving" | "complete" | "error"; phase: "copying" | "committing" | "removing-sources" | null; completedFiles: number; totalFiles: number; directory: string; code: string | null; error: string | null };
type Entry = { source: string; destination: string; size: number; sha256: string };
type Journal = { version: 1; operationId: string; oldDirectory: string; newDirectory: string; oldSetting: string | null; entries: Entry[]; references: { sessionId: number; oldPath: string; newPath: string }[] };
const journalPath = resolve(resolveDataDir(), "recording-directory-move.json");
let status: RecordingDirectoryMoveStatus = { operationId: null, state: "idle", phase: null, completedFiles: 0, totalFiles: 0, directory: resolveRecordingDirectory(), code: null, error: null };
let active = false;
function isContained(root: string, path: string): boolean { const part = relative(root, path); return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); }
async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest("hex") };
}
async function persistJournal(journal: Journal): Promise<void> {
  const temporary = `${journalPath}.${journal.operationId}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, journalPath);
    try { const directory = await open(dirname(journalPath), "r"); await directory.sync(); await directory.close(); } catch { /* Directory fsync is not supported on every platform. */ }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
function isValidJournal(value: Journal): boolean {
  return value?.version === 1
    && /^[0-9a-f-]{36}$/i.test(value.operationId)
    && isAbsolute(value.oldDirectory)
    && isAbsolute(value.newDirectory)
    && Array.isArray(value.entries)
    && Array.isArray(value.references)
    && value.entries.every((entry) => isContained(value.oldDirectory, entry.source)
      && entry.destination === resolve(value.newDirectory, relative(value.oldDirectory, entry.source))
      && Number.isSafeInteger(entry.size) && entry.size >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256))
    && value.references.every((ref) => Number.isSafeInteger(ref.sessionId) && isContained(value.oldDirectory, ref.oldPath)
      && ref.newPath === resolve(value.newDirectory, relative(value.oldDirectory, ref.oldPath)));
}
async function validateDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || !isAbsolute(input)) throw Object.assign(new Error("Directory must be an absolute path"), { code: "INVALID_DIRECTORY" });
  const requested = resolve(input);
  let canonical: string;
  try { canonical = await realpath(requested); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(requested, { recursive: true });
    canonical = await realpath(requested);
  }
  if (!(await lstat(canonical)).isDirectory()) throw Object.assign(new Error("Path is not a directory"), { code: "INVALID_DIRECTORY" });
  const dataDir = await realpath(resolveDataDir());
  if (canonical === parse(canonical).root || canonical === dataDir || isContained(canonical, dataDir)) throw Object.assign(new Error("Directory is reserved"), { code: "INVALID_DIRECTORY" });
  const probe = resolve(canonical, `.raceiq-write-${randomUUID()}`);
  const handle = await open(probe, "wx");
  try { await handle.sync(); } finally { await handle.close(); await unlink(probe); }
  return canonical;
}
async function enumerate(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name); const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile() && (name.endsWith(".bin") || name.endsWith(".bin.gz") || name.endsWith(".motec.zip"))) found.push(path);
    }
  }
  try { await visit(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return found;
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
async function removeEmptySourceDirs(root: string, entries: Entry[]): Promise<void> {
  const dirs = new Set(entries.map((entry) => dirname(entry.source)).filter((path) => isContained(root, path)).sort((a, b) => b.length - a.length));
  for (const dir of dirs) {
    try { await rmdir(dir); } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error; }
  }
}
async function cleanupSources(journal: Journal): Promise<void> {
  const residual: string[] = [];
  for (const entry of journal.entries) {
    try {
      const digest = await hashFile(entry.source);
      if (digest.size === entry.size && digest.sha256 === entry.sha256) await unlink(entry.source);
      else residual.push(entry.source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") residual.push(entry.source);
    }
  }
  if (residual.length) throw Object.assign(new Error(`Unable to remove source recordings: ${residual.join(", ")}`), { code: "SOURCE_CLEANUP_FAILED" });
  await removeEmptySourceDirs(journal.oldDirectory, journal.entries);
  await rm(journalPath, { force: true });
}
async function executeMove(directory: string, operationId: string): Promise<void> {
  const setting = loadSettings().recordingDirectory;
  const rawOld = resolveRecordingDirectory();
  const oldDirectory = await realpath(rawOld).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(rawOld) : Promise.reject(error));
  const newDirectory = await validateDirectory(directory);
  if (oldDirectory === newDirectory) return;
  if (isContained(oldDirectory, newDirectory) || isContained(newDirectory, oldDirectory)) throw Object.assign(new Error("Recording folders cannot contain one another"), { code: "INVALID_DIRECTORY" });
  if ((await readdir(newDirectory)).length) throw Object.assign(new Error("Destination must be empty"), { code: "DESTINATION_NOT_EMPTY" });
  const rows = await db.select({ id: sessions.id, rawFile: sessions.rawFile }).from(sessions).all();
  const files = new Set(await enumerate(oldDirectory)); const references: Journal["references"] = [];
  for (const row of rows) {
    if (!row.rawFile) continue;
    const oldPath = resolve(row.rawFile);
    if (!isContained(oldDirectory, oldPath)) continue;
    references.push({ sessionId: row.id, oldPath, newPath: resolve(newDirectory, relative(oldDirectory, oldPath)) });
    try {
      const canonicalSource = await realpath(oldPath);
      if (!isContained(oldDirectory, canonicalSource) || !(await lstat(canonicalSource)).isFile()) continue;
      files.add(canonicalSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const entries: Entry[] = [];
  for (const source of files) { const digest = await hashFile(source); entries.push({ source, destination: resolve(newDirectory, relative(oldDirectory, source)), ...digest }); }
  const journal: Journal = { version: 1, operationId, oldDirectory, newDirectory, oldSetting: setting, entries, references };
  await persistJournal(journal);
  status = { ...status, phase: "copying", totalFiles: entries.length, completedFiles: 0 };
  const published: string[] = [];
  let referencesUpdated = false;
  try {
    for (const entry of entries) {
      await mkdir(dirname(entry.destination), { recursive: true });
      const temporary = `${entry.destination}.move-${operationId}.tmp`;
      await copyFile(entry.source, temporary, constants.COPYFILE_EXCL);
      const out = await open(temporary, "r+"); try { await out.sync(); } finally { await out.close(); }
      const digest = await hashFile(temporary);
      if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw Object.assign(new Error("Copied recording verification failed"), { code: "STORAGE_IO_ERROR" });
      await copyFile(temporary, entry.destination, constants.COPYFILE_EXCL);
      published.push(entry.destination);
      const finalFile = await open(entry.destination, "r+");
      try { await finalFile.sync(); } finally { await finalFile.close(); }
      await unlink(temporary);
      status = { ...status, completedFiles: status.completedFiles + 1 };
    }
    status = { ...status, phase: "committing" };
    await updateReferences(references, "newPath"); referencesUpdated = true;
    saveSettings({ ...loadSettings(), recordingDirectory: newDirectory });
    status = { ...status, directory: newDirectory, phase: "removing-sources" };
    await cleanupSources(journal);
  } catch (error) {
    if (resolveRecordingDirectory() !== newDirectory) {
      if (referencesUpdated) await updateReferences(references, "oldPath");
      for (const entry of entries) await rm(`${entry.destination}.move-${operationId}.tmp`, { force: true });
      for (const path of published) await rm(path, { force: true });
      await rm(journalPath, { force: true });
    } else {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "SOURCE_CLEANUP_FAILED" });
    }
    throw error;
  }
}
export function getRecordingDirectoryMoveStatus(): RecordingDirectoryMoveStatus { return { ...status, directory: resolveRecordingDirectory() }; }
export async function startRecordingDirectoryMove(directory: string): Promise<{ operationId: string; noOp?: boolean }> {
  if (active) throw Object.assign(new Error("A recording move is already active"), { code: "MOVE_ACTIVE" });
  const requested = await validateDirectory(directory);
  const current = await realpath(resolveRecordingDirectory()).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(resolveRecordingDirectory()) : Promise.reject(error));
  const pending = await readFile(journalPath, "utf8").then((contents) => JSON.parse(contents) as Journal).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw Object.assign(new Error("Recording storage recovery is required"), { code: "RECOVERY_REQUIRED" });
  });
  if (pending && !isValidJournal(pending)) throw Object.assign(new Error("Recording storage recovery is required"), { code: "RECOVERY_REQUIRED" });
  if (pending && (pending.newDirectory !== requested || current !== requested)) throw Object.assign(new Error("Finish recovery for the previous destination first"), { code: "RECOVERY_REQUIRED" });
  if (pending) {
    try {
      for (const entry of pending.entries) {
        const digest = await hashFile(entry.destination);
        if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Committed recording verification failed");
      }
      await cleanupSources(pending);
      status = { operationId: pending.operationId, state: "complete", phase: null, completedFiles: pending.entries.length, totalFiles: pending.entries.length, directory: current, code: null, error: null };
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "SOURCE_CLEANUP_FAILED" });
    }
    return { operationId: pending.operationId, noOp: true };
  }
  if (requested === current) return { operationId: "", noOp: true };
  active = true;
  const operationId = randomUUID();
  let admit!: () => void;
  let rejectAdmission!: (error: unknown) => void;
  const admitted = new Promise<void>((resolveAdmission, reject) => { admit = resolveAdmission; rejectAdmission = reject; });
  void withSessionCaptureMaintenanceLock(async () => {
    try {
      if (isSessionActive()) throw Object.assign(new Error("Recording is active"), { code: "RECORDING_ACTIVE" });
      const lockedOld = await realpath(resolveRecordingDirectory()).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(resolveRecordingDirectory()) : Promise.reject(error));
      if (isContained(lockedOld, requested) || isContained(requested, lockedOld)) throw Object.assign(new Error("Recording folders cannot contain one another"), { code: "INVALID_DIRECTORY" });
      if ((await readdir(requested)).length) throw Object.assign(new Error("Destination must be empty"), { code: "DESTINATION_NOT_EMPTY" });
      if (getRecordingStorageActivity().imports) throw new RecordingStorageBusyError("IMPORT_ACTIVE");
      setRecordingStorageRelocating(true);
      status = { operationId, state: "moving", phase: "copying", completedFiles: 0, totalFiles: 0, directory: current, code: null, error: null };
      admit();
      try {
        await executeMove(requested, operationId);
        status = { ...status, state: "complete", phase: null, directory: resolveRecordingDirectory() };
      } catch (error) {
        const rawCode = error instanceof Error && "code" in error ? String(error.code) : "STORAGE_IO_ERROR";
        const known = ["INVALID_DIRECTORY", "DESTINATION_NOT_EMPTY", "SOURCE_CLEANUP_FAILED", "INSUFFICIENT_SPACE"];
        status = { ...status, state: "error", phase: null, code: rawCode === "ENOSPC" ? "INSUFFICIENT_SPACE" : known.includes(rawCode) ? rawCode : "STORAGE_IO_ERROR", error: error instanceof Error ? error.message : String(error), directory: resolveRecordingDirectory() };
      } finally {
        setRecordingStorageRelocating(false);
        active = false;
      }
    } catch (error) {
      rejectAdmission(error);
      active = false;
    }
  });
  await admitted;
  return { operationId };
}
export async function recoverRecordingDirectoryMove(): Promise<void> {
  let journal: Journal;
  try { journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("[RecordingStorage] Recovery required: relocation journal is invalid"); }
  if (!isValidJournal(journal)) throw new Error("[RecordingStorage] Recovery required: relocation journal is invalid");
  const selected = resolveRecordingDirectory();
  if (selected !== journal.oldDirectory && selected !== journal.newDirectory) throw new Error("[RecordingStorage] Recovery required: settings directory matches neither relocation root");
  if (selected === journal.oldDirectory) {
    try {
      await updateReferences(journal.references, "oldPath");
      for (const entry of journal.entries) {
        await rm(`${entry.destination}.move-${journal.operationId}.tmp`, { force: true });
        try { const digest = await hashFile(entry.destination); if (digest.size === entry.size && digest.sha256 === entry.sha256) await rm(entry.destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await rm(journalPath, { force: true });
    } catch { throw new Error("[RecordingStorage] Recovery required: rollback could not restore storage"); }
    return;
  }
  try {
    for (const entry of journal.entries) { const digest = await hashFile(entry.destination); if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Destination verification failed"); }
    await updateReferences(journal.references, "newPath");
  } catch { throw new Error("[RecordingStorage] Recovery required: committed destination verification failed"); }
  try {
    await cleanupSources(journal);
    status = { operationId: journal.operationId, state: "complete", phase: null, completedFiles: journal.entries.length, totalFiles: journal.entries.length, directory: journal.newDirectory, code: null, error: null };
  } catch (error) {
    status = { operationId: journal.operationId, state: "error", phase: null, completedFiles: journal.entries.length, totalFiles: journal.entries.length, directory: journal.newDirectory, code: "SOURCE_CLEANUP_FAILED", error: error instanceof Error ? error.message : String(error) };
  }
}
