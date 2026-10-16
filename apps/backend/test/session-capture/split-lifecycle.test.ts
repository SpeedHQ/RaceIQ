import { afterAll, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rename, rm, writeFile, readFile, stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { db, client } from "@raceiq/backend-core/db/index";
import { laps, sessions, sessionCaptureSplitJobs } from "@raceiq/backend-core/db/schema";
import {
  enqueueSessionCaptureSplit,
  failSessionCaptureSplitJob,
  recoverSessionCaptureSplitJobs,
  updateSessionCaptureSplitProgress,
  validateSessionCaptureSplitRevision,
} from "@raceiq/backend-core/db/session-queries";
import { replaceLapsForSession } from "@raceiq/backend-core/db/lap-reprocessing-queries";
import { runSessionCaptureSplitQueueOnce } from "../../src/session-capture/split-manager";
import { resolveRecordingGameDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { splitCapturePromise } from "@raceiq/capture-splitting";

import { loadSessionCapture, resolveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
const sourceFrameOffset = encodeMetaFrame(1).length + encodeSparseCaptureFormatFrame().length;
const splitNotifications: Array<{ sessionId: number; jobId: string; attemptId: number; sequence: number; phase: string }> = [];
const broadcastSplitProgress = wsManager.broadcastSessionCaptureSplitProgress.bind(wsManager);
wsManager.broadcastSessionCaptureSplitProgress = (status) => {
  splitNotifications.push(status);
  broadcastSplitProgress(status);
};

const root = await mkdtemp(join(tmpdir(), "raceiq-split-lifecycle-"));
const sessionIds: number[] = [];
const bundleDirs = new Set<string>();

async function drainQueueUntilTerminal(sessionId: number): Promise<void> {
  for (let execution = 0; execution < 20; execution += 1) {
    const job = await db.select({ status: sessionCaptureSplitJobs.status })
      .from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get();
    if (job?.status === "failed" || job?.status === "ready") return;
    expect(job?.status).toBe("queued");
    expect(await runSessionCaptureSplitQueueOnce()).toBe(true);
  }
  throw new Error(`Session capture split job ${sessionId} did not reach a terminal state`);
}

async function makeSession(rawFile: string): Promise<{ id: number; lapId: number }> {
  const session = await db.insert(sessions).values({
    carId: "test-car", trackId: "test-track", gameId: "fm-2023", rawFile, ownership: "mine",
  }).returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const lap = await db.insert(laps).values({
    sessionId: session.id, lapNumber: 1, lapTime: 60, rawByteOffset: sourceFrameOffset, rawFrameCount: 1,
  }).returning({ id: laps.id }).get();
  return { id: session.id, lapId: lap.id };
}

afterAll(async () => {
  wsManager.broadcastSessionCaptureSplitProgress = broadcastSplitProgress;
  for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id)).run();
  await rm(root, { recursive: true, force: true });
  for (const directory of bundleDirs) await rm(directory, { recursive: true, force: true });
});

test("split lifecycle recovers attempts, rejects stale revisions, uses one worker, and publishes verified bundles", async () => {
  const sourcePath = join(root, "shared.bin");
  const sourceBytes = Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), encodeFrameLength(4), Buffer.from([1, 2, 3, 4])]);
  await writeFile(sourcePath, sourceBytes);
  const first = await makeSession(sourcePath);

  expect(await enqueueSessionCaptureSplit(first.id)).toBe(true);
  let firstJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, first.id)).get();
  expect(firstJob?.status).toBe("queued");
  expect(splitNotifications.at(-1)).toMatchObject({ sessionId: first.id, jobId: firstJob!.jobId, attemptId: 1, sequence: 0, phase: "queued" });
  await db.update(sessionCaptureSplitJobs).set({ status: "splitting" }).where(eq(sessionCaptureSplitJobs.sessionId, first.id)).run();
  await recoverSessionCaptureSplitJobs();
  firstJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, first.id)).get();
  expect(firstJob?.attemptId).toBe(2);
  expect(firstJob?.status).toBe("queued");
  const notificationsBeforeStaleProgress = splitNotifications.length;
  expect(await updateSessionCaptureSplitProgress({
    sessionId: first.id, jobId: firstJob!.jobId, attemptId: 1, sourceRevision: firstJob!.pendingSourceRevision,
    sequence: 1, phase: "splitting", completedLapArtifacts: 0, totalLapArtifacts: 1,
  })).toBe(false);
  expect(splitNotifications).toHaveLength(notificationsBeforeStaleProgress);
  await db.update(sessionCaptureSplitJobs).set({ status: "splitting" }).where(eq(sessionCaptureSplitJobs.sessionId, first.id)).run();
  expect(await updateSessionCaptureSplitProgress({
    sessionId: first.id, jobId: firstJob!.jobId, attemptId: 2, sourceRevision: firstJob!.pendingSourceRevision,
    sequence: 1, phase: "splitting", completedLapArtifacts: 0, totalLapArtifacts: 1,
  })).toBe(true);
  expect(await updateSessionCaptureSplitProgress({
    sessionId: first.id, jobId: firstJob!.jobId, attemptId: 2, sourceRevision: firstJob!.pendingSourceRevision,
    sequence: 1, phase: "splitting", completedLapArtifacts: 0, totalLapArtifacts: 1,
  })).toBe(false);
  await recoverSessionCaptureSplitJobs();

  const secondSourcePath = join(root, "second.bin");
  await writeFile(secondSourcePath, sourceBytes);
  const second = await makeSession(secondSourcePath);
  await db.update(sessions).set({ ownership: "others" }).where(eq(sessions.id, second.id)).run();
  expect(await enqueueSessionCaptureSplit(second.id)).toBe(true);
  let secondJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, second.id)).get();
  const secondWork = {
    sessionId: second.id, jobId: secondJob!.jobId, attemptId: 1, sourceRevision: secondJob!.pendingSourceRevision,
    sourcePath: secondSourcePath, gameId: "fm-2023" as const, ownership: "others" as const, carId: "test-car", trackId: "test-track",
    windows: [{ lapId: String(second.lapId), lapNumber: 1, startByteOffset: sourceFrameOffset, frameCount: 1 }],
  };
  await db.update(sessions).set({ gameId: "acc" }).where(eq(sessions.id, second.id)).run();
  expect(await validateSessionCaptureSplitRevision(secondWork)).toBe(false);
  await db.update(sessions).set({ gameId: "fm-2023" }).where(eq(sessions.id, second.id)).run();
  const queuedBeforeRevision = secondJob!.jobId;
  await writeFile(secondSourcePath, Buffer.concat([sourceBytes, Buffer.from([9])]));
  expect(await enqueueSessionCaptureSplit(second.id)).toBe(true);
  secondJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, second.id)).get();
  expect(secondJob?.status).toBe("queued");
  expect(secondJob?.jobId).not.toBe(queuedBeforeRevision);
  await writeFile(secondSourcePath, sourceBytes);
  expect(await enqueueSessionCaptureSplit(second.id)).toBe(true);
  secondJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, second.id)).get();
  const retryPath = join(root, "retry.bin");
  await writeFile(retryPath, sourceBytes);
  const third = await makeSession(retryPath);
  expect(await enqueueSessionCaptureSplit(third.id)).toBe(true);
  let failed = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, third.id)).get();
  await db.update(sessionCaptureSplitJobs).set({ status: "splitting" }).where(eq(sessionCaptureSplitJobs.sessionId, third.id)).run();
  const thirdWork = {
    sessionId: third.id, jobId: failed!.jobId, attemptId: 1, sourceRevision: failed!.pendingSourceRevision,
    sourcePath: retryPath, gameId: "fm-2023" as const, ownership: "mine" as const, carId: "test-car", trackId: "test-track",
    windows: [{ lapId: String(third.lapId), lapNumber: 1, startByteOffset: sourceFrameOffset, frameCount: 1 }],
  };
  const sequenceBeforeFailure = failed!.sequence;
  await failSessionCaptureSplitJob(thirdWork, "worker-failed", "deterministic failure");
  failed = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, third.id)).get();
  expect(failed?.status).toBe("failed");
  expect(failed!.sequence).toBeGreaterThan(sequenceBeforeFailure);
  expect(await updateSessionCaptureSplitProgress({
    sessionId: third.id, jobId: failed!.jobId, attemptId: failed!.attemptId,
    sourceRevision: failed!.pendingSourceRevision, sequence: failed!.sequence + 1,
    phase: "splitting", completedLapArtifacts: 0, totalLapArtifacts: 1,
  })).toBe(false);
  expect(splitNotifications.some((status) => status.sessionId === third.id && status.phase === "failed")).toBe(true);
  await writeFile(retryPath, Buffer.concat([sourceBytes, encodeFrameLength(4), Buffer.from([5, 6, 7, 8])]));
  expect(await validateSessionCaptureSplitRevision(thirdWork)).toBe(false);
  expect(await enqueueSessionCaptureSplit(third.id)).toBe(true);
  const requeued = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, third.id)).get();
  expect(requeued?.status).toBe("queued");
  expect(requeued?.jobId).not.toBe(failed?.jobId);
  expect(await validateSessionCaptureSplitRevision({
    ...thirdWork,
    jobId: requeued!.jobId,
    attemptId: requeued!.attemptId,
    sourceRevision: requeued!.pendingSourceRevision!,
  })).toBe(true);

  const firstRun = runSessionCaptureSplitQueueOnce();
  expect(await runSessionCaptureSplitQueueOnce()).toBe(false);
  expect(await firstRun).toBe(true);
  expect(await runSessionCaptureSplitQueueOnce()).toBe(true);
  expect(await runSessionCaptureSplitQueueOnce()).toBe(true);
  expect(splitNotifications.some((status) => status.sessionId === first.id && status.phase === "ready")).toBe(true);
  const publishedFirst = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, first.id)).get();
  const publishedSecond = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, second.id)).get();
  const publishedThird = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, third.id)).get();
  expect(publishedFirst?.status).toBe("ready");
  expect(publishedSecond?.status).toBe("ready");
  expect(publishedThird?.status).toBe("ready");
  expect(publishedFirst?.completedLapArtifacts).toBe(1);
  expect(publishedSecond?.completedLapArtifacts).toBe(1);
  const firstLap = await db.select().from(laps).where(eq(laps.id, first.lapId)).get();
  const secondLap = await db.select().from(laps).where(eq(laps.id, second.lapId)).get();
  expect(firstLap?.captureChunkId).toBeTruthy();
  expect(secondLap?.captureChunkId).toBeTruthy();
  expect(firstLap?.sourceFrameStart).toBeNull();
  expect(firstLap?.rawByteOffset).toBe(sourceFrameOffset);
  expect(firstLap?.rawFrameCount).toBe(1);
  const firstSession = await db.select().from(sessions).where(eq(sessions.id, first.id)).get();
  const secondSession = await db.select().from(sessions).where(eq(sessions.id, second.id)).get();
  const thirdSession = await db.select().from(sessions).where(eq(sessions.id, third.id)).get();
  expect(firstSession?.captureLayoutVersion).toBe(2);
  expect(firstSession?.captureManifestFile).not.toBe(secondSession?.captureManifestFile);
  for (const path of [firstSession?.captureManifestFile, secondSession?.captureManifestFile, thirdSession?.captureManifestFile]) {
    if (path) bundleDirs.add(dirname(path));
  }
  const manifestPath = firstSession!.captureManifestFile!;
  const resolved = await resolveLapCaptureArtifact(manifestPath, firstLap!.captureChunkId!, first.lapId);
  const restored = await loadSessionCapture({ rawFile: resolved.path, artifact: resolved.artifact, source: null, gameId: "fm-2023", carId: "test-car", trackId: "test-track" });
  expect([...iterateSessionCaptureRecords(restored)].filter((record) => record.kind === "frame").map((record) => record.frame)).toEqual([Buffer.from([1, 2, 3, 4])]);
  expect(dirname(dirname(dirname(manifestPath)))).toBe(resolveRecordingGameDirectory("fm-2023", "mine"));
  expect(dirname(dirname(dirname(secondSession!.captureManifestFile!)))).toBe(resolveRecordingGameDirectory("fm-2023", "others"));
  expect(firstSession?.captureArchiveFile).toBe(resolved.path);
  expect((await stat(manifestPath)).isFile()).toBe(true);
  expect(await readFile(sourcePath)).toEqual(sourceBytes);
  await db.update(laps).set({ isFavorite: true, notes: "preserve" }).where(eq(laps.id, first.lapId)).run();
  await replaceLapsForSession(first.id, [{
    lapId: first.lapId, lapNumber: 1, lapTime: 61, isValid: true, isFavorite: true,
    rawByteOffset: sourceFrameOffset, rawFrameCount: 1,
    tuneId: null, notes: "preserve", invalidReason: null, sectors: null,
  }]);
  const unchangedLayout = await db.select().from(sessions).where(eq(sessions.id, first.id)).get();
  expect(unchangedLayout?.captureLayoutVersion).toBe(2);
  expect((await db.select().from(laps).where(eq(laps.id, first.lapId)).get())?.captureChunkId).toBeTruthy();
  await replaceLapsForSession(first.id, [{
    lapId: first.lapId, lapNumber: 1, lapTime: 61, isValid: true, isFavorite: true,
    rawByteOffset: sourceFrameOffset, rawFrameCount: 1,
    tuneId: null, notes: "preserve", invalidReason: null, sectors: null,
  }], { carId: "identity-updated", trackId: "test-track" });
  const identityInvalidated = await db.select().from(sessions).where(eq(sessions.id, first.id)).get();
  const invalidatedJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, first.id)).get();
  expect(identityInvalidated?.captureLayoutVersion).toBeNull();
  expect(identityInvalidated?.captureArchiveFile).toBeNull();
  expect(invalidatedJob?.status).toBe("failed");
  expect(invalidatedJob?.errorCode).toBe("stale-publication");
  expect(await enqueueSessionCaptureSplit(first.id)).toBe(true);
  const identityRequeued = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, first.id)).get();
  expect(identityRequeued?.status).toBe("queued");
  expect(identityRequeued?.jobId).not.toBe(invalidatedJob?.jobId);
  expect(splitNotifications.at(-1)).toMatchObject({ sessionId: first.id, jobId: identityRequeued!.jobId, phase: "queued" });
  expect(await runSessionCaptureSplitQueueOnce()).toBe(true);
  expect((await db.select().from(sessions).where(eq(sessions.id, first.id)).get())?.captureLayoutVersion).toBe(2);
  await replaceLapsForSession(first.id, [
    {
      lapId: first.lapId, lapNumber: 1, lapTime: 61, isValid: true, isFavorite: true,
      rawByteOffset: sourceFrameOffset, rawFrameCount: 2,
      tuneId: null, notes: "preserve", invalidReason: null, sectors: null,
    },
    {
      lapId: null, lapNumber: 2, lapTime: 62, isValid: true, isFavorite: false,
      rawByteOffset: sourceFrameOffset + 5, rawFrameCount: 1,
      tuneId: null, notes: null, invalidReason: null, sectors: null,
    },
  ]);
  const invalidatedSession = await db.select().from(sessions).where(eq(sessions.id, first.id)).get();
  const replacedLaps = await db.select().from(laps).where(eq(laps.sessionId, first.id)).all();
  expect(invalidatedSession?.captureLayoutVersion).toBeNull();
  expect(invalidatedSession?.captureManifestFile).toBeNull();
  expect(invalidatedSession?.captureArchiveFile).toBeNull();
  expect(replacedLaps.find(({ id }) => id === first.lapId)).toMatchObject({ isFavorite: true, notes: "preserve" });
  expect(replacedLaps.every(({ captureChunkId }) => captureChunkId === null)).toBe(true);
  expect(replacedLaps.some(({ id }) => id !== first.lapId)).toBe(true);
  expect(await enqueueSessionCaptureSplit(first.id)).toBe(true);

  const brokenPath = join(root, "broken.bin");
  await writeFile(brokenPath, Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), Buffer.from([0, 0])]));
  const broken = await makeSession(brokenPath);
  expect(await enqueueSessionCaptureSplit(broken.id)).toBe(true);
  await drainQueueUntilTerminal(broken.id);
  const workerFailed = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, broken.id)).get();
  expect(workerFailed?.status).toBe("failed");
  expect(workerFailed?.errorCode).toBe("malformed-capture");
  expect(await readFile(brokenPath)).toEqual(Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), Buffer.from([0, 0])]));
  const brokenSession = await db.select().from(sessions).where(eq(sessions.id, broken.id)).get();
  expect(brokenSession?.captureLayoutVersion).toBeNull();
  expect(brokenSession?.captureManifestFile).toBeNull();
  expect((await db.select().from(laps).where(eq(laps.id, broken.lapId)).get())?.captureChunkId).toBeNull();
  const exhaustedPath = join(root, "exhausted.bin");
  await writeFile(exhaustedPath, sourceBytes);
  const exhausted = await makeSession(exhaustedPath);
  expect(await enqueueSessionCaptureSplit(exhausted.id)).toBe(true);
  await db.update(sessionCaptureSplitJobs).set({ status: "splitting", attemptId: 3 }).where(eq(sessionCaptureSplitJobs.sessionId, exhausted.id)).run();
  await recoverSessionCaptureSplitJobs();
  const exhaustedJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, exhausted.id)).get();
  expect(exhaustedJob?.status).toBe("failed");
  expect(exhaustedJob?.attemptId).toBe(3);
  expect(exhaustedJob?.errorCode).toBe("worker-failed");
  const exhaustedJobId = exhaustedJob?.jobId;
  await recoverSessionCaptureSplitJobs();
  const stillExhausted = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, exhausted.id)).get();
  expect(stillExhausted?.status).toBe("failed");
  expect(stillExhausted?.jobId).toBe(exhaustedJobId);
});

