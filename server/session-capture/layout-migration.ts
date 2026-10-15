import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { resolveDataDir } from "../runtime/config/data-dir";
import { resolveRecordingDirectory } from "../runtime/config/recording-directory";
import { getAllGames } from "@raceiq/shared/games/registry";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { getRecordingDirectoryMoveStatus, preflightRecordingDirectoryMove, recoverRecordingDirectoryMove, relocateRecordingDirectoryUnderReservation } from "./relocate-recordings";
import { reserveRecordingStorageOperation } from "./storage-activity";
import { isSessionActive } from "../telemetry/live-pipeline";

import { clearSessionCaptureCache } from "./source-loader";
import { cacheDelete } from "../db/telemetry-replay-storage";
export type LayoutMigrationProgress = { status: "idle" | "running" | "success" | "partial" | "error"; done: number; total: number; migrated: number; failed: number; error: string | null; phase?: "organizing" | "relocating" | null };
type SessionReference = { sessionId: number; oldPath: string; newPath: string };
type JournalEntry = { source: string; digest: string; destinations: string[]; published: string[]; references: SessionReference[]; cutover: boolean };
type Journal = { version: 1; root: string; destination: string; phase: "organizing" | "relocating"; entries: JournalEntry[]; progress: LayoutMigrationProgress };
const journalFile = join(resolveDataDir(), "recording-layout-migration.json");
let active = false;
let progress: LayoutMigrationProgress = { status: "idle", done: 0, total: 0, migrated: 0, failed: 0, error: null };
let migrationGeneration = 0;
const completionListeners = new Set<() => void>();
export function subscribeLayoutMigrationComplete(listener: () => void): () => void {
  completionListeners.add(listener);
  return () => completionListeners.delete(listener);
}
function notifyLayoutMigrationComplete(): void {
  for (const listener of completionListeners) {
    try { listener(); } catch (error) { console.error("[LayoutMigration] Completion listener failed:", error); }
  }
}
const extensions = [".bin", ".bin.gz", ".motec.zip"];
const isCapture = (name: string) => extensions.some((extension) => name.endsWith(extension));
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function expectedDestination(root: string, source: string, owner: string, game: string): string {
  return resolve(join(root, game, owner === "others" ? "others" : "own", basename(source)));
}
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
async function validateLegacyPath(root: string, path: string, requireCaptureName = true): Promise<boolean> {
  const parts = relative(root, path).split(sep);
  if (!inside(root, path) || parts.length !== 2 || (requireCaptureName && !isCapture(parts[1]))) return false;
  const rootInfo = await lstat(root).catch(() => null);
  const parent = await lstat(join(root, parts[0])).catch(() => null);
  if (rootInfo?.isSymbolicLink() || (rootInfo && !rootInfo.isDirectory()) || parent?.isSymbolicLink() || (parent && !parent.isDirectory())) return false;
  const file = await lstat(path).catch(() => null);
  return file === null || (file.isFile() && !file.isSymbolicLink());
}
async function canonicalFilesystemPath(path: string): Promise<string> {
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
async function isLegacyCandidateFile(root: string, path: string, requireCaptureName = true): Promise<boolean> {
  if (!await validateLegacyPath(root, path, requireCaptureName)) return false;
  const directory = await lstat(dirname(path)).catch(() => null);
  const file = await lstat(path).catch(() => null);
  return Boolean(directory?.isDirectory() && !directory.isSymbolicLink() && file?.isFile() && !file.isSymbolicLink());
}

async function readJournal(): Promise<Journal | null> {
  const journalInfo = await lstat(journalFile).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!journalInfo) return null;
  if (!journalInfo.isFile() || journalInfo.isSymbolicLink()) throw new Error("Unsafe recording migration journal");
  let value: unknown;
  try { value = JSON.parse(await readFile(journalFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!value || typeof value !== "object") throw new Error("Invalid recording migration journal");
  const journal = value as Journal;
  if (typeof journal.root === "string" && journal.destination === undefined) journal.destination = journal.root;
  if (typeof journal.root === "string" && journal.phase === undefined) journal.phase = "organizing";
  const knownGames = new Set<string>(getAllGames().map((game) => game.id));
  if (journal.version !== 1 || typeof journal.root !== "string" || !isAbsolute(journal.root) || resolve(journal.root) !== journal.root ||
      typeof journal.destination !== "string" || !isAbsolute(journal.destination) || resolve(journal.destination) !== journal.destination ||
      !["organizing", "relocating"].includes(journal.phase) || !Array.isArray(journal.entries) || !journal.progress ||
      !["idle", "running", "success", "partial", "error"].includes(journal.progress.status)) throw new Error("Invalid recording migration journal");
  const currentRoot = await canonicalFilesystemPath(resolveRecordingDirectory());
  const sourceRoot = await canonicalFilesystemPath(journal.root);
  const destinationRoot = await canonicalFilesystemPath(journal.destination);
  if (currentRoot !== sourceRoot && currentRoot !== destinationRoot) throw new Error("Recording migration journal belongs to a different recording root");
  const relocated = currentRoot === destinationRoot && currentRoot !== sourceRoot;
  const sources = new Set<string>();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.source !== "string" || resolve(entry.source) !== entry.source || !inside(journal.root, entry.source) ||
      (!relocated && !(await validateLegacyPath(journal.root, entry.source, false))) ||
      !knownGames.has(relative(journal.root, entry.source).split(sep)[0]) || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest) || !Array.isArray(entry.destinations) || !Array.isArray(entry.published) || !Array.isArray(entry.references) ||
      typeof entry.cutover !== "boolean" || entry.destinations.length === 0 || new Set(entry.destinations).size !== entry.destinations.length || sources.has(entry.source) ||
      entry.published.some((path) => !entry.destinations.includes(path))) throw new Error("Unsafe recording migration journal");
    sources.add(entry.source);
    for (const destination of entry.destinations) {
      const parts = relative(journal.root, destination).split(sep);
      if (!isAbsolute(destination) || !inside(journal.root, destination) || resolve(destination) !== destination ||
        !knownGames.has(parts[0]) || !["own", "others"].includes(parts[1]) || parts.length !== 3 || parts[2] !== basename(entry.source)) throw new Error("Unsafe recording migration destination");
    }
    for (const ref of entry.references) {
      if (!Number.isSafeInteger(ref.sessionId) || typeof ref.oldPath !== "string" || !isAbsolute(ref.oldPath) || resolve(ref.oldPath) !== ref.oldPath ||
          !entry.destinations.includes(ref.newPath) || await canonicalFilesystemPath(ref.oldPath) !== await canonicalFilesystemPath(entry.source)) throw new Error("Unsafe recording migration reference");
      const oldInfo = await lstat(ref.oldPath).catch(() => null);
      if (oldInfo?.isSymbolicLink()) throw new Error("Unsafe recording migration reference source");
    }
  }
  for (const entry of journal.entries) {
    let referenced = false;
    for (const ref of entry.references) {
      const row = await db.select({ gameId: sessions.gameId, ownership: sessions.ownership, rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, ref.sessionId)).get();
      if (row && expectedDestination(journal.root, ref.oldPath, row.ownership, row.gameId) !== ref.newPath) throw new Error("Unsafe recording migration reference destination");
      if (row && (row.rawFile === ref.oldPath || row.rawFile === ref.newPath || row.rawFile === expectedDestination(journal.destination, ref.oldPath, row.ownership, row.gameId))) referenced = true;
    }
    if (!isCapture(basename(entry.source)) && !referenced) throw new Error("Unreferenced non-recording file in migration journal");
    if (!entry.references.length && (entry.destinations.length !== 1 || entry.destinations[0] !== expectedDestination(journal.root, entry.source, "mine", relative(journal.root, entry.source).split(sep)[0]))) throw new Error("Unsafe orphan recording destination");
  }
  return journal;
}
async function saveJournal(journal: Journal): Promise<void> {
  const temp = `${journalFile}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, journalFile);
  try { const directory = await open(dirname(journalFile), "r"); try { await directory.sync(); } finally { await directory.close(); } } catch { /* Directory sync unavailable on some platforms. */ }
}
async function findLegacyFiles(root: string): Promise<string[]> {
  const knownGames = new Set<string>(getAllGames().map((game) => game.id));
  const result: string[] = [];
  let games;
  try { games = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  for (const game of games) {
    if (!game.isDirectory() || game.name === "own" || game.name === "others" || !knownGames.has(game.name)) continue;
    const directory = join(root, game.name);
    let files;
    try { files = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const file of files) if (file.isFile() && isCapture(file.name)) result.push(join(directory, file.name));
  }
  return result;
}
async function buildEntries(): Promise<JournalEntry[]> {
  const root = resolveRecordingDirectory();
  const legacy = await findLegacyFiles(root);
  const refs = await db.select({ id: sessions.id, gameId: sessions.gameId, ownership: sessions.ownership, rawFile: sessions.rawFile }).from(sessions).all();
  const grouped = new Map<string, typeof refs>();
  const filesystemRoot = await realpath(root).catch(() => root);
  const knownGames = new Set<string>(getAllGames().map((game) => game.id));
  for (const ref of refs) {
    if (!ref.rawFile) continue;
    const rawPath = resolve(ref.rawFile);
    const rawInfo = await lstat(rawPath).catch(() => null);
    if (!rawInfo?.isFile() || rawInfo.isSymbolicLink()) continue;
    const physicalPath = await canonicalFilesystemPath(rawPath).catch(() => null);
    if (!physicalPath || !inside(filesystemRoot, physicalPath)) continue;
    const parts = relative(filesystemRoot, physicalPath).split(sep);
    if (parts.length !== 2 || !knownGames.has(parts[0])) continue;
    const path = join(root, ...parts);
    if (!await isLegacyCandidateFile(root, path, false)) continue;
    const list = grouped.get(path) ?? [];
    list.push(ref);
    grouped.set(path, list);
  }
  const candidates = new Set(legacy);
  for (const path of grouped.keys()) candidates.add(path);
  const entries: JournalEntry[] = [];
  for (const source of candidates) {
    const stat = await lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    const ownership = new Map<string, { owner: string; game: string }>();
    for (const ref of grouped.get(source) ?? []) ownership.set(`${ref.ownership === "others" ? "others" : "own"}\0${ref.gameId}`, { owner: ref.ownership === "others" ? "others" : "own", game: ref.gameId });
    if (!ownership.size) ownership.set(`own\0${relative(root, source).split(sep)[0]}`, { owner: "own", game: relative(root, source).split(sep)[0] });
    const destinations = [...ownership.values()].map(({ owner, game }) => expectedDestination(root, source, owner, game));
    const references = (grouped.get(source) ?? []).map((ref) => ({
      sessionId: ref.id, oldPath: resolve(ref.rawFile!), newPath: expectedDestination(root, source, ref.ownership, ref.gameId),
    }));
    entries.push({ source, digest: await fileHash(source), destinations, published: [], references, cutover: false });
  }
  return entries;
}

export async function getLayoutMigrationStatus(): Promise<{ directory: string; fileCount: number; sessionCount: number; destinationDirectory: string | null; progress: LayoutMigrationProgress & { phase: "organizing" | "relocating" | null } }> {
  const startedActive = active;
  let journal: Journal | null = null;
  let readError: string | null = null;
  try { journal = await readJournal(); } catch (error) { readError = error instanceof Error ? error.message : "Invalid migration journal"; }
  const entries = journal ? journal.entries : await buildEntries();
  const paths = new Set(entries.map((entry) => entry.source));
  const physicalPaths = new Set(await Promise.all(entries.map((entry) => canonicalFilesystemPath(entry.source).catch(() => entry.source))));
  const referenced = await db.select({ rawFile: sessions.rawFile }).from(sessions).all();
  let sessionCount = 0;
  for (const row of referenced) {
    if (!row.rawFile) continue;
    const path = resolve(row.rawFile);
    if (paths.has(path) || physicalPaths.has(await canonicalFilesystemPath(path).catch(() => path))) sessionCount++;
  }
  let reportedProgress: LayoutMigrationProgress & { phase: "organizing" | "relocating" | null } = { ...progress, phase: active ? progress.phase ?? "organizing" : null };
  if (journal && !startedActive && !active) reportedProgress = journal.progress.status === "running"
    ? { ...journal.progress, phase: journal.phase, status: "error", error: "Migration interrupted; retry explicitly to resume" }
    : { ...journal.progress, phase: journal.phase };
  if (readError && !startedActive && !active) reportedProgress = { ...reportedProgress, status: "error", error: readError };
  if (active) reportedProgress.status = "running";
  const move = getRecordingDirectoryMoveStatus();
  if (active && journal?.phase === "relocating" && move.state === "moving") {
    reportedProgress.done = move.completedFiles;
    reportedProgress.total = move.totalFiles;
    reportedProgress.phase = "relocating";
  }
  return { directory: resolveRecordingDirectory(), destinationDirectory: journal?.destination ?? null, fileCount: entries.filter((entry) => !entry.cutover).length, sessionCount, progress: reportedProgress };
}
export async function hasPendingLayoutMigration(): Promise<boolean> {
  const journal = await readJournal();
  return Boolean(journal);
}
export async function isLayoutMigrationReadyForStartup(): Promise<boolean> {
  const generation = migrationGeneration;
  const blocked = () => active || progress.status === "running" || progress.status === "partial" || progress.status === "error";
  if (blocked()) return false;
  if (await readJournal()) return false;
  const move = getRecordingDirectoryMoveStatus();
  if (move.state === "moving" || move.state === "error") return false;
  const root = resolveRecordingDirectory();
  if ((await findLegacyFiles(root)).length) return false;
  const knownGames = new Set<string>(getAllGames().map((game) => game.id));
  const filesystemRoot = await realpath(root).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? root : Promise.reject(error));
  for (const ref of await db.select({ rawFile: sessions.rawFile }).from(sessions).all()) {
    if (!ref.rawFile) continue;
    const rawPath = resolve(ref.rawFile);
    const rawInfo = await lstat(rawPath).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (!rawInfo?.isFile() || rawInfo.isSymbolicLink()) continue;
    const physicalPath = await canonicalFilesystemPath(rawPath).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (!physicalPath || !inside(filesystemRoot, physicalPath)) continue;
    const parts = relative(filesystemRoot, physicalPath).split(sep);
    if (parts.length === 2 && knownGames.has(parts[0]) && await isLegacyCandidateFile(root, join(root, ...parts), false)) return false;
  }
  if (generation !== migrationGeneration || blocked()) return false;
  const journal = await readJournal();
  return generation === migrationGeneration && !blocked() && !journal
    && !["moving", "error"].includes(getRecordingDirectoryMoveStatus().state);
}
async function publish(source: string, target: string, digest: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.migration-tmp`;
  try {
    await copyFile(source, temp, constants.COPYFILE_EXCL);
    const metadata = await stat(source);
    await chmod(temp, metadata.mode & 0o777);
    await utimes(temp, metadata.atime, metadata.mtime);
    if (await fileHash(source) !== digest || await fileHash(temp) !== digest) throw new Error("Copied recording failed verification");
    // Windows requires write access when flushing file buffers.
    const file = await open(temp, "r+"); try { await file.sync(); } finally { await file.close(); }
    await link(temp, target);
    try { const dir = await open(dirname(target), "r"); try { await dir.sync(); } finally { await dir.close(); } } catch { /* Directory fsync may be unsupported. */ }
  } finally { await unlink(temp).catch(() => undefined); }
}
export async function startLayoutMigration(directory?: string): Promise<void> {
  if (active) throw Object.assign(new Error("Layout migration is already running"), { code: "MIGRATION_ACTIVE" });
  const release = reserveRecordingStorageOperation("layout-migration");
  if (isSessionActive()) { release(); throw Object.assign(new Error("Recording is active"), { code: "RECORDING_ACTIVE" }); }
  migrationGeneration++;
  active = true;
  let admit!: () => void;
  let rejectAdmission!: (error: unknown) => void;
  let admitted = false;
  let admissionError: unknown;
  let admissionFailed = false;
  const admission = new Promise<void>((resolveAdmission, reject) => { admit = resolveAdmission; rejectAdmission = reject; });
  progress = { status: "running", phase: "organizing", done: 0, total: progress.total, migrated: 0, failed: 0, error: null };
  void withSessionCaptureMaintenanceLock(async () => {
    if (isSessionActive()) throw Object.assign(new Error("Recording is active"), { code: "RECORDING_ACTIVE" });
    const existing = await readJournal();
    if (existing && directory !== undefined && await canonicalFilesystemPath(directory) !== await canonicalFilesystemPath(existing.destination)) {
      throw Object.assign(new Error("Finish the previously selected destination first"), { code: "LAYOUT_MIGRATION_PENDING" });
    }
    await recoverRecordingDirectoryMove();
    const pending = Boolean(existing);
    const preflight = await preflightRecordingDirectoryMove(pending ? existing!.destination : directory ?? resolveRecordingDirectory());
    const journal: Journal = pending ? existing! : { version: 1, root: resolveRecordingDirectory(), destination: preflight.destination, phase: "organizing", entries: await buildEntries(), progress };
    progress = { status: "running", phase: journal.phase, done: journal.entries.filter((entry) => entry.cutover).length, total: journal.entries.length, migrated: journal.entries.filter((entry) => entry.cutover).length, failed: 0, error: null };
    journal.progress = { ...progress };
    await saveJournal(journal);
    admit();
    admitted = true;
    for (const entry of journal.entries) {
      if (entry.cutover) continue;
      try {
        const sourceStat = await lstat(entry.source).catch(() => null);
        if (sourceStat && (!sourceStat.isFile() || sourceStat.isSymbolicLink())) throw new Error("Unsafe legacy source");
        const sourceExists = Boolean(sourceStat);
        if (sourceExists && await fileHash(entry.source) !== entry.digest) throw new Error("Legacy recording changed since migration was journaled");
        for (const destination of entry.destinations) {
          const parts = relative(journal.root, destination).split(sep);
          let current = journal.root;
          for (const part of parts.slice(0, -1)) {
            current = join(current, part);
            const parentStat = await lstat(current).catch(() => null);
            if (parentStat?.isSymbolicLink() || (parentStat && !parentStat.isDirectory())) throw new Error("Unsafe destination parent");
          }
          const existingDestination = await lstat(destination).catch(() => null);
          if (existingDestination) {
            if (!existingDestination.isFile() || existingDestination.isSymbolicLink() || await fileHash(destination) !== entry.digest) throw Object.assign(new Error(`Destination already exists or changed: ${destination}`), { code: "DESTINATION_EXISTS" });
            if (!entry.published.includes(destination)) entry.published.push(destination);
            await saveJournal(journal);
            continue;
          }
          if (!sourceExists) throw new Error("Legacy source is missing before publication completed");
          if (entry.published.includes(destination)) throw new Error(`Published recording missing: ${destination}`);
          await publish(entry.source, destination, entry.digest);
          entry.published.push(destination);
          await saveJournal(journal);
        }
        await db.transaction(async (tx) => {
          for (const reference of entry.references) {
            const row = await tx.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, reference.sessionId)).get();
            if (!row) continue;
            if (resolve(row.rawFile ?? "") === resolve(reference.oldPath)) await tx.update(sessions).set({ rawFile: reference.newPath }).where(eq(sessions.id, reference.sessionId)).run();
            else if (resolve(row.rawFile ?? "") !== resolve(reference.newPath)) throw new Error("Session recording reference changed during migration");
          }
        });
        for (const target of entry.destinations) if (await fileHash(target) !== entry.digest) throw new Error(`Published recording changed: ${target}`);
        for (const reference of entry.references) for (const lap of await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, reference.sessionId)).all()) cacheDelete(lap.id);
        clearSessionCaptureCache();
        if (sourceExists) await unlink(entry.source);
        entry.cutover = true;
        progress.migrated++;
        await rmdir(dirname(entry.source)).catch(() => undefined);
      } catch (error) { progress.failed++; progress.error = error instanceof Error ? error.message : "Layout migration failed"; }
      progress.done++;
      journal.progress = { ...progress };
      await saveJournal(journal);
    }
    if (progress.failed) { progress.status = "partial"; journal.progress = { ...progress }; await saveJournal(journal); return; }
    journal.phase = "relocating";
    progress.phase = "relocating";
    journal.progress = { ...progress };
    await saveJournal(journal);
    if (journal.destination !== journal.root) await relocateRecordingDirectoryUnderReservation(journal.destination);
    progress.status = "success";
    progress.phase = null;
    journal.progress = { ...progress };
    await unlink(journalFile);
  }).catch(async (error) => {
    progress.status = "error";
    progress.error = error instanceof Error ? error.message : "Layout migration failed";
    if (!admitted) {
      admissionError = error;
      admissionFailed = true;
    }
    try {
      const journal = await readJournal();
      if (journal) {
        journal.progress = { ...progress };
        await saveJournal(journal);
      }
    } catch {
      // Admission rejection must not depend on failure-state persistence.
    }
  }).finally(() => {
    release();
    active = false;
    if (progress.status === "success" && !admissionFailed) notifyLayoutMigrationComplete();
    if (admissionFailed) rejectAdmission(admissionError);
  });
  await admission;
}
