import { randomUUID } from "node:crypto";
import { unlink, stat, rename } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import type { SessionCleanupGameSummary, SessionCleanupPreview, SessionCleanupRequest, SessionCleanupResult } from "@raceiq/shared/racing/sessions/cleanup";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { db } from "../db/index";
import { dashboardSummaryState, laps, sessions, sessionCaptureSplitJobs } from "../db/schema";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { isOwnedSessionRawFile } from "../db/session-queries";
import { isSessionActive } from "../telemetry/live-pipeline";
import { clearSessionCaptureCache, loadCaptureManifest } from "./source-loader";
import { loadReferencedCapturePaths, withSessionCaptureMaintenanceLock } from "./cleanup";
import { releaseDashboardCaptureCheckpoint, republishPersistedDashboardCaptureFacts } from "./dashboard-processor";
import { dirname, resolve } from "node:path";

export class SessionCleanupBusyError extends Error {
  constructor() {
    super("Cannot clean session captures while a session is active");
    this.name = "SessionCleanupBusyError";
  }
}

type SessionRow = {
  id: number;
  createdAt: string;
  rawFile: string | null;
  captureLayoutVersion: number | null;
  captureManifestFile: string | null;
  isFavorite: boolean;
  gameId: SessionCleanupGameSummary["gameId"];
  carId: string;
  trackId: string;
};

type LapFavoriteRow = { sessionId: number; isFavorite: boolean };

type LapCaptureRef = {
  id: number;
  captureChunkId: string | null;
  sourceFrameStart: number | null;
  sourceFrameCount: number | null;
};

type SplitJobRef = typeof sessionCaptureSplitJobs.$inferSelect;

type CleanupGroup = {
  path: string;
  rows: SessionRow[];
  missing: boolean;
  size: number;
  lapRefs: LapCaptureRef[];
  jobRefs: SplitJobRef[];
  bundleFiles: string[];
  bundleBytes: number;
};

type CleanupPlan = SessionCleanupPreview & { groups: CleanupGroup[] };

function normalizeSelectedIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

async function loadRows(request: SessionCleanupRequest): Promise<{
  requested: SessionRow[];
  all: SessionRow[];
  favoriteSessions: Set<number>;
}> {
  const all = (await db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      rawFile: sessions.rawFile,
      captureLayoutVersion: sessions.captureLayoutVersion,
      captureManifestFile: sessions.captureManifestFile,
      isFavorite: sessions.isFavorite,
      gameId: sessions.gameId,
      carId: sessions.carId,
      trackId: sessions.trackId,
    })
    .from(sessions)
    .all()) as SessionRow[];

  const ids = request.mode === "selected" ? new Set(normalizeSelectedIds(request.sessionIds)) : null;
  const cutoffMs = request.mode === "older-than" ? Date.now() - request.olderThanDays * 24 * 60 * 60 * 1000 : null;
  const requested = all.filter((row) => (ids ? ids.has(row.id) : Date.parse(row.createdAt) < cutoffMs!));
  const favoriteSessions = new Set<number>(all.filter((row) => row.isFavorite).map((row) => row.id));
  const favoriteLaps = (await db
    .select({ sessionId: laps.sessionId, isFavorite: laps.isFavorite })
    .from(laps)
    .where(sql`${laps.isFavorite} = 1`)
    .all()) as LapFavoriteRow[];
  for (const lap of favoriteLaps) favoriteSessions.add(lap.sessionId);
  return { requested, all, favoriteSessions };
}

