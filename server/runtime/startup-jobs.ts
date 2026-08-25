import { and, asc, eq, isNotNull } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { startCommunityTunesSync } from "../tunes/community-sync";
import { startLaptimesSync } from "../sync/laptimes";
import { countStaleSessions } from "../db/session-queries";
import { countStaleRaceResults } from "../db/session-result-queries";
import { RACE_RESULT_PROCESSOR_ID } from "../race-results/reconcile";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import { LAP_DETECTOR_ACC_ID } from "../games/acc/lap-detector";
import { LAP_DETECTOR_AC_EVO_ID } from "../games/ac-evo/lap-detector";
import { LAP_DETECTOR_IRACING_ID } from "../games/iracing/lap-detector";
import { getAllServerGames } from "../games/registry";
import { wsManager } from "./websocket-manager";
import { startSessionCompressor } from "../session-capture/compressor";
import { startUpdateCheckSchedule } from "./update/check";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { completeCanonicalArchiveJob, claimCanonicalArchiveJob, enqueueCanonicalArchiveJob, failCanonicalArchiveJob, getActiveVerifiedCanonicalArchive, heartbeatCanonicalArchiveJob, recoverExpiredCanonicalArchiveJobs, recoverInterruptedCanonicalArchives } from "../db/canonical-archive-queries";
import { failInterruptedAnalysisGenerations } from "../db/analysis-receipt-queries";
import { buildCanonicalArchive } from "../session-capture/canonical-archive";
import { inspectRawCaptureIdentity } from "../session-capture/identity";
import { isSessionActive } from "../telemetry/live-pipeline";
const ALL_DETECTOR_IDS = [
  LAP_DETECTOR_ID,
  LAP_DETECTOR_ACC_ID,
  LAP_DETECTOR_AC_EVO_ID,
  LAP_DETECTOR_IRACING_ID,
];
const CANONICAL_ARCHIVE_INTERVAL_MS = 15_000;
let canonicalArchiveRecoveryComplete = false;

export interface StartupJobDependencies {
  startCommunityTunesSync?: () => void;
  startLaptimesSync?: () => void;
  startSessionCompressor?: () => void;
  startUpdateCheckSchedule?: () => void;
  countStaleSessions?: typeof countStaleSessions;
  countStaleRaceResults?: typeof countStaleRaceResults;
}

export function startSyncAndStaleSessionJobs(dependencies: StartupJobDependencies = {}): void {
  (dependencies.startCommunityTunesSync ?? startCommunityTunesSync)();
  (dependencies.startLaptimesSync ?? startLaptimesSync)();

  (dependencies.countStaleSessions ?? countStaleSessions)(
    ALL_DETECTOR_IDS,
    getAllServerGames().map((adapter) => adapter.id),
  ).then((count) => {
    if (count > 0) {
      console.log(`[Server] ${count} session(s) recorded with stale lap detector — will prompt user to reprocess`);
      wsManager.setStaleSessionsNotification({
        type: "stale-lap-detection",
        sessionCount: count,
        currentVersion: ALL_DETECTOR_IDS.join(","),
      });
    }
  }).catch((err) => {
    console.error("[Server] Failed to check stale sessions:", err);
  });

  (dependencies.countStaleRaceResults ?? countStaleRaceResults)(RACE_RESULT_PROCESSOR_ID).then((count) => {
    if (count > 0) {
      console.log(`[Server] ${count} session result(s) use an older processor — will prompt user to recalculate`);
      if (process.env.RACEIQ_E2E !== "1") {
        wsManager.setStaleRaceResultsNotification({
          type: "stale-race-results",
          sessionCount: count,
          currentVersion: RACE_RESULT_PROCESSOR_ID,
        });
      }
    }
  }).catch((err) => {
    console.error("[Server] Failed to check stale race results:", err);
  });
}
export async function enqueueStableCaptureJobs(): Promise<void> {
  if (isSessionActive()) return;
  const rows = await db.select({
    id: sessions.id,
    rawFile: sessions.rawFile,
    rawCaptureFileSize: sessions.rawCaptureFileSize,
    rawCaptureFileMtimeMs: sessions.rawCaptureFileMtimeMs,
    rawCaptureFileCtimeMs: sessions.rawCaptureFileCtimeMs,
    rawCaptureContentHash: sessions.rawCaptureContentHash,
  }).from(sessions).where(and(isNotNull(sessions.rawFile))).orderBy(asc(sessions.id));
  for (const row of rows) {
    try {
      if (!row.rawFile) continue;
      const before = await stat(row.rawFile).catch(() => null);
      if (!before) continue;
      const fileSize = before.size;
      const fileMtimeMs = Math.trunc(before.mtimeMs);
      const fileCtimeMs = Math.trunc(before.ctimeMs);
      let sourceContentHash = row.rawCaptureFileSize === fileSize
        && row.rawCaptureFileMtimeMs === fileMtimeMs
        && row.rawCaptureFileCtimeMs === fileCtimeMs
        ? row.rawCaptureContentHash
        : null;
      if (!sourceContentHash) {
        const identity = await inspectRawCaptureIdentity(row.rawFile);
        if (!identity) continue;
        const after = await stat(row.rawFile).catch(() => null);
        if (
          !after
          || after.size !== fileSize
          || Math.trunc(after.mtimeMs) !== fileMtimeMs
          || Math.trunc(after.ctimeMs) !== fileCtimeMs
        ) continue;
        sourceContentHash = identity.contentHash;
        await db.update(sessions).set({
          rawCaptureFileSize: fileSize,
          rawCaptureFileMtimeMs: fileMtimeMs,
          rawCaptureFileCtimeMs: fileCtimeMs,
          rawCaptureContentHash: sourceContentHash,
        }).where(eq(sessions.id, row.id));
      }
      if (!sourceContentHash) continue;
      const archive = await getActiveVerifiedCanonicalArchive(row.id, { verifyOutput: true });
      if (archive?.sourceContentHash === sourceContentHash) continue;
      await enqueueCanonicalArchiveJob({
        sessionId: row.id,
        sourceContentHash,
        rebuildSucceeded: true,
      });
    } catch (error) {
      console.error(`[Server] Canonical archive scheduling failed for session ${row.id}:`, error);
    }
  }
}

function isDeterministicArchiveFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /source hash|zero readable|schema|parser|ordering|receipt verification/i.test(message);
}
export async function runCanonicalArchiveJobOnce(): Promise<boolean> {
  if (isSessionActive()) return false;
  await recoverExpiredCanonicalArchiveJobs();
  const job = await claimCanonicalArchiveJob();
  if (!job) return false;
  if (!job.leaseToken) throw new Error(`Claimed canonical archive job ${job.jobId} without lease token`);
  const leaseToken = job.leaseToken;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void heartbeatCanonicalArchiveJob({ jobId: job.jobId, leaseToken }).then((renewed) => {
      if (!renewed) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, 20_000);
  heartbeat.unref?.();
  try {
    const result = await buildCanonicalArchive({
      sessionId: job.sessionId,
      sourceContentHash: job.sourceContentHash,
      jobId: job.jobId,
      leaseToken,
    });
    if (leaseLost) throw new Error("Canonical archive job lease lost during build");
    const completed = await completeCanonicalArchiveJob({
      jobId: job.jobId,
      leaseToken,
      generationId: result.receipt.generationId,
    });
    if (!completed) throw new Error("Canonical archive job lease lost before completion");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const deterministic = isDeterministicArchiveFailure(error);
    const retryAt = deterministic
      ? null
      : new Date(Date.now() + Math.min(15 * 60_000, 2 ** Math.min(job.attemptCount, 8) * 1_000)).toISOString();
    await failCanonicalArchiveJob({ jobId: job.jobId, leaseToken, error: message, retryAt, deterministic });
    console.error(`[Server] Canonical archive job ${job.jobId} failed:`, message);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}


async function recoverInterruptedCanonicalArchiveState(): Promise<void> {
  if (canonicalArchiveRecoveryComplete) return;
  await recoverInterruptedCanonicalArchives();
  await failInterruptedAnalysisGenerations();
  canonicalArchiveRecoveryComplete = true;
}
export function startCanonicalArchiveJobs(): void {
  let processing = false;
  const tick = async () => {
    if (processing) return;
    processing = true;
    try {
      await recoverInterruptedCanonicalArchiveState();
      await enqueueStableCaptureJobs();
      await runCanonicalArchiveJobOnce();
    } catch (error) {
      console.error("[Server] Canonical archive scheduler failed:", error);
    } finally {
      processing = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), CANONICAL_ARCHIVE_INTERVAL_MS);
  timer.unref?.();
}

export function startMaintenanceJobs(): void {
  startSessionCompressor();
  startCanonicalArchiveJobs();
  startUpdateCheckSchedule();
}