test("post-commit notification failure leaves published bundle readable", async () => {
  const sourcePath = join(root, "notification-failure.bin");
  const sourceBytes = Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), encodeFrameLength(4), Buffer.from([5, 6, 7, 8])]);
  await writeFile(sourcePath, sourceBytes);
  const session = await makeSession(sourcePath);
  const send = wsManager.broadcastSessionCaptureSplitProgress;
  wsManager.broadcastSessionCaptureSplitProgress = (status) => {
    if (status.sessionId === session.id && status.phase === "ready") throw new Error("Injected ready notification failure");
    send(status);
  };
  try {
    expect(await enqueueSessionCaptureSplit(session.id)).toBe(true);
    await drainQueueUntilTerminal(session.id);
    const published = await db.select().from(sessions).where(eq(sessions.id, session.id)).get();
    expect(published?.captureLayoutVersion).toBe(2);
    const manifestPath = published!.captureManifestFile!;
    bundleDirs.add(dirname(manifestPath));
    const publishedLap = await db.select().from(laps).where(eq(laps.id, session.lapId)).get();
    const resolved = await resolveLapCaptureArtifact(manifestPath, publishedLap!.captureChunkId!, session.lapId);
    const bytes = await loadSessionCapture({ rawFile: resolved.path, artifact: resolved.artifact, source: null, gameId: "fm-2023", carId: "test-car", trackId: "test-track" });
    const records = [...iterateSessionCaptureRecords(bytes, undefined, { strict: true })];
    expect(records.filter((record) => record.kind === "frame").map((record) => record.frame)).toEqual([Buffer.from([5, 6, 7, 8])]);
    expect((await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, session.id)).get())?.status).toBe("ready");
  } finally {
    wsManager.broadcastSessionCaptureSplitProgress = send;
  }
});

