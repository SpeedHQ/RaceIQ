import { afterAll, expect, test } from "bun:test";
import { WorkerSessionRecorder, type EncodedSourceEvent } from "@raceiq/capture-formats/session/worker-recorder";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeFrameLength, encodeParserBootstrapFrame, encodeSegmentContextEndFrame,
  encodeSegmentContextFrame, iterateSessionCaptureRecords,
} from "@raceiq/capture-formats/session/framing";
import { Worker } from "node:worker_threads";

let syncRaceRoot: string | undefined;
afterAll(async () => { if (syncRaceRoot) await rm(syncRaceRoot, { recursive: true, force: true }); });

function nativeFrame(value: number) {
  const frame = Buffer.alloc(331);
  frame.writeUInt32LE(1, 0);
  frame.writeUInt32LE(value, 4);
  return frame;
}

test("source durability separates gameplay header count from logical reset, bootstrap, and context records", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-source-count-"));
  const path = join(root, "source.bin");
  const recorder = new WorkerSessionRecorder("fm-2023", { canonicalRawCaptureBytes: true });
  try {
    const first = nativeFrame(1), last = nativeFrame(2);
    recorder.start(path);
    recorder.writeMetaFrame();
    recorder.writeRecord(first);
    recorder.writeSegmentBoundary();
    recorder.writeRawCaptureBytes(encodeParserBootstrapFrame("fm-2023", Buffer.from("{}")));
    recorder.writeRawCaptureBytes(Buffer.concat([
      encodeSegmentContextFrame(), encodeFrameLength(first.length), first, encodeSegmentContextEndFrame(),
    ]));
    recorder.writeRecord(last, 0);
    expect(recorder.recordCount).toBe(2);
    expect(recorder.sourceRecordCount).toBe(7);
    const durable = await recorder.requestSync();
    expect(durable.frameCount).toBe(2);
    expect(durable.sourceRecordCount).toBe(7);
    await recorder.stop();
    expect(recorder.durableProgressValue.sourceRecordCount).toBe(7);
    const bytes = await readFile(path);
    expect(bytes.readUInt32LE(8)).toBe(2);
    const records = [...iterateSessionCaptureRecords(bytes, 0, { strict: true })];
    expect(records.map((record) => record.kind)).toEqual([
      "frame", "segment-boundary", "parser-bootstrap", "segment-context", "frame", "segment-context-end", "frame",
    ]);
    const frames = records.filter((record) => record.kind === "frame");
    expect(frames.map((record) => record.frame)).toEqual([first, first, last]);
    expect(frames.map((record) => record.frameTimeMs)).toEqual([undefined, undefined, 0]);
  } finally {
    await recorder.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("source overload advances neither gameplay nor logical count and drains the accepted prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-source-overload-"));
  const path = join(root, "source.bin");
  const recorder = new WorkerSessionRecorder("fm-2023", { canonicalRawCaptureBytes: true, maxBatchBytes: 1024 });
  try {
    const accepted = nativeFrame(10);
    recorder.start(path);
    recorder.writeMetaFrame();
    recorder.writeRecord(accepted, 123);
    const sync = recorder.requestSync();
    expect(() => recorder.writeRecord(Buffer.alloc(2048))).toThrow();
    expect(recorder.state).toBe("failed");
    expect(recorder.recordCount).toBe(1);
    expect(recorder.sourceRecordCount).toBe(1);
    expect((await sync).sourceRecordCount).toBe(1);
    const closeError = await recorder.stop().then(() => null, (error: unknown) => error);
    expect(closeError).toBeInstanceOf(Error);
    const bytes = await readFile(path);
    expect(bytes.readUInt32LE(8)).toBe(1);
    const records = [...iterateSessionCaptureRecords(bytes, 0, { strict: true })];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "frame", frame: accepted, frameTimeMs: 123 });
    expect(recorder.durableProgressValue.sourceRecordCount).toBe(1);
  } finally {
    await recorder.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted durability request completes when stop immediately closes admission", async () => {
  syncRaceRoot = await mkdtemp(join(tmpdir(), "raceiq-live-source-sync-close-"));
  const path = join(syncRaceRoot, "source.bin");
  const recorder = new WorkerSessionRecorder("fm-2023");
  const frame = nativeFrame(33);
  recorder.start(path);
  recorder.writeMetaFrame();
  recorder.writeRecord(frame, 0);
  const sync = recorder.requestSync();
  const close = recorder.stop();
  const [durable] = await Promise.all([sync, close]);
  expect(durable.sourceRecordCount).toBe(1);
  expect(durable.frameCount).toBe(1);
  const bytes = await readFile(path);
  expect(durable.sourceByteLength).toBe(bytes.byteLength);
  const records = [...iterateSessionCaptureRecords(bytes, 0, { strict: true })];
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: "frame", frame, frameTimeMs: 0 });
});

