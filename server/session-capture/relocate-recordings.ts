import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, readdir, unlink, rmdir, link } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { clearSessionCaptureCache } from "./source-loader";
import { laps, sessions, sessionCaptureSplitJobs } from "../db/schema";
import { db } from "../db/index";
import { resolveDataDir } from "../runtime/config/data-dir";
import { loadSettings, saveSettings } from "../runtime/config/settings";
import { resolveRecordingDirectory } from "../runtime/config/recording-directory";
import { isSessionActive } from "../telemetry/live-pipeline";
import { reserveRecordingStorageOperation } from "./storage-activity";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { hasPendingLayoutMigration } from "./layout-migration";

export type RecordingDirectoryMoveStatus = { operationId: string | null; state: "idle" | "moving" | "complete" | "error"; phase: "copying" | "committing" | "removing-sources" | null; completedFiles: number; totalFiles: number; directory: string; code: string | null; error: string | null };
type Entry = { source: string; destination: string; size: number; sha256: string; published: boolean; publication?: { dev: string; ino: string } };
type ReferenceField = "rawFile" | "captureManifestFile" | "sourcePath" | "stagingPath";
type JournalReference = { sessionId: number; table?: "sessions" | "sessionCaptureSplitJobs"; field?: ReferenceField; oldPath: string; newPath: string };
type Journal = { version: 1; operationId: string; oldDirectory: string; newDirectory: string; oldSetting: string | null; entries: Entry[]; references: JournalReference[] };
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
    try { const directory = await open(dirname(journalPath), "r"); try { await directory.sync(); } finally { await directory.close(); } } catch { /* Directory fsync is not supported on every platform. */ }
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
  if (oldRoot !== journal.oldDirectory || newRoot !== journal.newDirectory || oldRoot === newRoot || isContained(newRoot, oldRoot)) return false;
  const dataRoot = await realpath(resolveDataDir()).catch(() => "");
  const nestedDestination = isContained(oldRoot, newRoot);
  if (!dataRoot || oldRoot === parse(oldRoot).root || newRoot === parse(newRoot).root
    || oldRoot === dataRoot || isContained(oldRoot, dataRoot)
    || newRoot === dataRoot || isContained(dataRoot, newRoot) && !(nestedDestination && isContained(dataRoot, oldRoot))
    || isContained(newRoot, dataRoot)) return false;
  const entrySources = new Set<string>(), entryDestinations = new Set<string>();
  for (const entry of journal.entries) {
    const legacyEntry = hasExactKeys(entry, ["source", "destination", "size", "sha256"]);
    const currentEntry = hasExactKeys(entry, ["source", "destination", "size", "sha256", "published"]);
    const ownedEntry = hasExactKeys(entry, ["source", "destination", "size", "sha256", "published", "publication"]);
    if ((!legacyEntry && !currentEntry && !ownedEntry) || typeof entry.source !== "string" || typeof entry.destination !== "string"
      || (!legacyEntry && typeof entry.published !== "boolean")
      || (ownedEntry && (!entry.publication || typeof entry.publication !== "object"
        || !hasExactKeys(entry.publication, ["dev", "ino"]) || typeof entry.publication.dev !== "string" || typeof entry.publication.ino !== "string"))
      || !isAbsolute(entry.source) || !isAbsolute(entry.destination) || !isContained(oldRoot, resolve(entry.source))
      || isContained(newRoot, resolve(entry.source)) || !isContained(newRoot, resolve(entry.destination))
      || resolve(entry.destination) !== resolve(newRoot, relative(oldRoot, resolve(entry.source)))
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
  const referenceKeys = new Set<string>();
  for (const rawRef of journal.references as unknown[]) {
    if (!rawRef || typeof rawRef !== "object") return false;
    const ref = rawRef as JournalReference;
    const legacyRef = hasExactKeys(rawRef, ["sessionId", "oldPath", "newPath"]);
    const currentRef = hasExactKeys(rawRef, ["sessionId", "table", "field", "oldPath", "newPath"]);
    if ((!legacyRef && !currentRef) || !Number.isSafeInteger(ref.sessionId) || ref.sessionId <= 0
      || currentRef && !((ref.table === "sessions" && (ref.field === "rawFile" || ref.field === "captureManifestFile"))
        || (ref.table === "sessionCaptureSplitJobs" && (ref.field === "sourcePath" || ref.field === "stagingPath")))
      || typeof ref.oldPath !== "string" || !isAbsolute(ref.oldPath) || typeof ref.newPath !== "string" || !isAbsolute(ref.newPath)) return false;
    const field = legacyRef ? "rawFile" : ref.field;
    const table = legacyRef ? "sessions" : ref.table;
    const key = `${table}\0${field}\0${ref.sessionId}`;
    const oldPath = resolve(ref.oldPath), newPath = resolve(ref.newPath);
    if (referenceKeys.has(key) || !isContained(newRoot, newPath)) return false;
    let canonicalPath: string;
    try {
      const rootInfo = await lstat(oldRoot);
      if (!rootInfo.isDirectory()) return false;
      canonicalPath = await canonicalizePath(oldPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      canonicalPath = oldPath;
    }
    if (isContained(newRoot, canonicalPath) || !isContained(oldRoot, canonicalPath) || newPath !== resolve(newRoot, relative(oldRoot, canonicalPath))) return false;
    referenceKeys.add(key);
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
  const current = await realpath(resolveRecordingDirectory()).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(resolveRecordingDirectory()) : Promise.reject(error));
  const nestedDataDestination = isContained(current, canonical) && isContained(dataDir, current);
  if (canonical === parse(canonical).root || canonical === dataDir || canonical !== current && (isContained(canonical, dataDir) || isContained(dataDir, canonical) && !nestedDataDestination)) throw Object.assign(new Error("Directory is reserved"), { code: "INVALID_DIRECTORY" });
  if (canonical !== current) {
    const probe = resolve(canonical, `.raceiq-link-probe-${randomUUID()}`);
    const linkedProbe = `${probe}.link`;
    const handle = await open(probe, "wx");
    try {
      await handle.sync();
      await link(probe, linkedProbe);
    } catch (error) {
      if (["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw Object.assign(new Error("Destination filesystem does not support hard links required for safe recording relocation"), { code: "UNSUPPORTED_FILESYSTEM" });
      }
      throw error;
    } finally {
      await handle.close();
      await rm(linkedProbe, { force: true });
      await rm(probe, { force: true });
    }
  }
  return canonical;
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
async function enumerate(root: string, excluded?: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name);
      if (excluded && (path === excluded || isContained(excluded, path))) continue;
      const info = await lstat(path);
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
    for (const rawReference of references) {
      const reference = { ...rawReference, table: rawReference.table ?? "sessions", field: rawReference.field ?? "rawFile" };
      if (reference.table === "sessions") {
        await tx.update(sessions).set({ [reference.field]: reference[pathKey] }).where(eq(sessions.id, reference.sessionId)).run();
      } else {
        await tx.update(sessionCaptureSplitJobs).set({ [reference.field]: reference[pathKey] }).where(eq(sessionCaptureSplitJobs.sessionId, reference.sessionId)).run();
      }
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
async function cleanupOwnedTemporary(entry: Entry, operationId: string, root: string): Promise<void> {
  if (!entry.publication) return;
  const temporary = `${entry.destination}.move-${operationId}.tmp`;
  if (await hasSymlinkDirectory(root, temporary)) return;
  const info = await lstat(temporary, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info || !info.isFile() || String(info.dev) !== entry.publication.dev || String(info.ino) !== entry.publication.ino) return;
  const digest = await hashFile(temporary);
  if (digest.size !== entry.size || digest.sha256 !== entry.sha256) return;
  await rm(temporary);
}
async function executeMove(directory: string, operationId: string, hooks: Required<MoveTestHooks>): Promise<void> {
  const setting = loadSettings().recordingDirectory;
  const rawOld = resolveRecordingDirectory();
  const oldDirectory = await realpath(rawOld).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(rawOld) : Promise.reject(error));
  const newDirectory = await validateDirectory(directory);
  if (oldDirectory === newDirectory) return;
  const lexicalOldDirectory = resolve(rawOld);
  const [rows, jobs] = await Promise.all([
    db.select({ id: sessions.id, rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile }).from(sessions).all(),
    db.select({ sessionId: sessionCaptureSplitJobs.sessionId, sourcePath: sessionCaptureSplitJobs.sourcePath, stagingPath: sessionCaptureSplitJobs.stagingPath }).from(sessionCaptureSplitJobs).all(),
  ]);
  const files = new Set(await enumerate(oldDirectory, newDirectory)); const references: Journal["references"] = [];
  const relocateReference = async (sessionId: number, table: "sessions" | "sessionCaptureSplitJobs", field: ReferenceField, value: string | null) => {
    if (!value) return;
    const rawPath = resolve(value);
    if (isContained(newDirectory, rawPath)) return;
    const aliasBase = isContained(lexicalOldDirectory, rawPath) ? lexicalOldDirectory : oldDirectory;
    if (await hasSymlinkDirectory(aliasBase, rawPath)) return;
    try {
      const sourceInfo = await lstat(rawPath);
      if (!sourceInfo.isFile()) return;
      const canonicalSource = await realpath(rawPath);
      if (!isContained(oldDirectory, canonicalSource) || isContained(newDirectory, canonicalSource)) return;
      references.push({ sessionId, table, field, oldPath: value, newPath: resolve(newDirectory, relative(oldDirectory, canonicalSource)) });
      if (table === "sessions" && field === "captureManifestFile") {
        const manifest = JSON.parse(await readFile(canonicalSource, "utf8")) as { chunks?: Array<{ path?: unknown }> };
        for (const chunk of manifest.chunks ?? []) {
          if (typeof chunk.path !== "string") continue;
          const chunkPath = resolve(dirname(canonicalSource), chunk.path);
          if (!isContained(oldDirectory, chunkPath) || await hasSymlinkDirectory(oldDirectory, chunkPath)) continue;
          if ((await lstat(chunkPath)).isFile()) files.add(await realpath(chunkPath));
        }
      }
      files.add(canonicalSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!isContained(lexicalOldDirectory, rawPath) || isContained(newDirectory, rawPath)) return;
      references.push({ sessionId, table, field, oldPath: value, newPath: resolve(newDirectory, relative(lexicalOldDirectory, rawPath)) });
    }
  };
  for (const row of rows) {
    await relocateReference(row.id, "sessions", "rawFile", row.rawFile);
    await relocateReference(row.id, "sessions", "captureManifestFile", row.captureManifestFile);
  }
  for (const row of jobs) {
    await relocateReference(row.sessionId, "sessionCaptureSplitJobs", "sourcePath", row.sourcePath);
    await relocateReference(row.sessionId, "sessionCaptureSplitJobs", "stagingPath", row.stagingPath);
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
          const info = await lstat(entry.destination, { bigint: true });
          if (!info.isFile()) continue;
          if (entry.publication && (String(info.dev) !== entry.publication.dev || String(info.ino) !== entry.publication.ino)) continue;
          const digest = await hashFile(entry.destination);
          if (digest.size !== entry.size || digest.sha256 !== entry.sha256) continue;
          await rm(entry.destination);
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
  const directories = new Set<string>();
  for (const entry of journal.entries) {
    let directory = dirname(entry.destination);
    while (directory !== journal.newDirectory && isContained(journal.newDirectory, directory)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    if (await hasSymlinkDirectory(journal.newDirectory, resolve(directory, ".cleanup-probe"))) continue;
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
      await rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "ENOTDIR") throw error;
    }
  }
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
    if (pending && !(await isValidJournal(pending))) throw Object.assign(new Error("Recording storage recovery is required"), { code: "RECOVERY_REQUIRED" });
    if (pending && (pending.newDirectory !== requested || current !== requested)) throw Object.assign(new Error("Finish recovery for the previous destination first"), { code: "RECOVERY_REQUIRED" });
    if (pending) {
      for (const entry of pending.entries) {
        if (!(await lstat(entry.destination)).isFile()) throw new Error("Committed recording is not a regular file");
        const digest = await hashFile(entry.destination);
        if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Committed recording verification failed");
      }
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