test("failed publication transaction removes renamed output, rolls back lap refs, and retries safely", async () => {
  const sourcePath = join(root, "transaction-failure.bin");
  const bytes = Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), encodeFrameLength(4), Buffer.from([9, 8, 7, 6])]);
  await writeFile(sourcePath, bytes);
  const session = await makeSession(sourcePath);
  const trigger = `fail_capture_publication_${session.id}`;
  await client.execute(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF capture_layout_version ON sessions
    WHEN NEW.id = ${session.id} AND NEW.capture_layout_version = 2
    BEGIN SELECT RAISE(FAIL, 'Injected split publication failure'); END`);
  try {
    expect(await enqueueSessionCaptureSplit(session.id)).toBe(true);
    await drainQueueUntilTerminal(session.id);
    const failed = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, session.id)).get();
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("publication-failed");
    const row = await db.select().from(sessions).where(eq(sessions.id, session.id)).get();
    expect(row?.captureLayoutVersion).toBeNull();
    expect(row?.captureManifestFile).toBeNull();
    expect(row?.captureArchiveFile).toBeNull();
    expect((await db.select().from(laps).where(eq(laps.id, session.lapId)).get())?.captureChunkId).toBeNull();
    const parent = join(resolveRecordingGameDirectory("fm-2023", "mine"), `session-${session.id}`);
    const attempt = `${failed!.jobId}-${failed!.attemptId}-${failed!.pendingSourceRevision}`;
    expect(await Bun.file(join(parent, attempt, "capture.bin.gz")).exists()).toBe(false);
    expect(await Bun.file(join(parent, `${attempt}.staging`, "capture.bin.gz")).exists()).toBe(false);
    expect(await readFile(sourcePath)).toEqual(bytes);
  } finally { await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`); }
  expect(await enqueueSessionCaptureSplit(session.id)).toBe(true);
  await drainQueueUntilTerminal(session.id);
  const published = await db.select().from(sessions).where(eq(sessions.id, session.id)).get();
  expect(published?.captureLayoutVersion).toBe(2);
  expect(await Bun.file(published!.captureArchiveFile!).exists()).toBe(true);
  bundleDirs.add(dirname(published!.captureManifestFile!));
});