test("accepted durability request rejects with the original overload after the real writer fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-source-compound-failure-"));
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "preserve");
  const recorder = new WorkerSessionRecorder("fm-2023", { maxBatchBytes: 1024 });
  try {
    recorder.start(join(blocker, "source.bin"));
    recorder.writeRecord(nativeFrame(44));
    const sync = recorder.requestSync().then(() => null, (error: unknown) => error);
    expect(() => recorder.writeRecord(Buffer.alloc(2048))).toThrow("Source recording capacity exhausted");
    const overload = recorder.error;
    expect(overload).toBeInstanceOf(Error);
    expect(await sync).toBe(overload);
    expect(recorder.error).toBe(overload);
    const closeError = await recorder.stop().then(() => null, (error: unknown) => error);
    expect(closeError).toBe(overload);
    expect(await readFile(blocker, "utf8")).toBe("preserve");
  } finally {
    await recorder.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

for (const observe of [false, true]) {
  test(`standalone source admits one-copy transport with observer=${observe}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-source-single-copy-"));
    const path = join(root, "source.bin");
    const recorder = new WorkerSessionRecorder("fm-2023", { maxBatchBytes: 512, maxInFlightBytes: 2048, maxBatchDelayMs: 60_000 });
    const events: EncodedSourceEvent[] = [];
    if (observe) recorder.onEncodedSourceEvent((event) => events.push(event));
    const first = nativeFrame(51), second = nativeFrame(52);
    try {
      recorder.start(path);
      recorder.writeMetaFrame();
      recorder.writeRecord(first, 0);
      const pending = recorder.pendingBatchByteCount;
      expect(pending).toBeLessThanOrEqual(512);
      expect(recorder.inFlightByteCount).toBe(pending + (observe ? first.byteLength : 0));
      first.fill(0);
      await recorder.requestSync();
      const raw = Buffer.concat([encodeFrameLength(second.length, 123), second]);
      await recorder.writeRawCaptureRecordAsync(raw);
      raw.fill(0);
      await recorder.stop();
      const records = [...iterateSessionCaptureRecords(await readFile(path), 0, { strict: true })];
      expect(records.filter((record) => record.kind === "frame").map((record) => [record.frame, record.frameTimeMs])).toEqual([
        [nativeFrame(51), 0], [second, 123],
      ]);
      if (observe) {
        expect(events.map((event) => [event.kind, Buffer.from(event.bytes), event.frameTimeMs])).toEqual([
          ["frame", nativeFrame(51), 0],
          ["raw", Buffer.concat([encodeFrameLength(second.length, 123), second]), undefined],
        ]);
      }
    } finally {
      await recorder.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("supplied source worker consumes ordered native events while observers retain owned copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-source-shared-copy-"));
  const path = join(root, "source.bin");
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    import(${JSON.stringify(import.meta.resolve("@raceiq/capture-formats/session/source-writer-worker"))}).then(() => {
      parentPort.on("message", (message) => {
        if (message.type === "batch") {
          parentPort.postMessage({ type: "observed", events: message.records.map((record) => record.sourceEvent) });
        }
      });
      parentPort.postMessage({ type: "ready" });
    });
  `, { eval: true, workerData: { syncIntervalMs: 0 } });
  const ready = Promise.withResolvers<void>();
  worker.once("message", () => ready.resolve());
  await ready.promise;
  const recorder = new WorkerSessionRecorder("fm-2023", { worker, maxBatchBytes: 1024, maxBatchDelayMs: 60_000 });
  const observed: EncodedSourceEvent[] = [];
  const delivered: EncodedSourceEvent[] = [];
  recorder.onEncodedSourceEvent((event) => observed.push(event));
  worker.on("message", (message) => { if (message.type === "observed") delivered.push(...message.events); });
  try {
    recorder.start(path);
    recorder.writeMetaFrame();
    recorder.writeRecord(nativeFrame(61), 0);
    expect(recorder.inFlightByteCount).toBe(recorder.pendingBatchByteCount + 331);
    await recorder.requestSync();
    recorder.writeSegmentBoundary();
    const raw = Buffer.concat([encodeFrameLength(331, 234), nativeFrame(62)]);
    recorder.writeRawCaptureRecord(raw);
    await recorder.stop();
    expect(delivered.map((event) => [event.sequence, event.kind, Buffer.from(event.bytes), event.frameTimeMs])).toEqual([
      [1, "frame", nativeFrame(61), 0], [2, "segment-boundary", Buffer.alloc(0), undefined], [3, "raw", raw, undefined],
    ]);
    expect(observed).toEqual(delivered);
    const records = [...iterateSessionCaptureRecords(await readFile(path), 0, { strict: true })];
    expect(records.map((record) => record.kind)).toEqual(["frame", "segment-boundary", "frame"]);
    expect(records.filter((record) => record.kind === "frame").map((record) => [record.frame, record.frameTimeMs])).toEqual([
      [nativeFrame(61), 0], [nativeFrame(62), 234],
    ]);
  } finally {
    await recorder.stop().catch(() => {});
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
});

test("source writer does not reopen a file after a queued batch fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-source-fail-stop-"));
  const path = join(root, "source.bin");
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    const moduleUrl = ${JSON.stringify(import.meta.resolve("@raceiq/capture-formats/session/source-writer-worker"))};
    import(moduleUrl).then((writer) => {
      parentPort.postMessage({ type: "ready" });
      parentPort.on("message", async (message) => {
        if (message.type === "drain") {
          await writer.waitForSourcePrefix(1);
          parentPort.postMessage({ type: "drained" });
        }
      });
    });
  `, { eval: true, workerData: { syncIntervalMs: 0, failSequence: 2 } });
  await new Promise<void>((resolve) => worker.once("message", (message) => { if (message.type === "ready") resolve(); }));
  const messages: { type: string; sequence?: number }[] = [];
  const failed = new Promise<void>((resolve) => worker.on("message", (message) => {
    messages.push(message);
    if (message.type === "failed") resolve();
  }));
  const postBatch = (sequence: number, byte: number) => worker.postMessage({
    type: "batch",
    records: [{
      sequence, bytes: Buffer.from([byte]), chargeBytes: 1,
      sourceByteLength: sequence, frameCount: sequence, sourceRecordCount: sequence,
    }],
  });
  try {
    worker.postMessage({ type: "start", path });
    postBatch(1, 11);
    worker.postMessage({ type: "sync-request", requestId: 1, bytes: 0 });
    await new Promise<void>((resolve) => {
      const listener = (message: { type: string; requestId?: number }) => {
        if (message.type === "sync-ack" && message.requestId === 1) {
          worker.off("message", listener);
          resolve();
        }
      };
      worker.on("message", listener);
    });
    const durable = await readFile(path);
    postBatch(2, 22);
    postBatch(3, 33);
    worker.postMessage({ type: "sync-request", requestId: 2, bytes: 0 });
    worker.postMessage({ type: "close", count: 3, headerCountOffset: null });
    worker.postMessage({ type: "drain" });
    await new Promise<void>((resolve) => {
      const listener = (message: { type: string }) => {
        if (message.type === "drained") {
          worker.off("message", listener);
          resolve();
        }
      };
      worker.on("message", listener);
    });
    expect(messages.filter((message) => !["ready", "drained"].includes(message.type)).map((message) => message.type)).toEqual(["ack", "sync-ack", "failed"]);
    expect(await readFile(path)).toEqual(durable);
  } finally {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
});
test("premature worker exit rejects pending recorder close", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-source-worker-exit-"));
  const worker = new Worker("const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => {});", { eval: true });
  const recorder = new WorkerSessionRecorder("fm-2023", { worker });
  try {
    recorder.start(join(root, "source.bin"));
    const closing = recorder.stop().then(() => null, (error: unknown) => error);
    await worker.terminate();
    const closeError = await closing;
    expect(closeError).toBeInstanceOf(Error);
    expect((closeError as Error).message).toMatch(/^Source writer worker exited \(\d+\)$/);
  } finally {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
});

test("raw source admission reuses bounded disk credits without losing records", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-raw-source-pressure-"));
  const path = join(root, "source.bin");
  const recorder = new WorkerSessionRecorder("fm-2023", { maxBatchBytes: 1024, maxInFlightBytes: 1024, syncIntervalMs: 0 });
  const expected = Array.from({ length: 32 }, (_, index) => nativeFrame(index));
  try {
    recorder.start(path);
    recorder.writeMetaFrame();
    for (const [index, frame] of expected.entries()) {
      await recorder.writeRawCaptureRecordAsync(Buffer.concat([encodeFrameLength(frame.length, index), frame]));
      expect(recorder.inFlightByteCount).toBeLessThanOrEqual(1024);
    }
    await recorder.stop();
    const bytes = await readFile(path);
    expect(bytes.readUInt32LE(8)).toBe(32);
    const frames = [...iterateSessionCaptureRecords(bytes, 0, { strict: true })].filter(record => record.kind === "frame");
    expect(frames.map(record => record.frame)).toEqual(expected);
    expect(frames.map(record => record.frameTimeMs)).toEqual(expected.map((_, index) => index));
  } finally {
    await recorder.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

for (const termination of ["io-failure", "close"] as const) {
  test(`waiting raw admission rejects on ${termination} without advancing accepted count`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-raw-source-terminal-"));
    const blocker = join(root, "not-a-directory");
    if (termination === "io-failure") await writeFile(blocker, "preserve");
    const path = termination === "io-failure" ? join(blocker, "source.bin") : join(root, "source.bin");
    const recorder = new WorkerSessionRecorder("fm-2023", { maxBatchBytes: 768, maxInFlightBytes: 768, syncIntervalMs: 0 });
    const first = nativeFrame(11), second = nativeFrame(22);
    try {
      recorder.start(path);
      recorder.writeMetaFrame();
      recorder.writeRawCaptureRecord(Buffer.concat([encodeFrameLength(first.length), first]));
      const waiting = recorder.writeRawCaptureRecordAsync(Buffer.concat([encodeFrameLength(second.length), second])).then(() => null, (error: unknown) => error);
      if (termination === "close") {
        const closing = recorder.stop();
        expect(await waiting).toBeInstanceOf(Error);
        await closing;
        const frames = [...iterateSessionCaptureRecords(await readFile(path), 0, { strict: true })].filter(record => record.kind === "frame");
        expect(frames.map(record => record.frame)).toEqual([first]);
      } else {
        expect(await waiting).toBeInstanceOf(Error);
        expect(recorder.error).toBeInstanceOf(Error);
        expect(await readFile(blocker, "utf8")).toBe("preserve");
      }
      expect(recorder.recordCount).toBe(1);
      expect(recorder.sourceRecordCount).toBe(1);
    } finally {
      await recorder.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
