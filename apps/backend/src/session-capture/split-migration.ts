import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { db } from "@raceiq/backend-core/db/index";
import { liveCaptures, sessionCaptureSplitJobs, sessions } from "@raceiq/backend-core/db/schema";
import { enqueueSessionCaptureSplit, getQueuedSessionCaptureSplitJobs, type SessionCaptureSplitWork } from "@raceiq/backend-core/db/session-queries";
import { isSparseCaptureFile } from "@raceiq/backend-core/session-capture/source-loader";
import { getRecordingStorageActivity } from "@raceiq/backend-core/session-capture/storage-activity";

type SplitMigrationStatus = "idle" | "running" | "success" | "partial" | "error";
interface SplitMigrationProgress {
  status: SplitMigrationStatus;
  done: number;
  total: number;
  migrated: number;
  failed: number;
  error: string | null;
}

let startupSessionIds: number[] = [];
let startupSessionIdSet = new Set<number>();
let startupSessionIdCeiling = 0;

let consented = false;
let initialized = false;
async function isEligibleStartupJob(job: SessionCaptureSplitWork): Promise<boolean> {
  if (job.currentRawFile !== job.sourcePath ||
      (job.captureLayoutVersion == null
        ? job.captureManifestFile != null
        : job.captureLayoutVersion !== 2 || job.captureArchiveFile == null) ||
      !(job.sourcePath.endsWith(".bin") || job.sourcePath.endsWith(".bin.gz")) ||
      job.windows.some((window, index) =>
        !Number.isSafeInteger(window.startByteOffset) || window.startByteOffset < 0 ||
        !Number.isSafeInteger(window.frameCount) || window.frameCount < 1 ||
        !Number.isSafeInteger(window.lapNumber) || window.lapNumber < 0 ||
        (index > 0 && job.windows[index - 1]!.startByteOffset >= window.startByteOffset))) return false;
  const liveCapture = await db.select({ status: liveCaptures.status }).from(liveCaptures)
    .where(eq(liveCaptures.sessionId, job.sessionId)).get();
  if (liveCapture && ["recording", "finalizing", "recovering"].includes(liveCapture.status)) return false;
  let info;
  try { info = await stat(job.sourcePath); } catch { return false; }
  if (!info.isFile() || info.size === 0) return false;
  if (job.captureFormatVersion === 1) return true;
  try { return await isSparseCaptureFile(job.sourcePath, info); } catch { return false; }
}

async function getEligibleStartupJobs(): Promise<SessionCaptureSplitWork[]> {
  const candidates = await getQueuedSessionCaptureSplitJobs(true);
  const eligible: SessionCaptureSplitWork[] = [];
  for (const job of candidates) {
    if (await isEligibleStartupJob(job)) eligible.push(job);
  }
  return eligible;
}

/** Call after split-job recovery and before starting the split manager. */
export async function initializeStartupSplitMigration(): Promise<void> {
  const latestSession = await db.select({ id: sessions.id }).from(sessions).orderBy(desc(sessions.id)).limit(1).get();
  startupSessionIdCeiling = latestSession?.id ?? 0;
  startupSessionIds = (await getEligibleStartupJobs()).map(({ sessionId }) => sessionId);
  startupSessionIdSet = new Set(startupSessionIds);
  consented = false;
  initialized = true;
}

export function isStartupSplitMigrationHeld(sessionId: number): boolean {
  return initialized && !consented && startupSessionIdSet.has(sessionId);
}

export async function shouldHoldStartupSplitMigration(job: SessionCaptureSplitWork): Promise<boolean> {
  if (!initialized || consented || job.sessionId > startupSessionIdCeiling) return false;
  if (startupSessionIdSet.has(job.sessionId)) return true;
  if (!await isEligibleStartupJob(job)) return false;
  startupSessionIds.push(job.sessionId);
  startupSessionIdSet.add(job.sessionId);
  return true;
}

export async function getStartupSplitMigrationStatus(): Promise<{
  sessionCount: number;
  progress: SplitMigrationProgress;
}> {
  if (initialized && startupSessionIdCeiling > 0) {
    for (const { sessionId } of await getEligibleStartupJobs()) {
      if (sessionId <= startupSessionIdCeiling && !startupSessionIdSet.has(sessionId)) {
        startupSessionIds.push(sessionId);
        startupSessionIdSet.add(sessionId);
      }
    }
  }
  if (!initialized || startupSessionIds.length === 0) {
    return { sessionCount: 0, progress: { status: "idle", done: 0, total: 0, migrated: 0, failed: 0, error: null } };
  }
  const jobs = await db.select({ sessionId: sessionCaptureSplitJobs.sessionId, status: sessionCaptureSplitJobs.status, errorMessage: sessionCaptureSplitJobs.errorMessage })
    .from(sessionCaptureSplitJobs).where(inArray(sessionCaptureSplitJobs.sessionId, startupSessionIds)).all();
  const presentIds = new Set(jobs.map(({ sessionId }) => sessionId));
  startupSessionIds = startupSessionIds.filter((sessionId) => presentIds.has(sessionId));
  startupSessionIdSet = new Set(startupSessionIds);
  if (startupSessionIds.length === 0) {
    return { sessionCount: 0, progress: { status: "idle", done: 0, total: 0, migrated: 0, failed: 0, error: null } };
  }
  const migrated = jobs.filter((job) => job.status === "ready").length;
  const failedJobs = jobs.filter((job) => job.status === "failed");
  const failed = failedJobs.length;
  const done = migrated + failed;
  const total = startupSessionIds.length;
  const finished = done === total;
  const status: SplitMigrationStatus = !consented ? "idle"
    : !finished ? "running"
    : failed === 0 ? "success"
    : migrated === 0 ? "error" : "partial";
  return {
    sessionCount: total - migrated,
    progress: {
      status, done, total, migrated, failed,
      error: failedJobs.map((job) => job.errorMessage).find(Boolean) ?? null,
    },
  };
}

export async function consentToStartupSplitMigration(): Promise<{
  sessionCount: number;
  progress: SplitMigrationProgress;
}> {
  const activity = getRecordingStorageActivity();
  if (activity.imports > 0 || activity.relocating) {
    throw Object.assign(new Error("Recording storage is busy"), { code: activity.relocating ? "MOVE_ACTIVE" : "IMPORT_ACTIVE" });
  }
  const current = await getStartupSplitMigrationStatus();
  if (!consented || current.progress.status !== "running") {
    // Folder organization can move a queued source or replace its inode before consent.
    for (const sessionId of startupSessionIds) await enqueueSessionCaptureSplit(sessionId);
    if (current.progress.failed > 0) {
      const failed = await db.select({ sessionId: sessionCaptureSplitJobs.sessionId }).from(sessionCaptureSplitJobs)
        .where(and(inArray(sessionCaptureSplitJobs.sessionId, startupSessionIds), eq(sessionCaptureSplitJobs.status, "failed"))).all();
      for (const { sessionId } of failed) {
        await db.update(sessionCaptureSplitJobs).set({
          status: "queued", attemptId: sql`${sessionCaptureSplitJobs.attemptId} + 1`, sequence: 0,
          errorCode: null, errorMessage: null, stagingPath: null, processedSourceFrames: null,
          totalSourceFrames: null, completedLapArtifacts: 0, updatedAt: new Date().toISOString(),
        }).where(and(eq(sessionCaptureSplitJobs.sessionId, sessionId), eq(sessionCaptureSplitJobs.status, "failed"))).run();
      }
    }
    consented = true;
  }
  return getStartupSplitMigrationStatus();
}
