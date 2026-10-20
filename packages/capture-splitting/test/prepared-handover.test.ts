import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import type { StreamingMemberStage, StreamingSplitterHost } from "../src/streaming";
import { FileStreamingSplitterHost } from "../src/streaming-host";
import { StreamingCaptureSplitter } from "../src/streaming-state";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("next stage accepts bytes during prior verification while commits remain ordered and close drains", async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-prepared-handover-"));
  const firstGate = deferred();
  const secondAppended = deferred();
  const commits: string[] = [];
  let stageNumber = 0;
  const fileHost = new FileStreamingSplitterHost({
    archivePath: join(root, "capture.bin.gz"), maxQueuedBytes: 4096, maxUnresolvedBytes: 4096,
    commit: async (descriptor) => { commits.push(descriptor.lap?.lapId ?? "auxiliary"); },
  });
  const host: StreamingSplitterHost = {
    maxQueuedBytes: fileHost.maxQueuedBytes, maxUnresolvedBytes: fileHost.maxUnresolvedBytes,
    createStage: async (kind, id) => {
      const stage = await fileHost.createStage(kind, id);
      const number = ++stageNumber;
      return new Proxy(stage, {
        get(target, property) {
          if (property === "append") return async (bytes: Uint8Array) => {
            await target.append(bytes);
            if (number === 2) secondAppended.resolve();
          };
          if (property === "verify") return async (...args: Parameters<StreamingMemberStage["verify"]>) => {
            if (number === 1) await firstGate.promise;
            return target.verify(...args);
          };
          return Reflect.get(target, property, target);
        },
      });
    },
    createPositionSpool: fileHost.createPositionSpool.bind(fileHost),
    replayEvidence: () => ({ sourceFrameCount: 1, parsedFrameCount: 1, nullFrameCount: 0, orderedTelemetryDigest: "test" }),
    replayParser: async () => {},
  };
  const splitter = new StreamingCaptureSplitter({ gameId: "fm-2023", host });
  const record = (offset: number): SessionCaptureRecord => ({ kind: "frame", offset, endOffset: offset + 16, frame: Buffer.from([offset]), frameTimeMs: offset });
  try {
    splitter.startCandidate("one", 1, 0, new Uint8Array());
    splitter.bindCandidate("one", "lap-one");
    splitter.finalizeCandidate("one", { lapId: "lap-one", lapNumber: 1, startByteOffset: 0, frameCount: 1 }, 1);
    splitter.startCandidate("two", 2, 16, new Uint8Array());
    splitter.bindCandidate("two", "lap-two");
    splitter.finalizeCandidate("two", { lapId: "lap-two", lapNumber: 2, startByteOffset: 16, frameCount: 2 }, 1);
    for (const item of [record(0), record(16), record(32)]) {
      splitter.enqueue(item); splitter.advanceWatermark(item.endOffset); await splitter.drain();
    }
    await secondAppended.promise;
    expect(commits).toEqual([]);
    const closing = splitter.close();
    firstGate.resolve();
    await closing;
    expect(commits).toEqual(["lap-one", "lap-two"]);
  } finally { firstGate.resolve(); await splitter.close().catch(() => undefined); await fileHost.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("a pending finalizer holds derived drain at capacity and preserves archive order", async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-prepared-capacity-"));
  const held = deferred();
  const entered = deferred();
  const secondAppended = deferred();
  const commits: string[] = [];
  let number = 0;
  const fileHost = new FileStreamingSplitterHost({ archivePath: join(root, "capture.bin.gz"), maxQueuedBytes: 4096, maxUnresolvedBytes: 4096,
    commit: async (descriptor) => { commits.push(descriptor.lap?.lapId ?? "auxiliary"); } });
  const host: StreamingSplitterHost = {
    maxQueuedBytes: fileHost.maxQueuedBytes, maxUnresolvedBytes: fileHost.maxUnresolvedBytes,
    createStage: async (kind, id) => {
      const stage = await fileHost.createStage(kind, id); const n = ++number;
      return new Proxy(stage, { get(target, property) {
        if (property === "append" && n === 2) return async (bytes: Uint8Array) => {
          await target.append(bytes);
          secondAppended.resolve();
        };
        if (property === "verify") return async (...args: Parameters<StreamingMemberStage["verify"]>) => {
          if (n === 1) { entered.resolve(); await held.promise; }
          return target.verify(...args);
        };
        return Reflect.get(target, property, target);
      } });
    },
    createPositionSpool: fileHost.createPositionSpool.bind(fileHost),
    replayEvidence: () => ({ sourceFrameCount: 1, parsedFrameCount: 1, nullFrameCount: 0, orderedTelemetryDigest: "test" }),
    replayParser: async () => {}, dispose: fileHost.dispose.bind(fileHost),
  };
  const splitter = new StreamingCaptureSplitter({ gameId: "fm-2023", host });
  const record = (offset: number): SessionCaptureRecord => ({ kind: "frame", offset, endOffset: offset + 16, frame: Buffer.from([offset]), frameTimeMs: offset });
  let boundary: Promise<void> | undefined;
  let boundaryResult: unknown;
  try {
    splitter.startCandidate("one", 1, 0, new Uint8Array()); splitter.bindCandidate("one", "lap-one");
    splitter.finalizeCandidate("one", { lapId: "lap-one", lapNumber: 1, startByteOffset: 0, frameCount: 1 }, 1);
    splitter.enqueue(record(0)); splitter.advanceWatermark(16); await splitter.drain();
    splitter.startCandidate("two", 2, 16, new Uint8Array()); splitter.bindCandidate("two", "lap-two");
    splitter.finalizeCandidate("two", { lapId: "lap-two", lapNumber: 2, startByteOffset: 16, frameCount: 1 }, 1);
    splitter.enqueue(record(16)); splitter.advanceWatermark(32);
    await entered.promise;
    await secondAppended.promise;
    splitter.startCandidate("three", 3, 32, new Uint8Array()); splitter.bindCandidate("three", "lap-three");
    splitter.finalizeCandidate("three", { lapId: "lap-three", lapNumber: 3, startByteOffset: 32, frameCount: 1 }, 1);
    splitter.enqueue(record(32)); splitter.advanceWatermark(48);
    boundary = splitter.drain().then(() => { boundaryResult = "resolved"; }, error => { boundaryResult = error; });
    expect(boundaryResult).toBeUndefined();
    held.resolve(); await boundary;
    await splitter.close();
    expect(commits).toEqual(["lap-one", "lap-two", "lap-three"]);
    const native = gunzipSync(Buffer.from(await Bun.file(join(root, "capture.bin.gz")).arrayBuffer()));
    const records: SessionCaptureRecord[] = [];
    for (const item of iterateSessionCaptureRecords(native, 0, { strict: true })) records.push(item);
    expect(records.filter(item => item.kind === "frame").map(item => [item.frameTimeMs, [...item.frame]])).toEqual([[0, [0]], [16, [16]], [32, [32]]]);
  } finally { held.resolve(); await boundary; await splitter.close().catch(() => undefined); await fileHost.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("failed background verification stops source feed and removes all staging", async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-prepared-failure-feed-"));
  const failed = deferred(); const committed: string[] = []; let errors = 0;
  const fileHost = new FileStreamingSplitterHost({ archivePath: join(root, "capture.bin.gz"), maxQueuedBytes: 4096, maxUnresolvedBytes: 4096,
    commit: async descriptor => { committed.push(descriptor.lap?.lapId ?? "auxiliary"); } });
  const host: StreamingSplitterHost = { maxQueuedBytes: fileHost.maxQueuedBytes, maxUnresolvedBytes: fileHost.maxUnresolvedBytes,
    createStage: async (kind, id) => { const stage = await fileHost.createStage(kind, id); return new Proxy(stage, { get(target, property) {
      if (property === "verify") return async () => { throw new Error("semantic verify failure"); };
      return Reflect.get(target, property, target);
    } }); },
    createPositionSpool: fileHost.createPositionSpool.bind(fileHost), replayEvidence: () => ({ sourceFrameCount: 1, parsedFrameCount: 1, nullFrameCount: 0, orderedTelemetryDigest: "test" }),
    replayParser: async () => {}, dispose: fileHost.dispose.bind(fileHost) };
  const splitter = new StreamingCaptureSplitter({ gameId: "fm-2023", host, onError: () => { errors++; failed.resolve(); } });
  const record = (offset: number): SessionCaptureRecord => ({ kind: "frame", offset, endOffset: offset + 16, frame: Buffer.from([offset]), frameTimeMs: offset });
  try {
    splitter.startCandidate("one", 1, 0, new Uint8Array()); splitter.bindCandidate("one", "lap-one");
    splitter.finalizeCandidate("one", { lapId: "lap-one", lapNumber: 1, startByteOffset: 0, frameCount: 1 }, 1);
    splitter.enqueue(record(0)); splitter.advanceWatermark(16); await splitter.drain();
    splitter.enqueue(record(16)); splitter.advanceWatermark(32);
    const closing = splitter.close().then(() => undefined, error => error);
    await failed.promise;
    const failure = await closing;
    expect(failure).toBeInstanceOf(Error); expect(errors).toBe(1);
    expect(() => splitter.enqueue(record(32))).toThrow();
    expect(committed).toEqual([]); expect(readdirSync(join(root, ".live-staging"))).toEqual([]);
  } finally { await splitter.close().catch(() => undefined); await fileHost.dispose(); rmSync(root, { recursive: true, force: true }); }
});

for (const cancellation of ["abort", "signal"] as const) {
test(`${cancellation} interrupts unresolved lap binding without publication`, async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-prepared-abort-"));
  const commits: string[] = [];
  const fileHost = new FileStreamingSplitterHost({ archivePath: join(root, "capture.bin.gz"), maxQueuedBytes: 4096, maxUnresolvedBytes: 4096,
    commit: async descriptor => { commits.push(descriptor.lap?.lapId ?? "auxiliary"); } });
  const host: StreamingSplitterHost = { maxQueuedBytes: fileHost.maxQueuedBytes, maxUnresolvedBytes: fileHost.maxUnresolvedBytes,
    createStage: fileHost.createStage.bind(fileHost), createPositionSpool: fileHost.createPositionSpool.bind(fileHost),
    replayEvidence: () => ({ sourceFrameCount: 1, parsedFrameCount: 1, nullFrameCount: 0, orderedTelemetryDigest: "test" }), replayParser: async () => {},
    dispose: fileHost.dispose.bind(fileHost) };
  const controller = new AbortController();
  const splitter = new StreamingCaptureSplitter({ gameId: "fm-2023", host, signal: controller.signal });
  const record: SessionCaptureRecord = { kind: "frame", offset: 0, endOffset: 16, frame: Buffer.from([7]), frameTimeMs: 0 };
  let aborting: Promise<void> | undefined;
  try {
    splitter.startCandidate("one", 1, 0, new Uint8Array()); splitter.finalizeCandidate("one", { lapId: "lap-one", lapNumber: 1, startByteOffset: 0, frameCount: 1 }, 1);
    splitter.enqueue(record); splitter.advanceWatermark(16); await splitter.drain();
    const abortError = new Error("cancel pending ownership");
    const pendingClose = splitter.close().then(() => undefined, error => error);
    await Promise.resolve();
    if (cancellation === "abort") aborting = splitter.abort(abortError);
    else controller.abort(abortError);
    await aborting;
    const closeError = await pendingClose;
    expect(closeError).toBe(abortError);
    await expect(splitter.drain()).rejects.toBe(abortError);
    expect(commits).toEqual([]);
    expect(readdirSync(join(root, ".live-staging"))).toEqual([]);
  } finally { await aborting?.catch(() => undefined); await splitter.close().catch(() => undefined); await fileHost.dispose(); rmSync(root, { recursive: true, force: true }); }
});
}

test("failed trimmed rebuild removes original and rebuilt stage and spool", async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-prepared-rebuild-failure-"));
  let stages = 0; const commits: string[] = [];
  const fileHost = new FileStreamingSplitterHost({ archivePath: join(root, "capture.bin.gz"), maxQueuedBytes: 4096, maxUnresolvedBytes: 4096,
    commit: async descriptor => { commits.push(descriptor.lap?.lapId ?? "auxiliary"); } });
  const host: StreamingSplitterHost = { maxQueuedBytes: fileHost.maxQueuedBytes, maxUnresolvedBytes: fileHost.maxUnresolvedBytes,
    createStage: async (kind, id) => { const stage = await fileHost.createStage(kind, id); const n = ++stages; return new Proxy(stage, { get(target, property) {
      if (property === "append" && n === 2) return async () => { throw new Error("rebuilt output write failed"); };
      return Reflect.get(target, property, target);
    } }); },
    createPositionSpool: fileHost.createPositionSpool.bind(fileHost),
    replayEvidence: () => ({ sourceFrameCount: 1, parsedFrameCount: 1, nullFrameCount: 0, orderedTelemetryDigest: "test" }), replayParser: async () => {},
    dispose: fileHost.dispose.bind(fileHost) };
  const splitter = new StreamingCaptureSplitter({ gameId: "fm-2023", host });
  try {
    splitter.startCandidate("tentative", 1, 0, new Uint8Array()); splitter.bindCandidate("tentative", "lap-tentative");
    splitter.startCandidate("selected", 2, 16, new Uint8Array(), true); splitter.bindCandidate("selected", "lap-selected");
    splitter.finalizeCandidate("selected", { lapId: "lap-selected", lapNumber: 2, startByteOffset: 16, frameCount: 1 }, 1);
    for (const offset of [0, 16]) { splitter.enqueue({ kind: "frame", offset, endOffset: offset + 16, frame: Buffer.from([offset]), frameTimeMs: offset }); splitter.advanceWatermark(offset + 16); await splitter.drain(); }
    await expect(splitter.close()).rejects.toThrow();
    expect(commits).toEqual([]);
    expect(readdirSync(join(root, ".live-staging"))).toEqual([]);
  } finally { await splitter.close().catch(() => undefined); await fileHost.dispose(); rmSync(root, { recursive: true, force: true }); }
});
