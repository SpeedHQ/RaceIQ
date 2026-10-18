import type { PublishedManifest, WorkerMessage } from "@raceiq/capture-splitting";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveRecordingGameDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { getQueuedSessionCaptureSplitJobs, claimSessionCaptureSplitJob, setSessionCaptureSplitStagingPath, updateSessionCaptureSplitProgress, failSessionCaptureSplitJob, publishSessionCaptureSplit, validateSessionCaptureSplitRevision, type SessionCaptureSplitWork } from "@raceiq/backend-core/db/session-queries";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";
import { beginRecordingStorageImport, getRecordingStorageActivity } from "@raceiq/backend-core/session-capture/storage-activity";
import { shouldHoldStartupSplitMigration } from "./split-migration";
import { runSessionCaptureSplit } from "./split-runner";

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let stopped = true;
let shutdownRequested = false;
let activeAbort: AbortController | null = null;
const POLL_MS = 1000;

async function execute(work: SessionCaptureSplitWork): Promise<void> {
  activeAbort = new AbortController();
  let claimed: boolean;
  try {
    claimed = await claimSessionCaptureSplitJob(work);
  } catch (error) {
    activeAbort = null;
    throw error;
  }
  if (!claimed) {
    activeAbort = null;
    return;
  }
  const attemptKey = `${work.jobId}-${work.attemptId}-${work.sourceRevision}`;
  const bundleParent = join(resolveRecordingGameDirectory(work.gameId, work.ownership), `session-${work.sessionId}`);
  const staging = join(bundleParent, `${attemptKey}.staging`);
  const final = join(bundleParent, attemptKey);
  let finalPublished = false;
  let publicationStarted = false;
  try {
    await mkdir(bundleParent, { recursive: true });
    if (!await setSessionCaptureSplitStagingPath(work, staging)) {
      throw Object.assign(new Error("Split staging path was fenced by newer job state"), { code: "STALE_ATTEMPT" });
    }
    await withSessionCaptureMaintenanceLock(async () => {
      if (!await validateSessionCaptureSplitRevision(work)) throw Object.assign(new Error("Source revision changed before splitting"), { code: "SOURCE_REVISION" });
      const source = { rawFile: work.sourcePath, source: null, gameId: work.gameId, carId: work.carId, trackId: work.trackId };
      let sequence = 1;
      let progressWrite: Promise<void> = Promise.resolve();
      let pendingProgress: Extract<WorkerMessage, { type: "progress" }> | null = null;
      let progressTimer: ReturnType<typeof setTimeout> | null = null;
      let progressFailure: unknown;
      let lastWorkerPhase: string | null = null;
      let lastCompleted = -1;
      let lastWrittenFrames = 0;
      let totalSourceFrames: number | undefined;
      let progressClosed = false;
      const flushProgress = (): Promise<void> => {
        clearTimeout(progressTimer ?? undefined);
        progressTimer = null;
        const current = pendingProgress;
        pendingProgress = null;
        if (!current || current.type !== "progress") return progressWrite;
        const progress = current.progress;
        progressWrite = progressWrite.then(async () => {
          if (progressFailure) return;
          const accepted = await updateSessionCaptureSplitProgress({
            sessionId: work.sessionId, jobId: work.jobId, attemptId: work.attemptId, sourceRevision: work.sourceRevision,
            sequence: ++sequence,
            phase: progress.phase === "verify" ? "verifying" : "splitting",
            processedSourceFrames: progress.frames,
            totalSourceFrames,
            completedLapArtifacts: progress.completedLapArtifacts,
            totalLapArtifacts: progress.totalLapArtifacts,
          });
          if (!accepted) progressFailure = Object.assign(new Error("Split progress was fenced by newer job state"), { code: "STALE_ATTEMPT" });
        }).catch((error) => {
          progressFailure = error;
        });
        return progressWrite;
      };
      let manifest: PublishedManifest;
      try {
        manifest = await runSessionCaptureSplit({
          jobId: work.jobId, attemptId: work.attemptId, sourceRevision: work.sourceRevision,
          outputDirectory: staging, source, windows: work.windows,
        }, (message) => {
          if (progressClosed || message.type !== "progress") return;
          const progress = message.progress;
          if (progress.phase === "write") lastWrittenFrames = progress.frames;
          if (progress.phase === "verify") totalSourceFrames = lastWrittenFrames;
          const boundary = progress.phase !== lastWorkerPhase || progress.completedLapArtifacts !== lastCompleted;
          lastWorkerPhase = progress.phase;
          lastCompleted = progress.completedLapArtifacts;
          pendingProgress = message;
          if (boundary) {
            void flushProgress();
          } else if (!progressTimer) {
            progressTimer = setTimeout(() => void flushProgress(), 250);
          }
        }, activeAbort!.signal);
      } finally {
        progressClosed = true;
        clearTimeout(progressTimer ?? undefined);
        progressTimer = null;
        await flushProgress();
      }
      if (progressFailure) throw progressFailure;
      await flushProgress();
      if (progressFailure) throw progressFailure;
      activeAbort!.signal.throwIfAborted();
      const publishingSequence = sequence + 1;
      if (!await updateSessionCaptureSplitProgress({
        sessionId: work.sessionId, jobId: work.jobId, attemptId: work.attemptId, sourceRevision: work.sourceRevision,
        sequence: publishingSequence, phase: "publishing",
        completedLapArtifacts: manifest.chunks.filter((chunk) => chunk.kind === "lap").length,
        totalLapArtifacts: work.windows.length,
      })) throw Object.assign(new Error("Split attempt was fenced before publication"), { code: "STALE_ATTEMPT" });
      activeAbort!.signal.throwIfAborted();
      publicationStarted = true;
      await rename(staging, final);
      finalPublished = true;
      if (!await validateSessionCaptureSplitRevision(work)) throw Object.assign(new Error("Source revision changed before publication"), { code: "SOURCE_REVISION" });
      activeAbort!.signal.throwIfAborted();
      const published = await publishSessionCaptureSplit(work, join(final, "manifest.json"), manifest, activeAbort!.signal);
      if (!published) throw Object.assign(new Error("Split publication rejected by current job/session state"), { code: "STALE_ATTEMPT" });
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (finalPublished) await rm(final, { recursive: true, force: true }).catch(() => undefined);
    const rawCode = error && typeof error === "object" && "code" in error ? String(error.code) : "SPLIT";
    const code = rawCode === "SOURCE_REVISION" || rawCode === "STALE_ATTEMPT" ? "stale-publication"
      : rawCode === "VERIFY" ? "verification-mismatch"
      : rawCode === "GAME" ? "bootstrap-failed"
      : rawCode === "FORMAT" ? "malformed-capture"
      : rawCode === "IO" ? "source-io"
      : publicationStarted ? "publication-failed" : "worker-failed";
    const message = error instanceof Error ? error.message : String(error);
    if (!activeAbort?.signal.aborted) await failSessionCaptureSplitJob(work, code, message);
    if (!activeAbort?.signal.aborted && rawCode !== "STALE_ATTEMPT") console.error(`[CaptureSplit] Session ${work.sessionId} failed: ${message}`);
  } finally {
    activeAbort = null;
  }
}

export async function runSessionCaptureSplitQueueOnce(): Promise<boolean> {
  if (running || getRecordingStorageActivity().relocating) return false;
  const releaseStorage = beginRecordingStorageImport();
  running = true;
  try {
    if (shutdownRequested) return false;
    const jobs = await getQueuedSessionCaptureSplitJobs();
    if (shutdownRequested) return false;
    let work: SessionCaptureSplitWork | undefined;
    for (const candidate of jobs) {
      if (!await shouldHoldStartupSplitMigration(candidate)) {
        work = candidate;
        break;
      }
    }
    if (!work || shutdownRequested) return false;
    await execute(work);
    return true;
  } finally {
    running = false;
    releaseStorage();
  }
}

async function poll(): Promise<void> {
  if (stopped) return;
  try {
    await runSessionCaptureSplitQueueOnce();
  } catch (error) {
    console.error("[CaptureSplit] Queue poll failed:", error);
  } finally {
    if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
  }
}

export function startSessionCaptureSplitManager(): void {
  if (!stopped || shutdownRequested) return;
  stopped = false;
  void poll();
}

export async function stopSessionCaptureSplitManager(): Promise<void> {
  shutdownRequested = true;
  stopped = true;
  clearTimeout(timer ?? undefined);
  timer = null;
  activeAbort?.abort();
  while (running) await Bun.sleep(10);
}