test.each([false, true])("restart fences a closed unpublished archive; rename completed: %s", async (renamed) => {
  const sourcePath = join(root, `interrupted-${renamed}.bin`);
  await writeFile(sourcePath, Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), encodeFrameLength(4), Buffer.from([6, 7, 8, 9])]));
  const session = await makeSession(sourcePath);
  expect(await enqueueSessionCaptureSplit(session.id)).toBe(true);
  const job = (await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, session.id)).get())!;
  const parent = join(resolveRecordingGameDirectory("fm-2023", "mine"), `session-${session.id}`);
  const attempt = join(parent, `${job.jobId}-${job.attemptId}-${job.pendingSourceRevision}`);
  const staging = `${attempt}.staging`;
  await splitCapturePromise({ sourcePath, outputDirectory: staging, gameId: "fm-2023", sourceRevision: job.pendingSourceRevision,
    lapWindows: [{lapId:String(session.lapId),lapNumber:1,startByteOffset:sourceFrameOffset,frameCount:1}] });
  if (renamed) await rename(staging, attempt);
  await db.update(sessionCaptureSplitJobs).set({status:renamed ? "publishing" : "verifying",stagingPath:staging})
    .where(eq(sessionCaptureSplitJobs.sessionId,session.id)).run();
  await recoverSessionCaptureSplitJobs();
  const recovered = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId,session.id)).get();
  expect(recovered?.attemptId).toBe(job.attemptId + 1);
  expect(recovered?.status).toBe("queued");
  expect(await Bun.file(join(staging,"capture.bin.gz")).exists()).toBe(false);
  expect(await Bun.file(join(attempt,"capture.bin.gz")).exists()).toBe(false);
  expect((await db.select().from(sessions).where(eq(sessions.id,session.id)).get())?.captureLayoutVersion).toBeNull();
  await drainQueueUntilTerminal(session.id);
  const published = await db.select().from(sessions).where(eq(sessions.id,session.id)).get();
  expect(published?.captureLayoutVersion).toBe(2);
  expect(published?.captureManifestFile).not.toBe(join(attempt,"manifest.json"));
  bundleDirs.add(dirname(published!.captureManifestFile!));
});

