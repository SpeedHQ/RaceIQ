import { randomUUID } from "node:crypto";
import { chmod, copyFile, link, mkdir, open, rename, stat, unlink, utimes, lstat, readFile, realpath, rmdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import {
  canonicalExistingRecordingParent,
  canonicalRecordingPath,
  hasRecordingSymlinkDirectory,
  isRecordingCaptureName,
  isRecordingPathContained,
  validateLegacyRecordingPath,
} from "./filesystem";

export type RecordingStorageOperations = {
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
  copyFile: typeof copyFile;
  mkdir: typeof mkdir;
  stat: typeof stat;
  chmod: typeof chmod;
  utimes: typeof utimes;
  link: typeof link;
  lstat: typeof lstat;
  readFile: typeof readFile;
  rmdir: typeof rmdir;
  rm: typeof rm;
};

const nodeOperations: RecordingStorageOperations = { open, rename, unlink, copyFile, mkdir, stat, chmod, utimes, link, lstat, readFile, rmdir, rm };

export async function persistRecordingJournal<T>(path: string, value: T, operations: RecordingStorageOperations = nodeOperations): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await operations.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await operations.rename(temporary, path);
    try { const directory = await operations.open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); } } catch { /* Directory sync may be unsupported. */ }
  } catch (error) {
    await operations.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function publishRecordingFile(source: string, target: string, expectedHash: string, hash: (path: string) => Promise<string>, operations: RecordingStorageOperations = nodeOperations): Promise<void> {
  await operations.mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await operations.copyFile(source, temporary, 1);
    const metadata = await operations.stat(source);
    await operations.chmod(temporary, metadata.mode & 0o777);
    await operations.utimes(temporary, metadata.atime, metadata.mtime);
    if (await hash(source) !== expectedHash || await hash(temporary) !== expectedHash) throw new Error("Copied recording failed verification");
    const file = await operations.open(temporary, "r+"); try { await file.sync(); } finally { await file.close(); }
    await operations.link(temporary, target);
    try { const directory = await operations.open(dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); } } catch { /* Directory sync may be unsupported. */ }
  } finally { await operations.unlink(temporary).catch(() => undefined); }
}
export async function readValidatedRecordingJournal<T>(
  path: string,
  validate: (value: unknown) => boolean | Promise<boolean>,
  operations: RecordingStorageOperations = nodeOperations,
): Promise<T | null> {
  const info = await operations.lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe recording journal");
  let value: unknown;
  try { value = JSON.parse(await operations.readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!await validate(value)) throw new Error("Invalid recording journal");
  return value as T;
}

export type RelocationJournal = {
  version: 1;
  operationId: string;
  oldDirectory: string;
  newDirectory: string;
  oldSetting: string | null;
  entries: {
    source: string;
    destination: string;
    size: number;
    sha256: string;
    published?: boolean;
    publication?: { dev: string; ino: string };
  }[];
  references: { sessionId: number; oldPath: string; newPath: string }[];
};

export async function validateRelocationJournal(
  value: unknown,
  context: { dataDirectory: string },
): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const journal = value as RelocationJournal;
  const exact = (record: object, keys: string[]) => Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
  if (!exact(journal, ["version", "operationId", "oldDirectory", "newDirectory", "oldSetting", "entries", "references"])
    || journal.version !== 1 || typeof journal.operationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.operationId)
    || typeof journal.oldDirectory !== "string" || typeof journal.newDirectory !== "string"
    || !isAbsolute(journal.oldDirectory) || !isAbsolute(journal.newDirectory)
    || (journal.oldSetting !== null && typeof journal.oldSetting !== "string")
    || !Array.isArray(journal.entries) || !Array.isArray(journal.references)) return false;
  const oldRoot = resolve(journal.oldDirectory), newRoot = resolve(journal.newDirectory);
  if (oldRoot !== journal.oldDirectory || newRoot !== journal.newDirectory || oldRoot === newRoot || isRecordingPathContained(newRoot, oldRoot)) return false;
  const dataRoot = await realpath(context.dataDirectory).catch(() => "");
  const nestedDestination = isRecordingPathContained(oldRoot, newRoot);
  if (!dataRoot || oldRoot === parse(oldRoot).root || newRoot === parse(newRoot).root
    || oldRoot === dataRoot || isRecordingPathContained(oldRoot, dataRoot)
    || newRoot === dataRoot || isRecordingPathContained(dataRoot, newRoot) && !(nestedDestination && isRecordingPathContained(dataRoot, oldRoot))
    || isRecordingPathContained(newRoot, dataRoot)) return false;
  const sources = new Set<string>(), destinations = new Set<string>();
  for (const entry of journal.entries) {
    const legacy = exact(entry, ["source", "destination", "size", "sha256"]);
    const current = exact(entry, ["source", "destination", "size", "sha256", "published"]);
    const owned = exact(entry, ["source", "destination", "size", "sha256", "published", "publication"]);
    if ((!legacy && !current && !owned) || typeof entry.source !== "string" || typeof entry.destination !== "string"
      || (!legacy && typeof entry.published !== "boolean")
      || (owned && (!entry.publication || typeof entry.publication !== "object" || !exact(entry.publication, ["dev", "ino"])
        || typeof entry.publication.dev !== "string" || typeof entry.publication.ino !== "string"))
      || !isAbsolute(entry.source) || !isAbsolute(entry.destination) || !isRecordingPathContained(oldRoot, resolve(entry.source))
      || isRecordingPathContained(newRoot, resolve(entry.source)) || !isRecordingPathContained(newRoot, resolve(entry.destination))
      || resolve(entry.destination) !== resolve(newRoot, relative(oldRoot, resolve(entry.source)))
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false;
    const source = resolve(entry.source), destination = resolve(entry.destination);
    if (sources.has(source) || destinations.has(destination)
      || await hasRecordingSymlinkDirectory(oldRoot, source) || await hasRecordingSymlinkDirectory(newRoot, destination)) return false;
    for (const path of [source, destination]) {
      try { if (!(await lstat(path)).isFile()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    try {
      const sourceParent = await canonicalExistingRecordingParent(dirname(source));
      const destinationParent = await canonicalExistingRecordingParent(dirname(destination));
      if (!isRecordingPathContained(oldRoot, sourceParent) && sourceParent !== oldRoot) return false;
      if (!isRecordingPathContained(newRoot, destinationParent) && destinationParent !== newRoot) return false;
    } catch { return false; }
    sources.add(source); destinations.add(destination);
  }
  const ids = new Set<number>();
  for (const ref of journal.references) {
    if (!ref || typeof ref !== "object" || !exact(ref, ["sessionId", "oldPath", "newPath"])
      || !Number.isSafeInteger(ref.sessionId) || ref.sessionId <= 0 || typeof ref.oldPath !== "string" || !isAbsolute(ref.oldPath)
      || typeof ref.newPath !== "string" || !isAbsolute(ref.newPath)) return false;
    const oldPath = resolve(ref.oldPath), newPath = resolve(ref.newPath);
    if (ids.has(ref.sessionId) || !isRecordingPathContained(newRoot, newPath)) return false;
    let canonical: string;
    try {
      if (!(await lstat(oldRoot)).isDirectory()) return false;
      canonical = await canonicalRecordingPath(oldPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      canonical = oldPath;
    }
    if (isRecordingPathContained(newRoot, canonical) || !isRecordingPathContained(oldRoot, canonical)
      || newPath !== resolve(newRoot, relative(oldRoot, canonical))) return false;
    ids.add(ref.sessionId);
  }
  return true;
}
export type LayoutMigrationJournal = {
  version: 1;
  root: string;
  destination?: string;
  phase?: "organizing" | "relocating";
  entries: { source: string; digest: string; destinations: string[]; published: string[]; references: { sessionId: number; oldPath: string; newPath: string }[]; cutover: boolean }[];
  progress: { status: "idle" | "running" | "success" | "partial" | "error"; done: number; total: number; migrated: number; failed: number; error: string | null };
};

export async function validateLayoutMigrationJournal(
  value: unknown,
  context: { currentDirectory: string; knownGames: ReadonlySet<string>; isReferenced: (reference: LayoutMigrationJournal["entries"][number]["references"][number], entry: LayoutMigrationJournal["entries"][number], journal: LayoutMigrationJournal) => Promise<boolean> },
): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const journal = value as LayoutMigrationJournal;
  if (journal.version !== 1 || typeof journal.root !== "string" || !isAbsolute(journal.root) || resolve(journal.root) !== journal.root
    || typeof (journal.destination ?? journal.root) !== "string" || !isAbsolute(journal.destination ?? journal.root!)
    || resolve(journal.destination ?? journal.root!) !== (journal.destination ?? journal.root)
    || !["organizing", "relocating"].includes(journal.phase ?? "organizing") || !Array.isArray(journal.entries) || !journal.progress
    || !["idle", "running", "success", "partial", "error"].includes(journal.progress.status)) return false;
  const destination = journal.destination ?? journal.root;
  const sourceRoot = await canonicalRecordingPath(journal.root);
  const destinationRoot = await canonicalRecordingPath(destination);
  const currentRoot = await canonicalRecordingPath(context.currentDirectory);
  if (currentRoot !== sourceRoot && currentRoot !== destinationRoot) return false;
  const relocated = currentRoot === destinationRoot && currentRoot !== sourceRoot;
  const sources = new Set<string>();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.source !== "string" || resolve(entry.source) !== entry.source || !isRecordingPathContained(journal.root, entry.source)
      || (!relocated && !await validateLegacyRecordingPath(journal.root, entry.source, false))
      || !context.knownGames.has(relative(journal.root, entry.source).split(sep)[0])
      || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)
      || !Array.isArray(entry.destinations) || !Array.isArray(entry.published) || !Array.isArray(entry.references)
      || typeof entry.cutover !== "boolean" || entry.destinations.length === 0
      || new Set(entry.destinations).size !== entry.destinations.length || sources.has(entry.source)
      || entry.published.some((path) => !entry.destinations.includes(path))) return false;
    sources.add(entry.source);
    for (const target of entry.destinations) {
      const parts = relative(journal.root, target).split(sep);
      if (!isAbsolute(target) || !isRecordingPathContained(journal.root, target) || resolve(target) !== target
        || !context.knownGames.has(parts[0]) || !["own", "others"].includes(parts[1]) || parts.length !== 3 || parts[2] !== basename(entry.source)) return false;
    }
    for (const reference of entry.references) {
      if (!Number.isSafeInteger(reference.sessionId) || typeof reference.oldPath !== "string" || !isAbsolute(reference.oldPath)
        || resolve(reference.oldPath) !== reference.oldPath || !entry.destinations.includes(reference.newPath)
        || await canonicalRecordingPath(reference.oldPath) !== await canonicalRecordingPath(entry.source)) return false;
      const oldInfo = await lstat(reference.oldPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (oldInfo?.isSymbolicLink()) return false;
    }
    let referenced = false;
    for (const reference of entry.references) if (await context.isReferenced(reference, entry, journal)) referenced = true;
    if (!isRecordingCaptureName(basename(entry.source)) && !referenced) return false;
    if (!entry.references.length && (entry.destinations.length !== 1
      || entry.destinations[0] !== resolve(journal.root, relative(journal.root, entry.source).split(sep)[0], "own", basename(entry.source)))) return false;
  }
  return true;
}

export async function readValidatedLayoutMigrationJournal(
  path: string,
  context: Parameters<typeof validateLayoutMigrationJournal>[1],
  operations: RecordingStorageOperations = nodeOperations,
): Promise<LayoutMigrationJournal | null> {
  const value = await readValidatedRecordingJournal<unknown>(path, (candidate) => Boolean(candidate && typeof candidate === "object"), operations);
  if (!value) return null;
  const journal = value as LayoutMigrationJournal;
  if (journal.destination === undefined && typeof journal.root === "string") journal.destination = journal.root;
  if (journal.phase === undefined && typeof journal.root === "string") journal.phase = "organizing";
  if (!await validateLayoutMigrationJournal(journal, context)) throw new Error("Invalid recording migration journal");
  return journal;
}

export type VerifiedRecording = { source: string; destination: string; size: number; sha256: string };
export type RecordingPublication = VerifiedRecording & { publication?: { dev: string; ino: string } };
export type RecordingDigest = (path: string) => Promise<{ size: number; sha256: string }>;

export async function removeEmptyRecordingDirectories(root: string, paths: readonly string[], operations: RecordingStorageOperations = nodeOperations): Promise<void> {
  const directories = new Set(paths.map((path) => dirname(path)).filter((path) => isRecordingPathContained(root, path)).sort((a, b) => b.length - a.length));
  for (const directory of directories) {
    try { await operations.rmdir(directory); }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "ENOTDIR") throw error; }
  }
}