async function fileState(rawFile: string): Promise<{ path: string; missing: boolean; size: number } | null> {
  if (!isOwnedSessionRawFile(rawFile)) return null;
  const path = resolve(rawFile);
  try {
    const info = await stat(path);
    if (!info.isFile()) return { path, missing: true, size: 0 };
    return { path, missing: false, size: info.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { path, missing: true, size: 0 };
    throw error;
  }
}

async function unsharedBundleFiles(rows: SessionRow[]): Promise<{ files: string[]; bytes: number }> {
  const ids = new Set(rows.map((row) => row.id));
  const external = (await db.select({ id: sessions.id, manifestFile: sessions.captureManifestFile }).from(sessions).all())
    .filter((row) => !ids.has(row.id) && row.manifestFile != null);
  const candidates = new Set<string>();
  const externallyReferenced = new Set<string>();
  const collect = async (manifestFile: string, target: Set<string>) => {
    const manifestPath = resolve(manifestFile);
    target.add(manifestPath);
    try {
      const manifest = await loadCaptureManifest(manifestPath);
      for (const chunk of manifest.chunks) target.add(resolve(dirname(manifestPath), chunk.path));
    } catch {
      // Unknown members remain untouched if manifest cannot be parsed.
    }
  };
  for (const row of rows) if (row.captureManifestFile) await collect(row.captureManifestFile, candidates);
  for (const row of external) if (row.manifestFile) await collect(row.manifestFile, externallyReferenced);
  const files: string[] = [];
  let bytes = 0;
  for (const path of candidates) {
    if (externallyReferenced.has(path) || !isOwnedSessionRawFile(path)) continue;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push(path);
      bytes += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { files, bytes };
}

async function buildGameSummaries(groups: CleanupGroup[]): Promise<SessionCleanupGameSummary[]> {
  const candidateSessions = groups.flatMap((group) => group.rows);
  const availableGroups = groups.filter((group) => !group.missing || group.bundleFiles.length > 0);
  const candidateIds = candidateSessions.map((session) => session.id);
  const candidateLaps =
    candidateIds.length === 0
      ? []
      : await db
          .select({
            id: laps.id,
            sessionId: laps.sessionId,
            lapNumber: laps.lapNumber,
            lapTime: laps.lapTime,
            isValid: laps.isValid,
          })
          .from(laps)
          .where(inArray(laps.sessionId, candidateIds))
          .orderBy(laps.sessionId, laps.lapNumber)
          .all();
  const lapsBySession = new Map<number, typeof candidateLaps>();
  for (const lap of candidateLaps) {
    const sessionLaps = lapsBySession.get(lap.sessionId) ?? [];
    sessionLaps.push({ ...lap, isValid: Boolean(lap.isValid) });
    lapsBySession.set(lap.sessionId, sessionLaps);
  }

  return [...new Set(candidateSessions.map((session) => session.gameId))]
    .map((gameId) => {
      const adapter = tryGetGame(gameId);
      const gameSessions = candidateSessions
        .filter((session) => session.gameId === gameId)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          trackName: adapter?.getTrackName(session.trackId) ?? resolveTrackName(session.trackId, gameId),
          carName: adapter?.getCarName(session.carId) ?? resolveCarName(session.carId, gameId),
          laps: lapsBySession.get(session.id) ?? [],
        }));

      return {
        gameId,
        gameName: adapter?.shortName ?? gameId,
        sessionCount: gameSessions.length,
        reclaimableBytes: availableGroups.filter((group) => group.rows.some((session) => session.gameId === gameId)).reduce((sum, group) => sum + (group.missing ? 0 : group.size) + group.bundleBytes, 0),
        sessions: gameSessions,
      };
    })
    .sort((left, right) => left.gameName.localeCompare(right.gameName));
}

