import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeFrameLength, encodeParserBootstrapFrame, encodeSegmentContextEndFrame,
  encodeSegmentContextFrame, iterateSessionCaptureRecords,
} from "@raceiq/capture-formats/session/framing";
import { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";
import { Worker } from "node:worker_threads";

let syncRaceRoot: string | undefined;
afterAll(async () => { if (syncRaceRoot) await rm(syncRaceRoot, { recursive: true, force: true }); });

function nativeFrame(value: number): Buffer {
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
    expect(() => recorder.writeRecord(Buffer.alloc(2048))).toThrow();
    expect(recorder.state).toBe("failed");
    expect(recorder.recordCount).toBe(1);
    expect(recorder.sourceRecordCount).toBe(1);
    await expect(recorder.stop()).rejects.toBeInstanceOf(Error);
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
test("premature worker exit rejects pending recorder close", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-source-worker-exit-"));
  const worker = new Worker("const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => {});", { eval: true });
  const recorder = new WorkerSessionRecorder("fm-2023", { worker });
  try {
    recorder.start(join(root, "source.bin"));
    const closing = recorder.stop();
    await worker.terminate();
    await expect(closing).rejects.toThrow(/^Source writer worker exited \(\d+\)$/);
  } finally {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
});
