import { lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { persistRecordingJournal, publishRecordingFile, readValidatedLayoutMigrationJournal, cleanupVerifiedRecordingSource } from "@raceiq/recording-storage/operations";
import { hashRecordingFile, isRecordingCaptureName as isCapture, isRecordingPathContained as inside, canonicalRecordingPath as canonicalFilesystemPath, isLegacyRecordingCandidate as isLegacyCandidateFile, findLegacyRecordingFiles } from "@raceiq/recording-storage/filesystem";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { getAllGames } from "@raceiq/shared/games/registry";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";
import { getRecordingDirectoryMoveStatus, preflightRecordingDirectoryMove, recoverRecordingDirectoryMove, relocateRecordingDirectoryUnderReservation } from "./relocate-recordings";
import { reserveRecordingStorageOperation, registerLayoutMigrationPendingCheck } from "@raceiq/backend-core/session-capture/storage-activity";
import { isSessionActive } from "@raceiq/backend-core/telemetry/live-pipeline";
import { clearSessionCaptureCache } from "@raceiq/backend-core/session-capture/source-loader";
import { cacheDelete } from "@raceiq/backend-core/db/telemetry-replay-storage";
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
async function fileHash(path: string): Promise<string> { return (await hashRecordingFile(path)).sha256; }
function expectedDestination(root: string, source: string, owner: string, game: string): string {
  return resolve(join(root, game, owner === "others" ? "others" : "own", basename(source)));
}

async function readJournal(): Promise<Journal | null> {
  return await readValidatedLayoutMigrationJournal(journalFile, {
    currentDirectory: resolveRecordingDirectory(),
    knownGames: new Set<string>(getAllGames().map((game) => game.id)),
    isReferenced: async (reference, entry, parsed) => {
      const row = await db.select({ gameId: sessions.gameId, ownership: sessions.ownership, rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, reference.sessionId)).get();
      if (row && expectedDestination(parsed.root, reference.oldPath, row.ownership, row.gameId) !== reference.newPath) return false;
      if (!isCapture(basename(entry.source)) && row && (row.rawFile === reference.oldPath || row.rawFile === reference.newPath
        || row.rawFile === expectedDestination(parsed.destination ?? parsed.root, reference.oldPath, row.ownership, row.gameId))) return true;
      return false;
    },
  }) as Journal | null;
}
async function saveJournal(journal: Journal): Promise<void> {
  await persistRecordingJournal(journalFile, journal);
}
async function buildEntries(): Promise<JournalEntry[]> {
  const root = resolveRecordingDirectory();
  const legacy = await findLegacyRecordingFiles(root, new Set<string>(getAllGames().map((game) => game.id)));
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
registerLayoutMigrationPendingCheck(hasPendingLayoutMigration);
export async function isLayoutMigrationReadyForStartup(): Promise<boolean> {
  const generation = migrationGeneration;
  const blocked = () => active || progress.status === "running" || progress.status === "partial" || progress.status === "error";
  if (blocked()) return false;
  if (await readJournal()) return false;
  const move = getRecordingDirectoryMoveStatus();
  if (move.state === "moving" || move.state === "error") return false;
  const root = resolveRecordingDirectory();
  if ((await findLegacyRecordingFiles(root, new Set<string>(getAllGames().map((game) => game.id)))).length) return false;
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
  await publishRecordingFile(source, target, digest, async (path) => (await fileHash(path)));
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
        if (sourceExists) await cleanupVerifiedRecordingSource(dirname(dirname(entry.source)), entry.source, entry.digest, fileHash);
        entry.cutover = true;
        progress.migrated++;
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