async function buildPlan(request: SessionCleanupRequest): Promise<CleanupPlan> {
  const { requested, all, favoriteSessions } = await loadRows(request);
  const activeJobs = await db.select({ sessionId: sessionCaptureSplitJobs.sessionId })
    .from(sessionCaptureSplitJobs)
    .where(inArray(sessionCaptureSplitJobs.status, ["queued", "splitting", "verifying", "publishing"]))
    .all();
  const activeJobIds = new Set(activeJobs.map(({ sessionId }) => sessionId));
  const protectedIds = new Set<number>(requested.filter((row) =>
    favoriteSessions.has(row.id) || activeJobIds.has(row.id),
  ).map((row) => row.id));
  const unavailableIds = new Set<number>();
  if (request.mode === "selected") {
    const existingIds = new Set(all.map((row) => row.id));
    for (const id of normalizeSelectedIds(request.sessionIds)) {
      if (!existingIds.has(id)) unavailableIds.add(id);
    }
  }
  const groupsByPath = new Map<string, { all: SessionRow[]; requested: SessionRow[] }>();
  const requestedIds = new Set(requested.map((row) => row.id));

  for (const row of all) {
    const key = row.rawFile
      ? resolve(row.rawFile)
      : row.captureManifestFile
        ? `bundle:${resolve(row.captureManifestFile)}`
        : null;
    if (key === null) continue;
    let group = groupsByPath.get(key);
    if (!group) {
      group = { all: [], requested: [] };
      groupsByPath.set(key, group);
    }
    group.all.push(row);
    if (requestedIds.has(row.id)) group.requested.push(row);
  }

  const groups: CleanupGroup[] = [];
  const plannedKeys = new Set<string>();
  for (const row of requested) {
    const isProtected = protectedIds.has(row.id);
    const state = row.rawFile
      ? await fileState(row.rawFile)
      : row.captureManifestFile && isOwnedSessionRawFile(row.captureManifestFile)
        ? { path: resolve(row.captureManifestFile), missing: true, size: 0 }
        : null;
    if (!state) {
      unavailableIds.add(row.id);
      continue;
    }
    if (isProtected) continue;
    const key = row.rawFile ? state.path : `bundle:${state.path}`;
    const group = groupsByPath.get(key);
    if (!group || group.requested.length !== group.all.length ||
      group.all.some((ref) => favoriteSessions.has(ref.id) || activeJobIds.has(ref.id))) {
      unavailableIds.add(row.id);
      continue;
    }
    if (!plannedKeys.has(key)) {
      const lapRefs = await db.select({
        id: laps.id,
        captureChunkId: laps.captureChunkId,
        sourceFrameStart: laps.sourceFrameStart,
        sourceFrameCount: laps.sourceFrameCount,
      }).from(laps).where(inArray(laps.sessionId, group.all.map((session) => session.id))).all();
      const jobRefs = await db.select().from(sessionCaptureSplitJobs)
        .where(inArray(sessionCaptureSplitJobs.sessionId, group.all.map((session) => session.id))).all();
      const bundle = await unsharedBundleFiles(group.all);
      groups.push({
        path: state.path, rows: group.all, missing: state.missing, size: state.size, lapRefs, jobRefs,
        bundleFiles: bundle.files, bundleBytes: bundle.bytes,
      });
      plannedKeys.add(key);
    }
  }

  const candidateSessionIds = groups.flatMap((group) => group.rows.map((row) => row.id));
  return {
    candidateSessionIds: candidateSessionIds.sort((a, b) => a - b),
    protectedSessionIds: [...protectedIds].sort((a, b) => a - b),
    unavailableSessionIds: [...unavailableIds].sort((a, b) => a - b),
    fileCount: groups.reduce((sum, group) => sum + (group.missing ? 0 : 1) + group.bundleFiles.length, 0),
    reclaimableBytes: groups.reduce((sum, group) => sum + (group.missing ? 0 : group.size) + group.bundleBytes, 0),
    games: await buildGameSummaries(groups),
    groups,
  };
}
function previewOnly(plan: CleanupPlan): SessionCleanupPreview {
  const { groups: _groups, ...preview } = plan;
  return preview;
}

export async function previewSessionCleanup(request: SessionCleanupRequest): Promise<SessionCleanupPreview> {
  return previewOnly(await buildPlan(request));
}

async function setRawFiles(values: SessionRow[], clear: boolean, lapRefs: LapCaptureRef[] = [], jobRefs: SplitJobRef[] = []): Promise<void> {
  await db.transaction(async (tx) => {
    for (const value of values) {
      await tx.update(sessions).set(clear
        ? { rawFile: null, captureLayoutVersion: null, captureManifestFile: null }
        : { rawFile: value.rawFile, captureLayoutVersion: value.captureLayoutVersion, captureManifestFile: value.captureManifestFile })
        .where(eq(sessions.id, value.id)).run();
    }
    const ids = values.map(({ id }) => id);
    if (clear) {
      await tx.update(laps).set({ captureChunkId: null, sourceFrameStart: null, sourceFrameCount: null })
        .where(inArray(laps.sessionId, ids)).run();
      await tx.delete(sessionCaptureSplitJobs).where(inArray(sessionCaptureSplitJobs.sessionId, ids)).run();
    } else {
      for (const lap of lapRefs) {
        await tx.update(laps).set({
          captureChunkId: lap.captureChunkId,
          sourceFrameStart: lap.sourceFrameStart,
          sourceFrameCount: lap.sourceFrameCount,
        }).where(eq(laps.id, lap.id)).run();
      }
      for (const job of jobRefs) await tx.insert(sessionCaptureSplitJobs).values(job).run();
    }
    await tx.update(dashboardSummaryState).set({ captureReady: 0 }).where(inArray(dashboardSummaryState.sessionId, ids)).run();
  });
  const ids = values.map(({ id }) => id);
  if (ids.length && !await republishPersistedDashboardCaptureFacts(ids)) {
    for (const sessionId of ids) await releaseDashboardCaptureCheckpoint(sessionId);
  }
}

async function restoreGroup(group: CleanupGroup): Promise<void> {
  await setRawFiles(group.rows, false, group.lapRefs, group.jobRefs);
}

async function evictGroupCaches(group: CleanupGroup): Promise<void> {
  const ids = group.rows.map((row) => row.id);
  const lapRows = await db.select({ id: laps.id }).from(laps).where(inArray(laps.sessionId, ids)).all();
  for (const lap of lapRows) cacheDelete(lap.id);
  const rawFiles = new Set(group.rows.map((row) => row.rawFile).filter((rawFile): rawFile is string => rawFile != null));
  rawFiles.add(group.path);
  for (const rawFile of rawFiles) clearSessionCaptureCache(rawFile);
}

