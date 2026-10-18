import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import { createLiveCaptureWorker } from "../../src/session-capture/live-worker-factory";
import { decompressIfGzipSync, encodeFrameLength, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";
import { LiveArchiveMemberSchema, LiveArchiveSnapshotSchema, openLiveCaptureMember, updateNativeRecordDigest } from "@raceiq/capture-splitting";
import { Schema } from "effect";

let worker: Worker | undefined;
let root: string | undefined;
afterEach(async () => {
  await worker?.terminate();
  if (root) await rm(root, { recursive: true, force: true });
  worker = undefined;
  root = undefined;
});

for (const trimmedPrefixFrames of [0, 1]) test(`production live worker catches up through late ownership with ${trimmedPrefixFrames} trimmed prefix frames`, async () => {
  root = await mkdtemp(join(tmpdir(), "raceiq-live-catchup-"));
  const sourcePath = join(root, "source.bin"), archivePath = join(root, "capture.bin.gz");
  const captureEpoch = randomUUID(), attempt = randomUUID();
  const nativeFrames: Buffer[] = [];
  const fixture = decompressIfGzipSync(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/fm-2023-with-pitting.bin.gz")));
  for (const record of iterateSessionCaptureRecords(fixture)) {
    if (record.kind === "frame") nativeFrames.push(record.frame);
    if (nativeFrames.length === 16) break;
  }
  expect(nativeFrames).toHaveLength(16);
  const instance = createLiveCaptureWorker("fm-2023");
  worker = instance;
  const recorder = new WorkerSessionRecorder("fm-2023", { worker: instance, canonicalRawCaptureBytes: true, headerCountOffset: null, maxBatchBytes: 1024 * 1024, maxInFlightBytes: 4 * 1024 * 1024 });
  let encodedSourceEvents = 0;
  let firstStart: number | undefined;
  let secondFrameStart: number | undefined;
  let latestSourceEnd = 0;
  recorder.onEncodedSourceEvent((event) => {
    encodedSourceEvents++;
    if (encodedSourceEvents === 1) firstStart = event.sourceOffset;
    if (encodedSourceEvents === 2) secondFrameStart = event.sourceOffset;
    latestSourceEnd = event.sourceEndOffset;
  });
  const ready = new Map<string, PromiseWithResolvers<Record<string, unknown>>>();
  const selectedCandidateId = trimmedPrefixFrames ? "trimmed" : "old";
  for (const id of [selectedCandidateId, "next"]) ready.set(id, Promise.withResolvers<Record<string, unknown>>());
  const sealed = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const controlAcks = new Set<number>();
  const controlWaiters = new Map<number, PromiseWithResolvers<void>>();
  const applied = new Map<number, PromiseWithResolvers<void>>();
  let nextGeneration = 0;
  const rejectWaiters = (error: Error) => {
    started.reject(error);
    sealed.reject(error);
    for (const item of ready.values()) item.reject(error);
    for (const item of controlWaiters.values()) item.reject(error);
    for (const item of applied.values()) item.reject(error);
  };
  instance.on("error", (error) => rejectWaiters(error instanceof Error ? error : new Error(String(error))));
  instance.on("message", (message: Record<string, unknown>) => {
    if (message.type === "capture-control-ack" && typeof message.sequence === "number") {
      if (typeof message.error === "string") {
        const error = new Error(message.error);
        controlWaiters.get(message.sequence)?.reject(error);
        applied.get(message.sequence)?.reject(error);
      } else {
        controlAcks.add(message.sequence);
        controlWaiters.get(message.sequence)?.resolve();
      }
      return;
    }
    if (message.captureEpoch !== captureEpoch) return;
    if (message.type === "live-started") started.resolve();
    if (message.type === "live-sealed") sealed.resolve();
    if (message.type === "live-failed") rejectWaiters(new Error(String(message.message)));
    if (message.type === "live-control-applied" && typeof message.sequence === "number") applied.get(message.sequence)?.resolve();
    if (message.type === "member-ready") {
      nextGeneration++;
      instance.postMessage({ type: "commit-result", captureEpoch, candidateId: message.candidateId, accepted: true, generation: nextGeneration });
      if (typeof message.candidateId === "string") ready.get(message.candidateId)?.resolve(message);
    }
  });
  recorder.start(sourcePath);
  instance.postMessage({ type: "start-live", captureEpoch, attempt, sessionId: 1, sourcePath, archivePath,
    maxQueuedBytes: 1024 * 1024, maxUnresolvedBytes: 1024 * 1024 });
  await started.promise;

  let serial = 0;
  const sendControl = (typeName: string, payload: Record<string, unknown>) => {
    const controlPayload = { ...payload, captureEpoch };
    const bytes = Buffer.byteLength(JSON.stringify(controlPayload));
    serial = recorder.postOrderedControl(typeName, controlPayload, bytes);
    const ack = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    controlWaiters.set(serial, ack);
    applied.set(serial, done);
    if (controlAcks.has(serial)) ack.resolve();
    return Promise.all([ack.promise, done.promise]);
  };
  const writeRecord = (frame: Buffer, timestamp: number) => {
    recorder.writeRawCaptureBytes(Buffer.concat([encodeFrameLength(frame.byteLength, timestamp), frame]));
  };
  // Small repeated native fixture keeps expected data bounded while forcing the production 1024-record cache miss.
  recorder.writeMetaFrame();
  for (let i = 0; i < 4; i++) writeRecord(nativeFrames[i]!, i * 10);
  const firstCandidateStart = firstStart;
  const nextCandidateStart = latestSourceEnd;
  if (firstCandidateStart === undefined || nextCandidateStart === undefined) throw new Error("Encoded source bridge omitted candidate coordinates");
  const parserPlan = { gameId: "fm-2023", sequence: 0, anchorSequence: 0, anchorPayload: new Uint8Array(), precedingRecords: [] };
  await sendControl("candidate-start", { candidateId: "old", lapNumber: 0, startByteOffset: firstCandidateStart, preparationOnly: false, parserPlan });
  const ownedStart = trimmedPrefixFrames ? secondFrameStart : firstCandidateStart;
  if (ownedStart === undefined) throw new Error("Prepared trimmed start is missing");
  if (trimmedPrefixFrames) await sendControl("candidate-start", { candidateId: selectedCandidateId, lapNumber: 0,
    startByteOffset: ownedStart, preparationOnly: true, parserPlan });
  await sendControl("candidate-start", { candidateId: "next", lapNumber: 1, startByteOffset: nextCandidateStart, preparationOnly: false, parserPlan });
  const delayedRecords = Number(process.env.RACEIQ_LIVE_STRESS_RECORDS ?? 1100);
  if (!Number.isSafeInteger(delayedRecords) || delayedRecords < 1100 || delayedRecords > 1_000_000) throw new Error("Invalid live stress record count");
  const rssSamples: Array<{ records: number; rssBytes: number }> = [];
  const sampleEvery = Math.ceil(delayedRecords / 32);
  for (let i = 0; i < delayedRecords; i++) {
    writeRecord(nativeFrames[i % nativeFrames.length]!, 40 + i * 10);
    if ((i + 1) % 512 === 0) await recorder.requestSync();
    if ((i + 1) % sampleEvery === 0) rssSamples.push({ records: i + 1, rssBytes: process.memoryUsage().rss });
  }
  await recorder.requestSync();
  const oldEnd = latestSourceEnd;
  if (oldEnd <= nextCandidateStart) throw new Error("Canonical source bridge did not advance past candidate start");
  const producerStarted = Promise.withResolvers<void>();
  const producerFinished = Promise.withResolvers<void>();
  let producerRecordsWritten = 0;
  let producerRunning = false;
  let keepProducing = true;
  const produceWhileCatchingUp = async () => {
    producerRunning = true;
    producerStarted.resolve();
    while (keepProducing) {
      const batch = producerRecordsWritten / 16;
      if (producerRecordsWritten >= 65_536) throw new Error("Catch-up did not complete within the concurrent source budget");
      for (let i = 0; i < 16; i++) {
        writeRecord(nativeFrames[(batch + i) % nativeFrames.length]!, 20_000 + producerRecordsWritten * 10);
        producerRecordsWritten++;
      }
      await recorder.requestSync();
    }
    producerRunning = false;
    producerFinished.resolve();
  };
  const producer = produceWhileCatchingUp();
  await producerStarted.promise;
  // Producer admits bounded batches while worker catches up from the durable, cache-missed prefix.
  await recorder.requestSync();
  await sendControl("ownership-finalized", { candidateId: "next", revision: 2, ownershipJournalSequence: 2, ownershipSourceByteEnd: oldEnd,
    window: { lapId: "lap-next", lapNumber: 1, startByteOffset: nextCandidateStart, frameCount: 4, trailingContextFrameCount: 0 } });
  await sendControl("lap-binding", { candidateId: "next", lapId: "lap-next", ownershipJournalSequence: 2, ownershipSourceByteEnd: oldEnd });
  const watermarkAcks = Array.from({ length: 130 }, () => sendControl("watermark", { sourceByteOffset: oldEnd }));
  const recordsAtCatchupStart = producerRecordsWritten;
  // Backlogged progress fences must all settle without hiding late ownership or binding from durable lookahead.
  const finalControls = [
    sendControl("ownership-finalized", { candidateId: selectedCandidateId, revision: 1, ownershipJournalSequence: 1, ownershipSourceByteEnd: oldEnd,
      window: { lapId: "lap-old", lapNumber: 0, startByteOffset: ownedStart, frameCount: 4 - trimmedPrefixFrames, trailingContextFrameCount: 0 } }),
    sendControl("lap-binding", { candidateId: selectedCandidateId, lapId: "lap-old", ownershipJournalSequence: 1, ownershipSourceByteEnd: oldEnd }),
  ];
  const [oldMember, nextMember] = await Promise.all([ready.get(selectedCandidateId)!.promise, ready.get("next")!.promise]);
  await Promise.all([...watermarkAcks, ...finalControls]);
  expect(producerRunning).toBe(true);
  expect(producerRecordsWritten).toBeGreaterThan(recordsAtCatchupStart);
  keepProducing = false;
  await producerFinished.promise;
  await producer;
  const readVerifiedMember = async (message: Record<string, unknown>, expectedFrames: Buffer[], expectedTimes: number[]) => {
    const member = Schema.decodeUnknownSync(LiveArchiveMemberSchema)(message.member);
    const snapshot = Schema.decodeUnknownSync(LiveArchiveSnapshotSchema)({
      version: 5, gameId: "fm-2023", captureEpoch, attempt, generation: member.generation,
      committedArchiveLength: member.memberOffset + member.compressedByteLength,
      sourceDurableWatermark: oldEnd, metadataDurableWatermark: oldEnd, sourceRevision: "production-live-test",
      sourceByteLength: oldEnd, sourceRecordCount: delayedRecords + 4, archiveFile: "capture.bin.gz", sealed: false, member,
    });
    const archive = await openLiveCaptureMember(archivePath, snapshot);
    const bytes = await archive.readEntryBuffer(member.entryName, 1024 * 1024);
    const decoded = [...iterateSessionCaptureRecords(bytes, 0, { strict: true })]
      .filter((record) => record.kind === "frame");
    const digest = createHash("sha256");
    for (const record of decoded) updateNativeRecordDigest(digest, record);
    expect(decoded.map((record) => record.frame)).toEqual(expectedFrames);
    expect(decoded.map((record) => record.frameTimeMs)).toEqual(expectedTimes);
    if (typeof message.nativeDigest !== "string") throw new Error("Live member omitted native digest");
    expect(digest.digest("hex")).toBe(message.nativeDigest);
    expect(member.firstTimestamp).toBe(expectedTimes[0]);
  };
  await readVerifiedMember(oldMember, nativeFrames.slice(trimmedPrefixFrames, 4), [0, 10, 20, 30].slice(trimmedPrefixFrames));
  await readVerifiedMember(nextMember, nativeFrames.slice(0, 4), [40, 50, 60, 70]);
  const progressResult = Promise.withResolvers<Record<string, unknown>>();
  const onMessage = (message: Record<string, unknown>) => {
    if (message.captureEpoch === captureEpoch && message.type === "live-worker-progress" &&
      message.sourceCacheRecordLimit === 1024) {
      instance.off("message", onMessage);
      progressResult.resolve(message);
    }
    if (message.captureEpoch === captureEpoch && message.type === "live-failed") {
      progressResult.reject(new Error(String(message.message)));
    }
  };
  instance.on("message", onMessage);
  await sendControl("watermark", { sourceByteOffset: oldEnd });
  const progress = await progressResult.promise;
  expect(progress.sourceCacheRecords).toBeLessThanOrEqual(1024);
  expect(progress.queuedSourceRecords).toBeLessThanOrEqual(1024);
  expect(progress.unresolvedCandidates).toBeLessThanOrEqual(4);
  expect(progress.checkpointBytes).toBeLessThanOrEqual(8 * 1024 * 1024);

  expect(encodedSourceEvents).toBe(delayedRecords + 4 + producerRecordsWritten);
  expect(recorder.recording).toBe(true);
  writeRecord(nativeFrames[15]!, 20_000);
  const durable = await recorder.requestSync();
  expect(durable.sourceRecordCount).toBe(delayedRecords + 5 + producerRecordsWritten);
  expect(encodedSourceEvents).toBe(delayedRecords + 5 + producerRecordsWritten);
  const closeOffset = latestSourceEnd;
  const closing = sendControl("close-live", { sourceByteOffset: closeOffset });
  await closing;
  await sealed.promise;
  await recorder.stop();
  const reportPath = process.env.RACEIQ_LIVE_STRESS_OUTPUT;
  if (reportPath) {
    const late = rssSamples.filter((sample) => sample.records >= delayedRecords / 2).map((sample) => sample.rssBytes);
    const rssSpanBytes = Math.max(...late) - Math.min(...late);
    const plateauBudgetBytes = 64 * 1024 * 1024;
    const prefix = reportPath.endsWith(".json") ? reportPath.slice(0, -5) : reportPath;
    await Bun.write(`${prefix}-trim-${trimmedPrefixFrames}.json`, `${JSON.stringify({
      scenario: "real-production-worker-canonical-catchup", trimmedPrefixFrames, delayedRecords, producerRecordsWritten,
      rssSamples, rssSpanBytes, plateauBudgetBytes, progress,
      limitations: "Synthetic repeated native FM input; RSS includes producer and both shared worker registries. No game-rate or disk-latency claim.",
      passed: rssSpanBytes <= plateauBudgetBytes,
    }, null, 2)}\n`);
    expect(rssSpanBytes).toBeLessThanOrEqual(plateauBudgetBytes);
  }
}, process.env.RACEIQ_LIVE_STRESS_RECORDS ? 120_000 : 5_000);