test("archive write failure exposes no publication and a fresh attempt can retry", async () => {
  const sourcePath = join(root, "archive-write-failure.bin");
  const bytes = Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), encodeFrameLength(4), Buffer.from([4, 3, 2, 1])]);
  await writeFile(sourcePath, bytes);
  const session = await makeSession(sourcePath);
  const parent = join(resolveRecordingGameDirectory("fm-2023", "mine"), `session-${session.id}`);
  bundleDirs.add(parent);
  expect(await enqueueSessionCaptureSplit(session.id)).toBe(true);
  const queued = (await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId,session.id)).get())!;
  const attempt = `${queued.jobId}-${queued.attemptId}-${queued.pendingSourceRevision}`;
  // The real worker shares this filesystem, not the test process's module mocks.
  await mkdir(join(parent,`${attempt}.staging`,"capture.bin.gz"),{recursive:true});
  await drainQueueUntilTerminal(session.id);
  const failed = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, session.id)).get();
  expect(failed?.status).toBe("failed");
  expect(failed?.errorCode).toBe("source-io");
  const row = await db.select().from(sessions).where(eq(sessions.id, session.id)).get();
  expect(row?.captureLayoutVersion).toBeNull();
  expect(row?.captureManifestFile).toBeNull();
  expect(row?.captureArchiveFile).toBeNull();
  expect((await db.select().from(laps).where(eq(laps.id, session.lapId)).get())?.captureChunkId).toBeNull();
  expect(await Bun.file(join(parent,attempt,"manifest.json")).exists()).toBe(false);
  expect(await Bun.file(join(parent,`${attempt}.staging`,"capture.bin.gz")).exists()).toBe(false);
  expect(await readFile(sourcePath)).toEqual(bytes);
  expect(await enqueueSessionCaptureSplit(session.id)).toBe(true);
  await drainQueueUntilTerminal(session.id);
  const published = await db.select().from(sessions).where(eq(sessions.id,session.id)).get();
  expect(published?.captureLayoutVersion).toBe(2);
  bundleDirs.add(dirname(published!.captureManifestFile!));
});
