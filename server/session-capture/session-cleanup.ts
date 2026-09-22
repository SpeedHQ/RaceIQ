import { randomUUID } from "node:crypto";
import { stat, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, sql, inArray } from "drizzle-orm";
import { db } from "../db";
import { laps, sessions } from "../db/schema";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { isSessionActive } from "../telemetry/live-pipeline";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { clearSessionCaptureCache } from "./source-loader";
import { isOwnedSessionRawFile } from "../db/session-queries";
import { tryGetGame } from "../../shared/games/registry";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import type { SessionCleanupGameSummary, SessionCleanupPreview, SessionCleanupRequest, SessionCleanupResult } from "../../shared/racing/sessions/cleanup";

export class SessionCleanupBusyError extends Error {
  constructor() {
    super("Session capture cleanup cannot run while recording is active");
    this.name = "SessionCleanupBusyError";
  }
}

type SessionRow = {
  id: number;
  createdAt: string;
  rawFile: string | null;
  isFavorite: boolean;
  gameId: SessionCleanupGameSummary["gameId"];
  carOrdinal: number;
  trackOrdinal: number;
};

type LapFavoriteRow = { sessionId: number; isFavorite: boolean };

type CleanupGroup = {
  path: string;
  rows: SessionRow[];
  missing: boolean;
  size: number;
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
      isFavorite: sessions.isFavorite,
      gameId: sessions.gameId,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
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

async function buildGameSummaries(groups: CleanupGroup[]): Promise<SessionCleanupGameSummary[]> {
  const availableGroups = groups.filter((group) => !group.missing);
  const candidateSessions = availableGroups.flatMap((group) => group.rows);
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
          trackName: adapter?.getTrackName(session.trackOrdinal) ?? resolveTrackName(session.trackOrdinal, gameId),
          carName: adapter?.getCarName(session.carOrdinal) ?? resolveCarName(session.carOrdinal, gameId),
          laps: lapsBySession.get(session.id) ?? [],
        }));

      return {
        gameId,
        gameName: adapter?.shortName ?? gameId,
        sessionCount: gameSessions.length,
        reclaimableBytes: availableGroups.filter((group) => group.rows.some((session) => session.gameId === gameId)).reduce((sum, group) => sum + group.size, 0),
        sessions: gameSessions,
      };
    })
    .sort((left, right) => left.gameName.localeCompare(right.gameName));
}

async function buildPlan(request: SessionCleanupRequest, includeMissing: boolean): Promise<CleanupPlan> {
  const { requested, all, favoriteSessions } = await loadRows(request);
  const protectedIds = new Set<number>(requested.filter((row) => favoriteSessions.has(row.id)).map((row) => row.id));
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
    if (!row.rawFile) continue;
    const path = resolve(row.rawFile);
    let group = groupsByPath.get(path);
    if (!group) {
      group = { all: [], requested: [] };
      groupsByPath.set(path, group);
    }
    group.all.push(row);
    if (requestedIds.has(row.id)) group.requested.push(row);
  }

  const groups: CleanupGroup[] = [];
  for (const row of requested) {
    const isProtected = protectedIds.has(row.id);
    if (!row.rawFile) {
      unavailableIds.add(row.id);
      continue;
    }
    const state = await fileState(row.rawFile);
    if (!state) {
      unavailableIds.add(row.id);
      continue;
    }
    if (isProtected) continue;
    const group = groupsByPath.get(state.path);
    if (!group || group.requested.length !== group.all.length || group.all.some((ref) => favoriteSessions.has(ref.id))) {
      unavailableIds.add(row.id);
      continue;
    }
    if (state.missing) {
      unavailableIds.add(row.id);
      if (!includeMissing) continue;
    }
    if (!groups.some((candidate) => candidate.path === state.path)) {
      groups.push({ path: state.path, rows: group.all, missing: state.missing, size: state.size });
    }
  }

  const candidateSessionIds = groups.filter((group) => !group.missing).flatMap((group) => group.rows.map((row) => row.id));
  return {
    candidateSessionIds: candidateSessionIds.sort((a, b) => a - b),
    protectedSessionIds: [...protectedIds].sort((a, b) => a - b),
    unavailableSessionIds: [...unavailableIds].sort((a, b) => a - b),
    fileCount: groups.filter((group) => !group.missing).length,
    reclaimableBytes: groups.filter((group) => !group.missing).reduce((sum, group) => sum + group.size, 0),
    games: await buildGameSummaries(groups),
    groups,
  };
}
function previewOnly(plan: CleanupPlan): SessionCleanupPreview {
  const { groups: _groups, ...preview } = plan;
  return preview;
}

export async function previewSessionCleanup(request: SessionCleanupRequest): Promise<SessionCleanupPreview> {
  return previewOnly(await buildPlan(request, false));
}

async function setRawFiles(values: { id: number; rawFile: string | null }[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const value of values) {
      await tx.update(sessions).set({ rawFile: value.rawFile }).where(eq(sessions.id, value.id)).run();
    }
  });
}

async function restoreGroup(group: CleanupGroup): Promise<void> {
  await setRawFiles(group.rows.map((row) => ({ id: row.id, rawFile: row.rawFile })));
}

async function evictGroupCaches(group: CleanupGroup): Promise<void> {
  const ids = group.rows.map((row) => row.id);
  const lapRows = await db.select({ id: laps.id }).from(laps).where(inArray(laps.sessionId, ids)).all();
  for (const lap of lapRows) cacheDelete(lap.id);
  const rawFiles = new Set(group.rows.map((row) => row.rawFile).filter((rawFile): rawFile is string => rawFile != null));
  rawFiles.add(group.path);
  for (const rawFile of rawFiles) clearSessionCaptureCache(rawFile);
}

async function executeGroup(group: CleanupGroup): Promise<{ deleted: boolean; bytes: number }> {
  if (group.missing) {
    await setRawFiles(group.rows.map((row) => ({ id: row.id, rawFile: null })));
    try {
      await evictGroupCaches(group);
    } catch (error) {
      console.warn("[Cleanup] Failed to evict capture caches:", error);
    }
    return { deleted: false, bytes: 0 };
  }

  const staged = `${group.path}.cleanup-${randomUUID()}`;
  let stagedReady = false;
  try {
    await rename(group.path, staged);
    stagedReady = true;
    await setRawFiles(group.rows.map((row) => ({ id: row.id, rawFile: null })));
    try {
      await unlink(staged);
    } catch (error) {
      await restoreGroup(group);
      await rename(staged, group.path);
      stagedReady = false;
      throw error;
    }
    stagedReady = false;
    try {
      await evictGroupCaches(group);
    } catch (error) {
      console.warn("[Cleanup] Failed to evict capture caches:", error);
    }
    return { deleted: true, bytes: group.size };
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
    const workPlan = await buildPlan(request, true);
    const cleanedSessionIds: number[] = [];
    const failed: { sessionIds: number[]; message: string }[] = [];
    let deletedFiles = 0;
    let freedBytes = 0;
    for (const group of workPlan.groups) {
      if (isSessionActive()) throw new SessionCleanupBusyError();
      try {
        const result = await executeGroup(group);
        cleanedSessionIds.push(...group.rows.map((row) => row.id));
        if (result.deleted) deletedFiles++;
        freedBytes += result.bytes;
      } catch (error) {
        failed.push({
          sessionIds: group.rows.map((row) => row.id),
          message: error instanceof Error ? error.message : String(error),
        });
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
