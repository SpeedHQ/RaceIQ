import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, readdir, unlink, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
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
type MoveTestHooks = Partial<{ copyFile: typeof copyFile; saveSettings: typeof saveSettings; unlink: typeof unlink; isSessionActive: typeof isSessionActive }>;
const defaultMoveHooks: Required<MoveTestHooks> = { copyFile, saveSettings, unlink, isSessionActive };
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
async function canonicalExistingParent(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try { return await realpath(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
async function canonicalizePath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try { return resolve(await realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}
async function isValidJournal(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const journal = value as Journal;
  const hasExactKeys = (record: object, keys: string[]) => Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
  if (!hasExactKeys(journal, ["version", "operationId", "oldDirectory", "newDirectory", "oldSetting", "entries", "references"])
    || journal.version !== 1 || typeof journal.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.operationId)
    || typeof journal.oldDirectory !== "string" || typeof journal.newDirectory !== "string"
    || !isAbsolute(journal.oldDirectory) || !isAbsolute(journal.newDirectory)
    || (journal.oldSetting !== null && typeof journal.oldSetting !== "string")
    || !Array.isArray(journal.entries) || !Array.isArray(journal.references)) return false;
  const oldRoot = resolve(journal.oldDirectory), newRoot = resolve(journal.newDirectory);
  if (oldRoot !== journal.oldDirectory || newRoot !== journal.newDirectory || oldRoot === newRoot
    || isContained(oldRoot, newRoot) || isContained(newRoot, oldRoot)) return false;
  const dataRoot = await realpath(resolveDataDir()).catch(() => "");
  if (!dataRoot || oldRoot === parse(oldRoot).root || newRoot === parse(newRoot).root
    || oldRoot === dataRoot || isContained(oldRoot, dataRoot)
    || newRoot === dataRoot || isContained(dataRoot, newRoot) || isContained(newRoot, dataRoot)) return false;
  const entrySources = new Set<string>(), entryDestinations = new Set<string>();
  for (const entry of journal.entries) {
    if (!entry || typeof entry !== "object" || !hasExactKeys(entry, ["source", "destination", "size", "sha256"])
      || typeof entry.source !== "string" || typeof entry.destination !== "string"
      || !isAbsolute(entry.source) || !isAbsolute(entry.destination) || !isContained(oldRoot, resolve(entry.source))
      || !isContained(newRoot, resolve(entry.destination)) || resolve(entry.destination) !== resolve(newRoot, relative(oldRoot, resolve(entry.source)))
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false;
    const source = resolve(entry.source), destination = resolve(entry.destination);
    if (entrySources.has(source) || entryDestinations.has(destination)) return false;
    if (await hasSymlinkDirectory(oldRoot, source) || await hasSymlinkDirectory(newRoot, destination)) return false;
    for (const path of [source, destination]) {
      try { if (!(await lstat(path)).isFile()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    try {
      const sourceParent = await canonicalExistingParent(dirname(source));
      const destinationParent = await canonicalExistingParent(dirname(destination));
      if (!isContained(oldRoot, sourceParent) && sourceParent !== oldRoot) return false;
      if (!isContained(newRoot, destinationParent) && destinationParent !== newRoot) return false;
    } catch { return false; }
    entrySources.add(source); entryDestinations.add(destination);
  }
  const sessionIds = new Set<number>();
  for (const ref of journal.references) {
    if (!ref || typeof ref !== "object" || !hasExactKeys(ref, ["sessionId", "oldPath", "newPath"])
      || !Number.isSafeInteger(ref.sessionId) || ref.sessionId <= 0
      || typeof ref.oldPath !== "string" || !isAbsolute(ref.oldPath) || typeof ref.newPath !== "string" || !isAbsolute(ref.newPath)) return false;
    const oldPath = resolve(ref.oldPath), newPath = resolve(ref.newPath);
    if (sessionIds.has(ref.sessionId) || !isContained(newRoot, newPath)) return false;
    let canonicalPath: string;
    try {
      const rootInfo = await lstat(oldRoot);
      if (!rootInfo.isDirectory()) return false;
      canonicalPath = await canonicalizePath(oldPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      canonicalPath = oldPath;
    }
    if (!isContained(oldRoot, canonicalPath) || newPath !== resolve(newRoot, relative(oldRoot, canonicalPath))) return false;
    sessionIds.add(ref.sessionId);
  }
  return true;
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
async function hasSymlinkDirectory(root: string, path: string): Promise<boolean> {
  const parts = relative(root, path).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
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
async function cleanupSources(journal: Journal, removeSource: typeof unlink = unlink): Promise<void> {
  const residual: string[] = [];
  for (const entry of journal.entries) {
    try {
      const digest = await hashFile(entry.source);
      if (digest.size === entry.size && digest.sha256 === entry.sha256) await removeSource(entry.source);
      else residual.push(entry.source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") residual.push(entry.source);
    }
  }
  if (residual.length) throw Object.assign(new Error(`Unable to remove source recordings: ${residual.join(", ")}`), { code: "SOURCE_CLEANUP_FAILED" });
  await removeEmptySourceDirs(journal.oldDirectory, journal.entries);
  await rm(journalPath, { force: true });
}
async function executeMove(directory: string, operationId: string, hooks: Required<MoveTestHooks>): Promise<void> {
  const setting = loadSettings().recordingDirectory;
  const rawOld = resolveRecordingDirectory();
  const oldDirectory = await realpath(rawOld).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(rawOld) : Promise.reject(error));
  const newDirectory = await validateDirectory(directory);
  if (oldDirectory === newDirectory) return;
  if (isContained(oldDirectory, newDirectory) || isContained(newDirectory, oldDirectory)) throw Object.assign(new Error("Recording folders cannot contain one another"), { code: "INVALID_DIRECTORY" });
  if ((await readdir(newDirectory)).length) throw Object.assign(new Error("Destination must be empty"), { code: "DESTINATION_NOT_EMPTY" });
  const lexicalOldDirectory = resolve(rawOld);
  const rows = await db.select({ id: sessions.id, rawFile: sessions.rawFile }).from(sessions).all();
  const files = new Set(await enumerate(oldDirectory)); const references: Journal["references"] = [];
  for (const row of rows) {
    if (!row.rawFile) continue;
    const rawPath = resolve(row.rawFile);
    if (!isContained(lexicalOldDirectory, rawPath) && !isContained(oldDirectory, rawPath)) continue;
    const aliasBase = isContained(lexicalOldDirectory, rawPath) ? lexicalOldDirectory : oldDirectory;
    if (await hasSymlinkDirectory(aliasBase, rawPath)) continue;
    try {
      const sourceInfo = await lstat(rawPath);
      if (!sourceInfo.isFile()) continue;
      const canonicalSource = await realpath(rawPath);
      if (!isContained(oldDirectory, canonicalSource)) continue;
      references.push({ sessionId: row.id, oldPath: row.rawFile, newPath: resolve(newDirectory, relative(oldDirectory, canonicalSource)) });
      files.add(canonicalSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!isContained(lexicalOldDirectory, rawPath)) continue;
      references.push({ sessionId: row.id, oldPath: row.rawFile, newPath: resolve(newDirectory, relative(lexicalOldDirectory, rawPath)) });
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
      await hooks.copyFile(entry.source, temporary, constants.COPYFILE_EXCL);
      const out = await open(temporary, "r+"); try { await out.sync(); } finally { await out.close(); }
      const digest = await hashFile(temporary);
      if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw Object.assign(new Error("Copied recording verification failed"), { code: "STORAGE_IO_ERROR" });
      await hooks.copyFile(temporary, entry.destination, constants.COPYFILE_EXCL);
      published.push(entry.destination);
      const finalFile = await open(entry.destination, "r+");
      try { await finalFile.sync(); } finally { await finalFile.close(); }
      await unlink(temporary);
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
export async function startRecordingDirectoryMove(directory: string, overrides?: MoveTestHooks): Promise<{ operationId: string; noOp?: boolean }> {
  if (active) throw Object.assign(new Error("A recording move is already active"), { code: "MOVE_ACTIVE" });
  // HTTP routes pass no overrides; hooks make filesystem failures deterministic in storage tests.
  const hooks = overrides ? { ...defaultMoveHooks, ...overrides } : defaultMoveHooks;
  active = true;
  let requested: string;
  let current: string;
  try {
    requested = await validateDirectory(directory);
    current = await realpath(resolveRecordingDirectory()).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(resolveRecordingDirectory()) : Promise.reject(error));
    const pending = await readFile(journalPath, "utf8").then((contents) => JSON.parse(contents) as Journal).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw Object.assign(new Error("Recording storage recovery is required"), { code: "RECOVERY_REQUIRED" });
    });
    if (pending && !(await isValidJournal(pending))) throw Object.assign(new Error("Recording storage recovery is required"), { code: "RECOVERY_REQUIRED" });
    if (pending && (pending.newDirectory !== requested || current !== requested)) throw Object.assign(new Error("Finish recovery for the previous destination first"), { code: "RECOVERY_REQUIRED" });
    if (pending) {
      try {
        for (const entry of pending.entries) {
          if (!(await lstat(entry.destination)).isFile()) throw new Error("Committed recording is not a regular file");
          const digest = await hashFile(entry.destination);
          if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Committed recording verification failed");
        }
        await cleanupSources(pending, hooks.unlink);
        status = { operationId: pending.operationId, state: "complete", phase: null, completedFiles: pending.entries.length, totalFiles: pending.entries.length, directory: current, code: null, error: null };
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "SOURCE_CLEANUP_FAILED" });
      }
      active = false;
      return { operationId: pending.operationId, noOp: true };
    }
    if (requested === current) {
      active = false;
      return { operationId: "", noOp: true };
    }
  } catch (error) {
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
      if (isContained(lockedOld, requested) || isContained(requested, lockedOld)) throw Object.assign(new Error("Recording folders cannot contain one another"), { code: "INVALID_DIRECTORY" });
      if ((await readdir(requested)).length) throw Object.assign(new Error("Destination must be empty"), { code: "DESTINATION_NOT_EMPTY" });
      if (getRecordingStorageActivity().imports) throw new RecordingStorageBusyError("IMPORT_ACTIVE");
      setRecordingStorageRelocating(true);
      status = { operationId, state: "moving", phase: "copying", completedFiles: 0, totalFiles: 0, directory: current, code: null, error: null };
      admit();
      try {
        await executeMove(requested, operationId, hooks);
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
  if (!(await isValidJournal(journal))) throw new Error("[RecordingStorage] Recovery required: relocation journal is invalid");
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
        await rm(`${entry.destination}.move-${journal.operationId}.tmp`, { force: true });
        try { if ((await lstat(entry.destination)).isFile()) { const digest = await hashFile(entry.destination); if (digest.size === entry.size && digest.sha256 === entry.sha256) await rm(entry.destination); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await rm(journalPath, { force: true });
    } catch { throw new Error("[RecordingStorage] Recovery required: rollback could not restore storage"); }
    return;
  }
  try {
    for (const entry of journal.entries) {
      if (!(await lstat(entry.destination)).isFile()) throw new Error("Destination is not a regular file");
      const digest = await hashFile(entry.destination);
      if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Destination verification failed");
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