class BundleDeletionError extends Error {
  readonly files: number;
  readonly bytes: number;
  constructor(message: string, files: number, bytes: number) {
    super(message);
    this.name = "BundleDeletionError";
    this.files = files;
    this.bytes = bytes;
  }
}

async function deleteUnreferencedBundles(group: CleanupGroup): Promise<{ files: number; bytes: number }> {
  const referenced = await loadReferencedCapturePaths();
  const candidates = await unsharedBundleFiles(group.rows);
  let files = 0;
  let bytes = 0;
  for (const path of candidates.files) {
    if (referenced.has(path)) continue;
    try {
      const info = await stat(path);
      await unlink(path);
      files++;
      bytes += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new BundleDeletionError(error instanceof Error ? error.message : String(error), files, bytes);
    }
  }
  return { files, bytes };
}

type CleanupGroupResult = { deleted: boolean; files: number; bytes: number; residualError?: string };

async function executeGroup(group: CleanupGroup): Promise<CleanupGroupResult> {
  if (group.missing) {
    try {
      await setRawFiles(group.rows, true);
    } catch (error) {
      await restoreGroup(group);
      throw error;
    }
    let bundles = { files: 0, bytes: 0 };
    let residualError: string | undefined;
    try {
      bundles = await deleteUnreferencedBundles(group);
    } catch (error) {
      if (!(error instanceof BundleDeletionError)) throw error;
      bundles = { files: error.files, bytes: error.bytes };
      residualError = error.message;
    } finally {
      try {
        await evictGroupCaches(group);
      } catch (error) {
        console.warn("[Cleanup] Failed to evict capture caches:", error);
      }
    }
    return { deleted: false, ...bundles, ...(residualError ? { residualError } : {}) };
  }

  const staged = `${group.path}.cleanup-${randomUUID()}`;
  let stagedReady = false;
  try {
    await rename(group.path, staged);
    stagedReady = true;
    await setRawFiles(group.rows, true);
    try {
      await unlink(staged);
    } catch (error) {
      await restoreGroup(group);
      await rename(staged, group.path);
      stagedReady = false;
      throw error;
    }
    stagedReady = false;
    let bundles = { files: 0, bytes: 0 };
    let residualError: string | undefined;
    try {
      bundles = await deleteUnreferencedBundles(group);
    } catch (error) {
      if (!(error instanceof BundleDeletionError)) throw error;
      bundles = { files: error.files, bytes: error.bytes };
      residualError = error.message;
    } finally {
      try {
        await evictGroupCaches(group);
      } catch (error) {
        console.warn("[Cleanup] Failed to evict capture caches:", error);
      }
    }
    return { deleted: true, files: 1 + bundles.files, bytes: group.size + bundles.bytes, ...(residualError ? { residualError } : {}) };
  } catch (error) {
    if (stagedReady) {
      try {
        await restoreGroup(group);
      } catch {
        // Keep original failure as the per-group report.
      }
      try {
        await rename(staged, group.path);
      } catch {
        // Keep original failure as the per-group report.
      }
    }
    throw error;
  }
}


export async function executeSessionCleanup(request: SessionCleanupRequest): Promise<SessionCleanupResult> {
  if (isSessionActive()) throw new SessionCleanupBusyError();
  return withSessionCaptureMaintenanceLock(async () => {
    if (isSessionActive()) throw new SessionCleanupBusyError();
    const workPlan = await buildPlan(request);
    const cleanedSessionIds: number[] = [];
    const failed: { sessionIds: number[]; message: string }[] = [];
    let deletedFiles = 0;
    let freedBytes = 0;
    for (const group of workPlan.groups) {
      if (isSessionActive()) throw new SessionCleanupBusyError();
      let groupResult: CleanupGroupResult;
      try {
        groupResult = await executeGroup(group);
      } catch (error) {
        failed.push({
          sessionIds: group.rows.map((row) => row.id),
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      cleanedSessionIds.push(...group.rows.map((row) => row.id));
      deletedFiles += groupResult.files;
      freedBytes += groupResult.bytes;
      if (groupResult.residualError) {
        failed.push({ sessionIds: group.rows.map((row) => row.id), message: groupResult.residualError });
      }
    }
    return {
      ...previewOnly(workPlan),
      cleanedSessionIds: [...new Set(cleanedSessionIds)].sort((a, b) => a - b),
      deletedFiles,
      freedBytes,
      failed,
    };
  });
}