export async function cleanupVerifiedRecordingSources(
  journal: { oldDirectory: string; entries: readonly VerifiedRecording[] },
  journalPath: string,
  hash: RecordingDigest,
  operations: Partial<Pick<RecordingStorageOperations, "unlink" | "rmdir" | "rm">> = {},
): Promise<void> {
  const residual: string[] = [];
  for (const entry of journal.entries) {
    try {
      const digest = await hash(entry.source);
      if (digest.size === entry.size && digest.sha256 === entry.sha256) await (operations.unlink ?? unlink)(entry.source);
      else residual.push(entry.source);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") residual.push(entry.source); }
  }
  if (residual.length) throw Object.assign(new Error(`Unable to remove source recordings: ${residual.join(", ")}`), { code: "SOURCE_CLEANUP_FAILED" });
  await removeEmptyRecordingDirectories(journal.oldDirectory, journal.entries.map((entry) => entry.source), { ...nodeOperations, ...operations });
  await (operations.rm ?? rm)(journalPath, { force: true });
}
export async function cleanupVerifiedRecordingSource(
  root: string,
  source: string,
  expectedHash: string,
  hash: (path: string) => Promise<string>,
  operations: Partial<Pick<RecordingStorageOperations, "unlink" | "rmdir">> = {},
): Promise<void> {
  try {
    if (await hash(source) !== expectedHash) {
      throw Object.assign(new Error(`Recording source changed: ${source}`), { code: "SOURCE_CLEANUP_FAILED" });
    }
    await (operations.unlink ?? unlink)(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await removeEmptyRecordingDirectories(root, [source], { ...nodeOperations, ...operations });
}

export async function removeEmptyRecordingDirectoryTree(root: string, paths: readonly string[], operations: RecordingStorageOperations = nodeOperations): Promise<void> {
  const directories = new Set<string>();
  for (const path of paths) {
    let directory = dirname(path);
    while (directory !== root && isRecordingPathContained(root, directory)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    if (await hasRecordingSymlinkDirectory(root, resolve(directory, ".cleanup-probe"))) continue;
    try {
      if (!(await operations.lstat(directory)).isDirectory()) continue;
      await operations.rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "ENOTDIR") throw error;
    }
  }
}

export async function cleanupOwnedRecordingTemporary(
  entry: RecordingPublication,
  operationId: string,
  root: string,
  hash: RecordingDigest,
  operations: RecordingStorageOperations = nodeOperations,
): Promise<void> {
  if (!entry.publication) return;
  const temporary = `${entry.destination}.move-${operationId}.tmp`;
  if (await hasRecordingSymlinkDirectory(root, temporary)) return;
  const info = await operations.lstat(temporary, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info || !info.isFile() || String(info.dev) !== entry.publication.dev || String(info.ino) !== entry.publication.ino) return;
  const digest = await hash(temporary);
  if (digest.size !== entry.size || digest.sha256 !== entry.sha256) return;
  await operations.rm(temporary);
}

export async function verifyRecordingDestinations(
  entries: readonly VerifiedRecording[],
  hash: RecordingDigest,
  operations: RecordingStorageOperations = nodeOperations,
): Promise<void> {
  for (const entry of entries) {
    const info = await operations.lstat(entry.destination);
    if (!info.isFile()) throw new Error("Destination is not a regular file");
    const digest = await hash(entry.destination);
    if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new Error("Destination verification failed");
  }
}

export async function cleanupOwnedRecordingDestination(
  entry: RecordingPublication,
  root: string,
  hash: RecordingDigest,
  operations: RecordingStorageOperations = nodeOperations,
): Promise<void> {
  if (await hasRecordingSymlinkDirectory(root, entry.destination)) return;
  const info = await operations.lstat(entry.destination, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile() || (entry.publication && (String(info.dev) !== entry.publication.dev || String(info.ino) !== entry.publication.ino))) return;
  const digest = await hash(entry.destination);
  if (digest.size !== entry.size || digest.sha256 !== entry.sha256) return;
  await operations.rm(entry.destination);
}
