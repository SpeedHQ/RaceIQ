import { MOTEC_SESSION_SOURCE } from "@raceiq/shared/integrations/motec";
import { resolveRecordingDirectory } from "../runtime/config/recording-directory";
import { createHash, randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getRecordedElapsedSeconds } from "../session-capture/elapsed-duration";
import { cacheDelete } from "./telemetry-replay-storage";
import { eq, desc, and, or, sql, inArray, notInArray, isNull, lt, asc } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, sessionResults, pitEvents, sessionCaptureSplitJobs, liveCaptures } from "./schema";
import { withSessionCaptureMaintenanceLock } from "../session-capture/cleanup";
import type { SessionMeta, SessionOwnership, SessionCaptureSplitPhase, SessionCaptureSplitErrorCode } from "@raceiq/shared/racing/sessions/types";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { getTrackLengthMetersById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import type { RecapLapInput, RecapSessionInput } from "../lap-analysis/recap";
import { getLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import { wsManager } from "../runtime/websocket-manager";
import type { SessionCaptureSplitStatus } from "@raceiq/shared/racing/sessions/types";
import { getLapById } from "./lap-read-queries";
import type { PublishedManifest } from "@raceiq/capture-splitting";
import { clearCaptureManifestCache, loadCaptureManifest } from "../session-capture/source-loader";
import { recoverLiveCaptureStorage } from "../session-capture/live-recovery";

export interface SessionCaptureSplitWork {
  sessionId: number;
  jobId: string;
  attemptId: number;
  sourceRevision: string;
  sourcePath: string;
  gameId: GameId;
  carId: string;
  trackId: string;
  windows: { lapId: string; lapNumber: number; startByteOffset: number; frameCount: number }[];
  ownership: SessionOwnership;
  captureManifestFile?: string | null;
  captureLayoutVersion?: number | null;
  captureArchiveFile?: string | null;
  captureFormatVersion?: number | null;
  currentRawFile?: string | null;

}

async function notifySessionCaptureSplitStatus(sessionId: number): Promise<void> {
  try {
    const job = await db.select({
      jobId: sessionCaptureSplitJobs.jobId,
      attemptId: sessionCaptureSplitJobs.attemptId,
      sequence: sessionCaptureSplitJobs.sequence,
      phase: sessionCaptureSplitJobs.status,
      processedSourceFrames: sessionCaptureSplitJobs.processedSourceFrames,
      totalSourceFrames: sessionCaptureSplitJobs.totalSourceFrames,
      completedLapArtifacts: sessionCaptureSplitJobs.completedLapArtifacts,
      totalLapArtifacts: sessionCaptureSplitJobs.totalLapArtifacts,
      errorCode: sessionCaptureSplitJobs.errorCode,
    }).from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get();
    if (!job) return;
    const status: SessionCaptureSplitStatus = {
      sessionId, jobId: job.jobId, attemptId: job.attemptId, sequence: job.sequence,
      phase: job.phase as SessionCaptureSplitPhase,
      ...(job.processedSourceFrames == null ? {} : { processedSourceFrames: job.processedSourceFrames }),
      ...(job.totalSourceFrames == null ? {} : { totalSourceFrames: job.totalSourceFrames }),
      completedLapArtifacts: job.completedLapArtifacts, totalLapArtifacts: job.totalLapArtifacts,
      ...(job.errorCode == null ? {} : { errorCode: job.errorCode as SessionCaptureSplitErrorCode }),
    };
    wsManager.broadcastSessionCaptureSplitProgress(status);
  } catch (error) {
    // Delivery failure cannot undo a committed publication or remove its artifacts.
    // Clients reload authoritative snapshots when reconnecting.
    console.error(`[CaptureSplit] Committed status notification failed for session ${sessionId}:`, error);
  }
}

/** Queue an eligible closed BIN; ownership and provenance do not alter frame ownership. */
export async function enqueueSessionCaptureSplit(sessionId: number): Promise<boolean> {
  return withSessionCaptureMaintenanceLock(async () => {
    const row = await db.select({
      rawFile: sessions.rawFile, gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId,
      captureLayoutVersion: sessions.captureLayoutVersion, captureManifestFile: sessions.captureManifestFile,
      captureArchiveFile: sessions.captureArchiveFile,
    }).from(sessions).where(eq(sessions.id, sessionId)).get();
    const liveCapture = await db.select({ status: liveCaptures.status }).from(liveCaptures)
      .where(eq(liveCaptures.sessionId, sessionId)).get();
    if (liveCapture && ["recording", "finalizing", "recovering"].includes(liveCapture.status)) return false;
    if (row?.captureLayoutVersion === 1 || row?.captureLayoutVersion === 3) return false;
    if (row?.captureLayoutVersion === 2 && !row.rawFile) {
      console.warn(`[CaptureSplit] Session ${sessionId} cannot migrate to per-lap files: retained source recording is unavailable; existing bundle is preserved.`);
    }
    if (!row?.rawFile || (row.captureLayoutVersion !== null && row.captureLayoutVersion !== 2) ||
        !(row.rawFile.endsWith(".bin") || row.rawFile.endsWith(".bin.gz"))) return false;
    const lapRows = await db.select({
      id: laps.id, lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount,
    }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    const windows = lapRows.filter((lap) => lap.rawByteOffset != null && lap.rawFrameCount != null && lap.rawFrameCount > 0)
      .map((lap) => ({ lapId: String(lap.id), lapNumber: lap.lapNumber, startByteOffset: lap.rawByteOffset!, frameCount: lap.rawFrameCount! }))
      .sort((a, b) => a.startByteOffset - b.startByteOffset);
    if (windows.length !== lapRows.length || windows.length === 0) return false;
    for (let i = 0; i < windows.length; i++) {
      const current = windows[i]!;
      if (!Number.isSafeInteger(current.startByteOffset) || current.startByteOffset < 0 ||
          !Number.isSafeInteger(current.frameCount) || current.frameCount < 1 ||
          !Number.isSafeInteger(current.lapNumber) || current.lapNumber < 0 ||
          (i > 0 && windows[i - 1]!.startByteOffset >= current.startByteOffset)) return false;
    }
    let info: Stats;
    try {
      info = await stat(row.rawFile);
    } catch {
      if (row.captureLayoutVersion === 2) {
        console.warn(`[CaptureSplit] Session ${sessionId} cannot migrate to per-lap files: retained source recording is unavailable; existing bundle is preserved.`);
      }
      return false;
    }
    if (!info.isFile() || info.size === 0) return false;
    const sourceRevision = getSessionCaptureSourceRevision(info, windows, row.gameId);
    const result = await db.insert(sessionCaptureSplitJobs).values({
      sessionId, jobId: randomUUID(), attemptId: 1, sequence: 0, pendingSourceRevision: sourceRevision,
      sourcePath: row.rawFile, stagingPath: null,
      status: "queued", totalLapArtifacts: windows.length, completedLapArtifacts: 0,
    }).onConflictDoUpdate({
      target: sessionCaptureSplitJobs.sessionId,
      set: {
        jobId: randomUUID(), attemptId: 1, sequence: 0, pendingSourceRevision: sourceRevision,
        sourcePath: row.rawFile, stagingPath: null, status: "queued", errorCode: null, errorMessage: null,
        processedSourceFrames: null, totalSourceFrames: null, completedLapArtifacts: 0,
        totalLapArtifacts: windows.length, updatedAt: new Date().toISOString(),
      },
      where: or(
        and(
          inArray(sessionCaptureSplitJobs.status, ["failed", "ready", "queued"]),
          sql`${sessionCaptureSplitJobs.sourcePath} <> ${row.rawFile}`,
        ),
        and(
          eq(sessionCaptureSplitJobs.status, "failed"),
          or(
            sql`${sessionCaptureSplitJobs.errorCode} <> 'worker-failed'`,
            sql`${sessionCaptureSplitJobs.pendingSourceRevision} <> ${sourceRevision}`,
          ),
        ),
        and(
          or(eq(sessionCaptureSplitJobs.status, "ready"), eq(sessionCaptureSplitJobs.status, "queued")),
          sql`${sessionCaptureSplitJobs.pendingSourceRevision} <> ${sourceRevision}`,
        ),
        row.captureLayoutVersion === 2 ? eq(sessionCaptureSplitJobs.status, "ready") : undefined,
      ),
    }).run();
    if (result.rowsAffected > 0) await notifySessionCaptureSplitStatus(sessionId);
    return result.rowsAffected > 0;
  });
}

export async function claimSessionCaptureSplitJob(work: SessionCaptureSplitWork): Promise<boolean> {
  const result = await db.update(sessionCaptureSplitJobs).set({
    status: "splitting", sequence: sql`${sessionCaptureSplitJobs.sequence} + 1`, updatedAt: new Date().toISOString(),
  }).where(and(
    eq(sessionCaptureSplitJobs.sessionId, work.sessionId),
    eq(sessionCaptureSplitJobs.jobId, work.jobId),
    eq(sessionCaptureSplitJobs.attemptId, work.attemptId),
    eq(sessionCaptureSplitJobs.pendingSourceRevision, work.sourceRevision),
    eq(sessionCaptureSplitJobs.status, "queued"),
  )).run();
  if (result.rowsAffected === 1) await notifySessionCaptureSplitStatus(work.sessionId);
  return result.rowsAffected === 1;
}

export async function setSessionCaptureSplitStagingPath(work: SessionCaptureSplitWork, stagingPath: string): Promise<boolean> {
  const result = await db.update(sessionCaptureSplitJobs).set({ stagingPath }).where(and(
    eq(sessionCaptureSplitJobs.sessionId, work.sessionId), eq(sessionCaptureSplitJobs.jobId, work.jobId),
    eq(sessionCaptureSplitJobs.attemptId, work.attemptId),
    eq(sessionCaptureSplitJobs.pendingSourceRevision, work.sourceRevision),
    eq(sessionCaptureSplitJobs.status, "splitting"),
  )).run();
  return result.rowsAffected === 1;
}

export async function failSessionCaptureSplitJob(work: SessionCaptureSplitWork, errorCode: string, errorMessage: string): Promise<void> {
  const result = await db.update(sessionCaptureSplitJobs).set({
    status: "failed", sequence: sql`${sessionCaptureSplitJobs.sequence} + 1`, errorCode, errorMessage: errorMessage.slice(0, 2000), updatedAt: new Date().toISOString(),
  }).where(and(
    eq(sessionCaptureSplitJobs.sessionId, work.sessionId), eq(sessionCaptureSplitJobs.jobId, work.jobId),
    eq(sessionCaptureSplitJobs.attemptId, work.attemptId),
    eq(sessionCaptureSplitJobs.pendingSourceRevision, work.sourceRevision),
    or(eq(sessionCaptureSplitJobs.status, "splitting"), eq(sessionCaptureSplitJobs.status, "verifying"), eq(sessionCaptureSplitJobs.status, "publishing")),
  )).run();
  if (result.rowsAffected === 1) await notifySessionCaptureSplitStatus(work.sessionId);
}


export async function validateSessionCaptureSplitRevision(work: SessionCaptureSplitWork): Promise<boolean> {
  const session = await db.select({
    rawFile: sessions.rawFile, gameId: sessions.gameId, captureLayoutVersion: sessions.captureLayoutVersion,
    captureManifestFile: sessions.captureManifestFile, captureArchiveFile: sessions.captureArchiveFile,
  }).from(sessions).where(eq(sessions.id, work.sessionId)).get();
  if (session?.rawFile !== work.sourcePath || session.gameId !== work.gameId ||
      session.captureLayoutVersion !== work.captureLayoutVersion ||
      session.captureManifestFile !== work.captureManifestFile || session.captureArchiveFile !== work.captureArchiveFile) return false;
  const rows = await db.select({
    id: laps.id, lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount,
  }).from(laps).where(eq(laps.sessionId, work.sessionId)).all();
  const windows = rows.filter((lap) => lap.rawByteOffset != null && lap.rawFrameCount != null && lap.rawFrameCount > 0)
    .map((lap) => ({ lapId: String(lap.id), lapNumber: lap.lapNumber, startByteOffset: lap.rawByteOffset!, frameCount: lap.rawFrameCount! }))
    .sort((a, b) => a.startByteOffset - b.startByteOffset);
  if (windows.length !== rows.length || JSON.stringify(windows) !== JSON.stringify(work.windows)) return false;
  const info = await stat(work.sourcePath);
  return info.isFile() && getSessionCaptureSourceRevision(info, windows, session.gameId) === work.sourceRevision;
}

export function getSessionCaptureSourceRevision(info: Stats, windows: SessionCaptureSplitWork["windows"], gameId: string): string {
  return createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${gameId}\n${JSON.stringify(windows)}`).digest("hex");
}
export async function publishSessionCaptureSplit(
  work: SessionCaptureSplitWork,
  manifestPath: string,
  manifest: PublishedManifest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (manifest.version !== 3 || manifest.gameId !== work.gameId || manifest.sourceRevision !== work.sourceRevision) return false;
  const persisted = await loadCaptureManifest(manifestPath);
  if (JSON.stringify(persisted) !== JSON.stringify(manifest)) return false;
  const chunks = manifest.chunks;
  const publicationFiles = await Promise.all(
    [manifestPath, ...chunks.map((chunk) => join(dirname(manifestPath), chunk.path))].map(async (path) => {
      try { return (await stat(path)).isFile(); } catch { return false; }
    }),
  );
  if (publicationFiles.some((isFile) => !isFile)) return false;
  signal?.throwIfAborted();
  const published = await db.transaction(async (tx) => {
    const job = await tx.select({ status: sessionCaptureSplitJobs.status }).from(sessionCaptureSplitJobs).where(and(
      eq(sessionCaptureSplitJobs.sessionId, work.sessionId), eq(sessionCaptureSplitJobs.jobId, work.jobId),
      eq(sessionCaptureSplitJobs.attemptId, work.attemptId),
      eq(sessionCaptureSplitJobs.pendingSourceRevision, work.sourceRevision),
      eq(sessionCaptureSplitJobs.status, "publishing"),
    )).get();
    const session = await tx.select({
      rawFile: sessions.rawFile, gameId: sessions.gameId, captureLayoutVersion: sessions.captureLayoutVersion,
      captureManifestFile: sessions.captureManifestFile, captureArchiveFile: sessions.captureArchiveFile,
    }).from(sessions).where(eq(sessions.id, work.sessionId)).get();
    const currentRows = await tx.select({
      id: laps.id, lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount,
    }).from(laps).where(eq(laps.sessionId, work.sessionId)).all();
    const currentWindows = currentRows.filter((lap) => lap.rawByteOffset != null && lap.rawFrameCount != null && lap.rawFrameCount > 0)
      .map((lap) => ({ lapId: String(lap.id), lapNumber: lap.lapNumber, startByteOffset: lap.rawByteOffset!, frameCount: lap.rawFrameCount! }))
      .sort((a, b) => a.startByteOffset - b.startByteOffset);
    if (!job || session?.rawFile !== work.sourcePath || session.gameId !== work.gameId ||
        session.captureLayoutVersion !== work.captureLayoutVersion ||
        session.captureManifestFile !== work.captureManifestFile || session.captureArchiveFile !== work.captureArchiveFile ||
        currentWindows.length !== currentRows.length || JSON.stringify(currentWindows) !== JSON.stringify(work.windows)) return false;
    let sourceInfo: Stats;
    try { sourceInfo = await stat(work.sourcePath); } catch { return false; }
    if (!sourceInfo.isFile() || getSessionCaptureSourceRevision(sourceInfo, currentWindows, session.gameId) !== work.sourceRevision) return false;
    const lapChunks = chunks.filter((chunk) => chunk.lapId != null);
    const expectedLapIds = new Set(work.windows.map((window) => window.lapId));
    if (lapChunks.length !== expectedLapIds.size || lapChunks.some((chunk) => !expectedLapIds.has(chunk.lapId!)) ||
        new Set(lapChunks.map((chunk) => chunk.lapId)).size !== expectedLapIds.size) return false;
    for (const chunk of lapChunks) {
      if (chunk.ownedFrameByteOffset == null || chunk.ownedFrameCount == null) return false;
      const lapId = Number(chunk.lapId);
      if (!Number.isSafeInteger(lapId)) return false;
      const updated = await tx.update(laps).set({
        captureChunkId: chunk.id, sourceFrameStart: null, sourceFrameCount: chunk.ownedFrameCount,
      }).where(and(eq(laps.id, lapId), eq(laps.sessionId, work.sessionId))).run();
      if (updated.rowsAffected !== 1) throw new Error(`Lap ${lapId} changed during split publication`);
    }
    const sessionUpdated = await tx.update(sessions).set({
      captureLayoutVersion: 1, captureManifestFile: manifestPath, captureArchiveFile: null,
    }).where(and(eq(sessions.id, work.sessionId), eq(sessions.rawFile, work.sourcePath),
      eq(sessions.gameId, work.gameId), work.captureLayoutVersion == null
        ? isNull(sessions.captureLayoutVersion)
        : eq(sessions.captureLayoutVersion, work.captureLayoutVersion),
      work.captureManifestFile == null ? isNull(sessions.captureManifestFile) : eq(sessions.captureManifestFile, work.captureManifestFile),
      work.captureArchiveFile == null ? isNull(sessions.captureArchiveFile) : eq(sessions.captureArchiveFile, work.captureArchiveFile))).run();
    if (sessionUpdated.rowsAffected !== 1) throw new Error("Session source changed during split publication");
    const jobUpdated = await tx.update(sessionCaptureSplitJobs).set({
      status: "ready", sequence: sql`${sessionCaptureSplitJobs.sequence} + 1`, stagingPath: null, completedLapArtifacts: lapChunks.length,
    }).where(and(
      eq(sessionCaptureSplitJobs.sessionId, work.sessionId), eq(sessionCaptureSplitJobs.jobId, work.jobId),
      eq(sessionCaptureSplitJobs.attemptId, work.attemptId),
      eq(sessionCaptureSplitJobs.pendingSourceRevision, work.sourceRevision),
      eq(sessionCaptureSplitJobs.status, "publishing"),
    )).run();
    if (jobUpdated.rowsAffected !== 1) throw new Error("Split job attempt changed during publication");
    signal?.throwIfAborted();
    return true;
  });
  if (published) {
    clearCaptureManifestCache(manifestPath);
    for (const window of work.windows) cacheDelete(Number(window.lapId));
    await notifySessionCaptureSplitStatus(work.sessionId);
  }
  return published;
}

/** Startup repairs missed close enqueue and fences interrupted attempts with a new identity. */
export async function recoverSessionCaptureSplitJobs(): Promise<void> {
  await recoverLiveCaptureStorage();
  const interrupted = await db.select({
    sessionId: sessionCaptureSplitJobs.sessionId, attemptId: sessionCaptureSplitJobs.attemptId,
    stagingPath: sessionCaptureSplitJobs.stagingPath,
  }).from(sessionCaptureSplitJobs).where(or(
    eq(sessionCaptureSplitJobs.status, "splitting"),
    eq(sessionCaptureSplitJobs.status, "verifying"),
    eq(sessionCaptureSplitJobs.status, "publishing"),
  )).all();
  for (const { sessionId, attemptId, stagingPath } of interrupted) {
    if (stagingPath) {
      const publications = await db.select({
        rawFile: sessions.rawFile, manifestFile: sessions.captureManifestFile, archiveFile: sessions.captureArchiveFile,
      }).from(sessions).all();
      const references = publications.flatMap((row) => [row.rawFile, row.manifestFile, row.archiveFile])
        .filter((path): path is string => path != null).map((path) => resolve(path));
      const candidates = stagingPath.endsWith(".staging") ? [stagingPath, stagingPath.slice(0, -8)] : [stagingPath];
      for (const candidate of candidates) {
        if (!isOwnedSessionRawFile(candidate) || references.some((path) => {
          const rel = relative(resolve(candidate), path);
          return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
        })) continue;
        await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
        clearCaptureManifestCache();
      }
    }
    const reset = {
      sequence: 0, stagingPath: null, processedSourceFrames: null, totalSourceFrames: null,
      completedLapArtifacts: 0, updatedAt: new Date().toISOString(),
    };
    if (attemptId >= 3) {
      await db.update(sessionCaptureSplitJobs).set({
        ...reset, sequence: sql`${sessionCaptureSplitJobs.sequence} + 1`,
        status: "failed", errorCode: "worker-failed", errorMessage: "Interrupted split exceeded retry limit",
      }).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).run();
      await notifySessionCaptureSplitStatus(sessionId);
    } else {
      await db.update(sessionCaptureSplitJobs).set({
        ...reset, attemptId: sql`${sessionCaptureSplitJobs.attemptId} + 1`,
        status: "queued", errorCode: null, errorMessage: null,
      }).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).run();
      await notifySessionCaptureSplitStatus(sessionId);
    }
  }
  const candidates = await db.select({ id: sessions.id }).from(sessions)
    .where(or(isNull(sessions.captureLayoutVersion), eq(sessions.captureLayoutVersion, 2)))
    .all();
  for (const { id } of candidates) await enqueueSessionCaptureSplit(id);
}

export async function getQueuedSessionCaptureSplitJobs(includeFailed = false): Promise<SessionCaptureSplitWork[]> {
  const jobs = await db.select({
    sessionId: sessionCaptureSplitJobs.sessionId, jobId: sessionCaptureSplitJobs.jobId,
    attemptId: sessionCaptureSplitJobs.attemptId, sourceRevision: sessionCaptureSplitJobs.pendingSourceRevision,
    sourcePath: sessionCaptureSplitJobs.sourcePath, gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId,
    ownership: sessions.ownership, captureFormatVersion: sessions.captureFormatVersion,
    captureLayoutVersion: sessions.captureLayoutVersion, captureArchiveFile: sessions.captureArchiveFile,
    currentRawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile,
  }).from(sessionCaptureSplitJobs).innerJoin(sessions, eq(sessions.id, sessionCaptureSplitJobs.sessionId))
    .where(and(
      includeFailed
        ? inArray(sessionCaptureSplitJobs.status, ["queued", "failed"])
        : eq(sessionCaptureSplitJobs.status, "queued"),
      or(isNull(sessions.captureLayoutVersion), eq(sessions.captureLayoutVersion, 2)),
    )).orderBy(asc(sessionCaptureSplitJobs.sessionId)).all();
  const result: SessionCaptureSplitWork[] = [];
  for (const job of jobs) {
    const lapRows = await db.select({ id: laps.id, lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount })
      .from(laps).where(eq(laps.sessionId, job.sessionId)).all();
    const windows = lapRows.filter((lap) => lap.rawByteOffset != null && lap.rawFrameCount != null && lap.rawFrameCount > 0)
      .map((lap) => ({ lapId: String(lap.id), lapNumber: lap.lapNumber, startByteOffset: lap.rawByteOffset!, frameCount: lap.rawFrameCount! }))
      .sort((a, b) => a.startByteOffset - b.startByteOffset);
    if (windows.length !== lapRows.length || windows.length === 0) continue;
    result.push({ ...job, gameId: job.gameId as GameId, windows, captureLayoutVersion: job.captureLayoutVersion,
      captureArchiveFile: job.captureArchiveFile });
  }
  return result;
}

export async function insertSession(
  carId: string,
  trackId: string,
  gameId: GameId,
  sessionType?: string,
  versionIdentity?: TelemetryVersionIdentity,
  ownership?: SessionOwnership,
): Promise<number> {
  const result = await db
    .insert(sessions)
    .values({ carId, trackId, gameId, sessionType, ownership, ...versionIdentity })
    .returning({ id: sessions.id })
    .get();
  return result.id;
}

/**
 * Update session metadata (e.g. session type discovered after session start).
 */

export async function updateSession(
  id: number,
  updates: { sessionType?: string; notes?: string | null }
): Promise<void> {
  await db.update(sessions).set(updates).where(eq(sessions.id, id)).run();
}

export async function updateSessionCarTrack(
  sessionId: number,
  carId: string,
  trackId: string,
): Promise<boolean> {
  const result = await db.update(sessions).set({ carId, trackId }).where(eq(sessions.id, sessionId)).run();
  return result.rowsAffected > 0;
}

export async function setSessionFavorite(id: number, favorite: boolean): Promise<boolean> {
  return withSessionCaptureMaintenanceLock(async () => {
    const result = await db.update(sessions).set({ isFavorite: favorite }).where(eq(sessions.id, id)).run();
    return result.rowsAffected > 0;
  });
}

export async function setLapFavorite(id: number, favorite: boolean): Promise<boolean> {
  return withSessionCaptureMaintenanceLock(async () => {
    const result = await db.update(laps).set({ isFavorite: favorite }).where(eq(laps.id, id)).run();
    return result.rowsAffected > 0;
  });
}
export async function updateSessionSource(sessionId: number, source: string): Promise<void> {
  await db.update(sessions).set({ source }).where(eq(sessions.id, sessionId)).run();
}



export async function updateSessionRawFile(
  sessionId: number,
  rawFile: string,
  lapDetectorVersion: string,
  versionIdentity?: TelemetryVersionIdentity,
): Promise<void> {
  await db
    .update(sessions)
    .set({ rawFile, lapDetectorVersion, ...versionIdentity })
    .where(eq(sessions.id, sessionId))
    .run();
}
export interface SessionCaptureSplitProgressUpdate {
  sessionId: number;
  jobId: string;
  attemptId: number;
  sourceRevision: string;
  sequence: number;
  phase: SessionCaptureSplitPhase;
  processedSourceFrames?: number;
  totalSourceFrames?: number;
  completedLapArtifacts: number;
  totalLapArtifacts: number;
  errorCode?: SessionCaptureSplitErrorCode;
}

/** Persist only the newest event for the current split attempt. */
export async function updateSessionCaptureSplitProgress(update: SessionCaptureSplitProgressUpdate): Promise<boolean> {
  const result = await db
    .update(sessionCaptureSplitJobs)
    .set({
      sequence: update.sequence,
      status: update.phase,
      ...(update.processedSourceFrames === undefined ? {} : { processedSourceFrames: update.processedSourceFrames }),
      ...(update.totalSourceFrames === undefined ? {} : { totalSourceFrames: update.totalSourceFrames }),
      completedLapArtifacts: update.completedLapArtifacts,
      totalLapArtifacts: update.totalLapArtifacts,
      errorCode: update.errorCode ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(sessionCaptureSplitJobs.sessionId, update.sessionId),
      eq(sessionCaptureSplitJobs.jobId, update.jobId),
      eq(sessionCaptureSplitJobs.pendingSourceRevision, update.sourceRevision),
      eq(sessionCaptureSplitJobs.attemptId, update.attemptId),
      lt(sessionCaptureSplitJobs.sequence, update.sequence),
      or(
        eq(sessionCaptureSplitJobs.status, "splitting"),
        eq(sessionCaptureSplitJobs.status, "verifying"),
        eq(sessionCaptureSplitJobs.status, "publishing"),
      ),
    ))
    .run();
  if (result.rowsAffected > 0) await notifySessionCaptureSplitStatus(update.sessionId);
  return result.rowsAffected > 0;
}

/**
 * Aggregate lap stats scoped to an optional game. Uses SQL COUNT/SUM so
 * totals don't get capped by getLaps()'s 200-row limit — home-page game
 * cards and per-game pages now both report the full picture.
 */

async function getAvailableStaleSessionRows(
  currentIds: string | string[],
  reprocessableGameIds: GameId[],
): Promise<{ id: number; rawFile: string }[]> {
  const ids = Array.isArray(currentIds) ? currentIds : [currentIds];
  const rows = await db
    .select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} IS NOT NULL`,
        inArray(sessions.gameId, reprocessableGameIds),
        or(eq(sessions.captureFormatVersion, 1), eq(sessions.source, MOTEC_SESSION_SOURCE)),
        or(isNull(sessions.lapDetectorVersion), notInArray(sessions.lapDetectorVersion, ids))
      )
    )
    .all();
  return rows.filter(
    (row): row is { id: number; rawFile: string } =>
      row.rawFile != null && existsSync(row.rawFile),
  );
}

export async function countStaleSessions(
  currentIds: string | string[],
  reprocessableGameIds: GameId[],
): Promise<number> {
  return (await getAvailableStaleSessionRows(currentIds, reprocessableGameIds)).length;
}

/**
 * Get IDs of sessions with stale lap detector versions and available raw files.
 */
export async function getStaleSessions(
  currentIds: string | string[],
  reprocessableGameIds: GameId[],
): Promise<number[]> {
  return (await getAvailableStaleSessionRows(currentIds, reprocessableGameIds)).map((row) => row.id);
}

/**
 * Get sessions with uncompressed raw files (.bin) older than the given age in ms.
 */

export async function getUncompressedSessions(olderThanMs: number): Promise<{ id: number; rawFile: string }[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} LIKE '%.bin'`,
        sql`${sessions.createdAt} < ${cutoff}`,
        notInArray(sessions.rawFile, db.select({ sourcePath: sessionCaptureSplitJobs.sourcePath })
          .from(sessionCaptureSplitJobs).where(or(
            eq(sessionCaptureSplitJobs.status, "queued"), eq(sessionCaptureSplitJobs.status, "splitting"),
            eq(sessionCaptureSplitJobs.status, "verifying"), eq(sessionCaptureSplitJobs.status, "publishing"),
          ))),
      )
    )
    .all();
  return rows.filter((r): r is { id: number; rawFile: string } => r.rawFile !== null);
}
/** Mark only freshly-created sparse recordings current. */
export async function markSessionCaptureFormatCurrent(sessionId: number): Promise<void> {
  await db.update(sessions).set({ captureFormatVersion: 1 }).where(eq(sessions.id, sessionId)).run();
}
export function isOwnedSessionRawFile(rawFile: string): boolean {
  const sessionsDir = resolveRecordingDirectory();
  const relativePath = relative(sessionsDir, resolve(rawFile));
  return relativePath.length > 0 && !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

export class SessionCaptureActiveError extends Error {
  constructor() {
    super("Cannot delete session while capture storage is active, recovering, or retains a committed prefix");
    this.name = "SessionCaptureActiveError";
  }
}

async function unlinkOwnedSessionRawFile(rawFile: string | null): Promise<void> {
  if (!rawFile || !isOwnedSessionRawFile(rawFile)) return;
  const stillReferenced = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.rawFile, rawFile)).limit(1).get();
  const jobReference = await db.select({ sessionId: sessionCaptureSplitJobs.sessionId })
    .from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sourcePath, rawFile)).limit(1).get();
  const liveReference = await db.select({ sessionId: liveCaptures.sessionId }).from(liveCaptures)
    .where(eq(liveCaptures.sourcePath, rawFile)).limit(1).get();
  if (stillReferenced || jobReference || liveReference) return;
  try {
    if (existsSync(rawFile)) unlinkSync(rawFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function manifestMemberPaths(manifestPath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("version" in parsed)) return [];
    if (parsed.version === 4) {
      return "archiveFile" in parsed && parsed.archiveFile === "capture.bin.gz"
        ? [resolve(dirname(manifestPath), parsed.archiveFile)] : [];
    }
    if (parsed.version !== 3 || !("chunks" in parsed) || !Array.isArray(parsed.chunks)) return [];
    return parsed.chunks.flatMap((chunk) => {
      if (!chunk || typeof chunk !== "object" || !("path" in chunk) || typeof chunk.path !== "string" || isAbsolute(chunk.path)) return [];
      const path = resolve(dirname(manifestPath), chunk.path);
      const rel = relative(dirname(manifestPath), path);
      return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? [] : [path];
    });
  } catch {
    return [];
  }
}

async function unlinkUnsharedCaptureBundle(manifestFile: string | null, archiveFile: string | null): Promise<void> {
  if (!manifestFile || !isOwnedSessionRawFile(manifestFile)) return;
  const candidates = new Set([resolve(manifestFile), ...manifestMemberPaths(resolve(manifestFile)), ...(archiveFile ? [resolve(archiveFile)] : [])]);
  const remaining = await db.select({ manifestFile: sessions.captureManifestFile, archiveFile: sessions.captureArchiveFile }).from(sessions).all();
  const referenced = new Set<string>();
  for (const row of remaining) {
    if (row.archiveFile) referenced.add(resolve(row.archiveFile));
    if (!row.manifestFile) continue;
    const manifestPath = resolve(row.manifestFile);
    referenced.add(manifestPath);
    for (const path of manifestMemberPaths(manifestPath)) referenced.add(path);
  }
  const liveRefs = await db.select({ archivePath: liveCaptures.archivePath, sourcePath: liveCaptures.sourcePath }).from(liveCaptures).all();
  for (const row of liveRefs) {
    referenced.add(resolve(row.archivePath));
    referenced.add(resolve(row.sourcePath));
  }
  for (const path of candidates) {
    clearCaptureManifestCache(path);
    if (referenced.has(path) || !isOwnedSessionRawFile(path)) continue;
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Delete a session and its laps. Refuse deletion while a split attempt owns its source.
 */
async function deleteSessionUnlocked(sessionId: number): Promise<number> {
  const deleted = await db.transaction(async (tx) => {
    const session = await tx.select({
      rawFile: sessions.rawFile,
      manifestFile: sessions.captureManifestFile,
      archiveFile: sessions.captureArchiveFile,
    }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) return null;
    const liveCapture = await tx.select({ status: liveCaptures.status, committedArchiveLength: liveCaptures.committedArchiveLength })
      .from(liveCaptures).where(eq(liveCaptures.sessionId, sessionId)).get();
    if (liveCapture && (["recording", "finalizing", "recovering"].includes(liveCapture.status) ||
        (liveCapture.status === "failed" && liveCapture.committedArchiveLength > 0))) throw new SessionCaptureActiveError();
    const activeJob = await tx.select({ sessionId: sessionCaptureSplitJobs.sessionId })
      .from(sessionCaptureSplitJobs)
      .where(and(
        eq(sessionCaptureSplitJobs.sessionId, sessionId),
        inArray(sessionCaptureSplitJobs.status, ["splitting", "verifying", "publishing"]),
      )).get();
    if (activeJob) throw new SessionCaptureActiveError();
    await tx.delete(sessionCaptureSplitJobs).where(and(
      eq(sessionCaptureSplitJobs.sessionId, sessionId),
      eq(sessionCaptureSplitJobs.status, "queued"),
    )).run();
    const lapRows = await tx.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    await tx.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return { ...session, lapIds: lapRows.map(({ id }) => id) };
  });
  if (!deleted) return 0;
  for (const lapId of deleted.lapIds) cacheDelete(lapId);
  await unlinkOwnedSessionRawFile(deleted.rawFile);
  await unlinkUnsharedCaptureBundle(deleted.manifestFile, deleted.archiveFile);
  return deleted.lapIds.length;
}

export async function deleteSession(sessionId: number): Promise<number> {
  return withSessionCaptureMaintenanceLock(() => deleteSessionUnlocked(sessionId));
}

export async function deleteEmptySessions(activeSessionId?: number): Promise<number> {
  return withSessionCaptureMaintenanceLock(async () => {
    const empties = await db
      .select({ id: sessions.id })
      .from(sessions)
      .leftJoin(laps, eq(laps.sessionId, sessions.id))
      .where(sql`${sessions.lapDetectorVersion} IS NOT NULL`)
      .groupBy(sessions.id)
      .having(sql`count(${laps.id}) = 0`)
      .all();
    const candidateIds = empties.filter(({ id }) => id !== activeSessionId).map(({ id }) => id);
    if (candidateIds.length === 0) return 0;
    const activeJobs = await db.select({ sessionId: sessionCaptureSplitJobs.sessionId })
      .from(sessionCaptureSplitJobs)
      .where(and(
        inArray(sessionCaptureSplitJobs.sessionId, candidateIds),
        inArray(sessionCaptureSplitJobs.status, ["queued", "splitting", "verifying", "publishing"]),
      )).all();
    const protectedIds = new Set(activeJobs.map(({ sessionId }) => sessionId));
    let deleted = 0;
    for (const id of candidateIds) {
      if (protectedIds.has(id)) continue;
      try {
        await deleteSessionUnlocked(id);
        deleted++;
      } catch (error) {
        if (!(error instanceof SessionCaptureActiveError)) throw error;
      }
    }
    return deleted;
  });
}

/** Get all lap metadata needed to preserve rows during reprocessing. */


/**
 * Get all sessions with lap counts, newest first.
 */

export async function getSessions(gameId?: GameId): Promise<SessionMeta[]> {
  const query = db
    .select({
      id: sessions.id,
      carId: sessions.carId,
      trackId: sessions.trackId,
      createdAt: sessions.createdAt,
      gameId: sessions.gameId,
      ownership: sessions.ownership,
      isFavorite: sessions.isFavorite,
      telemetryAvailable: sql<number>`${sessions.rawFile} IS NOT NULL OR ${sessions.captureManifestFile} IS NOT NULL`,
      capturePath: sessions.rawFile,
      notes: sessions.notes,
      source: sessions.source,
      sessionType: sessions.sessionType,
      catalogVersion: sessions.catalogVersion,
      catalogHash: sessions.catalogHash,
      catalogSchemaVersion: sessions.catalogSchemaVersion,
      parserVersion: sessions.parserVersion,
      resolverVersion: sessions.resolverVersion,
      derivationVersion: sessions.derivationVersion,
    })
    .from(sessions)
    .orderBy(desc(sessions.id));

  const rows = gameId
    ? await query.where(eq(sessions.gameId, gameId)).all()
    : await query.all();
  const splitJobRows = rows.length
    ? await db.select({
      sessionId: sessionCaptureSplitJobs.sessionId,
      jobId: sessionCaptureSplitJobs.jobId,
      attemptId: sessionCaptureSplitJobs.attemptId,
      sequence: sessionCaptureSplitJobs.sequence,
      phase: sessionCaptureSplitJobs.status,
      processedSourceFrames: sessionCaptureSplitJobs.processedSourceFrames,
      totalSourceFrames: sessionCaptureSplitJobs.totalSourceFrames,
      completedLapArtifacts: sessionCaptureSplitJobs.completedLapArtifacts,
      totalLapArtifacts: sessionCaptureSplitJobs.totalLapArtifacts,
      errorCode: sessionCaptureSplitJobs.errorCode,
    }).from(sessionCaptureSplitJobs).where(inArray(sessionCaptureSplitJobs.sessionId, rows.map(({ id }) => id))).all()
    : [];
  const splitJobs = new Map(splitJobRows.map((job) => [job.sessionId, job]));

  // Shared paths lack per-session interval metadata; never count one full file twice.
  const capturePaths = [...new Set(rows.flatMap((session) => session.capturePath ? [session.capturePath] : []))];
  const sharedCaptureRows = capturePaths.length
    ? await db.select({ rawFile: sessions.rawFile }).from(sessions).where(inArray(sessions.rawFile, capturePaths)).all()
    : [];
  const sessionsByFile = new Map<string, number>();
  for (const session of sharedCaptureRows) {
    if (session.rawFile) sessionsByFile.set(session.rawFile, (sessionsByFile.get(session.rawFile) ?? 0) + 1);
  }
  const elapsedBySession = new Map<number, number | null>();
  for (const session of rows) {
    const elapsedSeconds = session.capturePath && sessionsByFile.get(session.capturePath) === 1
      ? await getRecordedElapsedSeconds({
        rawFile: session.capturePath,
        source: session.source ?? null,
        gameId: session.gameId as GameId,
        carId: session.carId,
        trackId: session.trackId,
      })
      : null;
    elapsedBySession.set(session.id, elapsedSeconds);
  }
  // Get lap counts and best lap per session
  const result: SessionMeta[] = [];
  for (const session of rows) {
    const lapRows = await db
      .select({ id: laps.id, lapTime: laps.lapTime, isValid: laps.isValid })
      .from(laps)
      .where(eq(laps.sessionId, session.id))
      .all();
    const validLapTimes = lapRows.filter((lap) => Boolean(lap.isValid)).map((lap) => lap.lapTime);
    const bestLapTime = validLapTimes.length > 0 ? Math.min(...validLapTimes) : 0;

    const { capturePath: _capturePath, ...sessionMetadata } = session;
    const splitJob = splitJobs.get(session.id);
    const normalizedSession = {
      ...sessionMetadata,
      sessionType: session.sessionType ?? undefined,
      telemetryAvailable: Boolean(session.telemetryAvailable),
      isFavorite: Boolean(session.isFavorite),
      captureSplit: splitJob
        ? {
          sessionId: splitJob.sessionId,
          jobId: splitJob.jobId,
          attemptId: splitJob.attemptId,
          sequence: splitJob.sequence,
          phase: splitJob.phase,
          ...(splitJob.processedSourceFrames == null ? {} : { processedSourceFrames: splitJob.processedSourceFrames }),
          ...(splitJob.totalSourceFrames == null ? {} : { totalSourceFrames: splitJob.totalSourceFrames }),
          completedLapArtifacts: splitJob.completedLapArtifacts,
          totalLapArtifacts: splitJob.totalLapArtifacts,
          ...(splitJob.errorCode == null ? {} : { errorCode: splitJob.errorCode as SessionCaptureSplitErrorCode }),
        }
        : undefined,
    };
    const resultRow = await db
      .select({
        id: sessionResults.id,
        classification: sessionResults.classification,
        finishingPosition: sessionResults.finishingPosition,
        qualifyingPosition: sessionResults.qualifyingPosition,
        outcomeStatus: sessionResults.outcomeStatus,
        isPodium: sessionResults.isPodium,
        isFastestLap: sessionResults.isFastestLap,
        pitCount: sessionResults.pitCount,
      })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, session.id))
      .get();
    const pitDurationRow = resultRow
      ? await db
        .select({ duration: sql<number | null>`sum(${pitEvents.durationSeconds})` })
        .from(pitEvents)
        .where(eq(pitEvents.resultId, resultRow.id))
        .get()
      : null;
    result.push({
      ...normalizedSession,
      elapsedSeconds: elapsedBySession.get(session.id) ?? null,
      lapCount: lapRows.length,
      bestLapTime,
      resultClassification: resultRow?.classification ?? null,
      finishingPosition: resultRow?.finishingPosition ?? null,
      qualifyingPosition: resultRow?.qualifyingPosition ?? null,
      resultOutcomeStatus: resultRow?.outcomeStatus ?? null,
      isPodium: resultRow?.isPodium ?? null,
      isFastestLap: resultRow?.isFastestLap ?? null,
      pitCount: resultRow?.pitCount ?? null,
      pitDurationSeconds: pitDurationRow?.duration ?? null,
      notes: session.notes ?? undefined,
      source: session.source ?? undefined,
      gameId: session.gameId as GameId,
      catalogVersion: session.catalogVersion ?? undefined,
      catalogHash: session.catalogHash ?? undefined,
      catalogSchemaVersion: session.catalogSchemaVersion ?? undefined,
      parserVersion: session.parserVersion ?? undefined,
      resolverVersion: session.resolverVersion ?? undefined,
      derivationVersion: session.derivationVersion ?? undefined,
      ownership: session.ownership === "others" ? "others" : "mine",
    });
  }
  return result;
}

/**
 * Fetch-only data needed for a session recap: the session row, its laps, the
 * track's length (metres, null when no outline), and the best valid lap time
 * for the same track + car + game from every OTHER session. No math here —
 * see server/lap-analysis/recap.ts::computeRecap for the rules.
 *
 * Returns null when the session doesn't exist or its gameId doesn't match.
 */

export async function getSessionRecapData(
  id: number,
  gameId: GameId,
): Promise<{
  session: RecapSessionInput;
  laps: RecapLapInput[];
  trackLengthM: number | null;
  allTimeBestSec: number | null;
  allTimeBestSectors: Array<number | null> | null;
  sectorStarts: number[] | null;
} | null> {
  const sessionRow = await db
    .select({
      id: sessions.id,
      carId: sessions.carId,
      trackId: sessions.trackId,
      gameId: sessions.gameId,
      createdAt: sessions.createdAt,
      ownership: sessions.ownership,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();

  if (!sessionRow || sessionRow.gameId !== gameId) return null;

  const lapRows = await db
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      sectorTimes: laps.sectorTimes,
      invalidReason: laps.invalidReason,
    })
    .from(laps)
    .where(eq(laps.sessionId, id))
    .orderBy(laps.lapNumber)
    .all();

  const trackLengthM = gameId === "lmu" && sessionRow.trackId
    ? (getLMUTrack(sessionRow.trackId)?.lengthKm ?? 0) * 1_000 || null
    : getTrackLengthMetersById(sessionRow.trackId, gameId);
  const sessionSectorCount =
    lapRows.find(
      (lap) =>
        Boolean(lap.isValid) &&
        lap.sectorTimes != null &&
        lap.sectorTimes.length >= 2 &&
        lap.sectorTimes.every((time) => time > 0),
    )?.sectorTimes?.length ?? 0;

  let sectorStarts: number[] | null = null;
  const gameAdapter = tryGetGame(gameId);
  if (gameAdapter?.nativeSectors && gameAdapter.getNativeSectorLayout && sessionSectorCount >= 2) {
    for (const row of lapRows) {
      if (row.sectorTimes?.length !== sessionSectorCount) continue;
      const lap = await getLapById(row.id);
      const layout = lap?.telemetry
        .map((packet) => gameAdapter.getNativeSectorLayout!(packet))
        .find((candidate) => candidate?.starts.length === sessionSectorCount);
      if (layout) {
        sectorStarts = [...layout.starts];
        break;
      }
    }
  }
  const identityFilters = [
    eq(sessions.trackId, sessionRow.trackId),
    eq(sessions.carId, sessionRow.carId),
  ];

  const bestOtherRow = await db
    .select({ lapTime: laps.lapTime })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      and(
        ...identityFilters,
        eq(sessions.gameId, gameId),
        sql`${sessions.id} != ${id}`,
        eq(laps.isValid, true),
        sql`${laps.lapTime} > 0`,
      ),
    )
    .orderBy(laps.lapTime)
    .limit(1)
    .get();

  const otherSectorRows = await db
    .select({ sectorTimes: laps.sectorTimes })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      and(
        ...identityFilters,
        eq(sessions.gameId, gameId),
        sql`${sessions.id} != ${id}`,
        eq(laps.isValid, true),
        sql`${laps.lapTime} > 0`,
        sql`${laps.sectorTimes} IS NOT NULL`,
      ),
    )
    .all();
  const allTimeBestSectors = otherSectorRows.reduce<Array<number | null>>(
    (best, row) => {
      if (row.sectorTimes?.length !== sessionSectorCount) return best;
      for (let index = 0; index < (row.sectorTimes?.length ?? 0); index++) {
        const time = row.sectorTimes![index];
        if (time > 0 && (best[index] === undefined || best[index] === null || time < best[index]!)) {
          best[index] = time;
        }
      }
      return best;
    },
    [],
  );

  return {
    session: {
      id: sessionRow.id,
      carId: sessionRow.carId,
      trackId: sessionRow.trackId,
      gameId: sessionRow.gameId as GameId,
      createdAt: sessionRow.createdAt,
      ownership: sessionRow.ownership === "others" ? "others" : "mine",
    },
    laps: lapRows.map((l) => ({ ...l, isValid: Boolean(l.isValid) })),
    trackLengthM,
    allTimeBestSec: bestOtherRow?.lapTime ?? null,
    allTimeBestSectors:
      allTimeBestSectors.length > 0 ? allTimeBestSectors : null,
    sectorStarts,
  };
}
