import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DirectCaptureRecording } from "@raceiq/backend-core/session-capture/direct-recorder";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { partitionLMUSourceFrame } from "@raceiq/capture-formats/lmu/partition";
import { LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_INFO_OFFSET } from "@raceiq/capture-formats/lmu/layout";
import type { GameId } from "@raceiq/shared/games/ids";
import { FIXTURES, fixtureFrames, fixturePath } from "./live-lossless-release.bench";

const fixtures = [...FIXTURES, { gameId: "ams2", fixture: "ams2-legacy-owned-offset.bin.gz" } as const];
type Frame = { bytes: Buffer; timestampMs?: number };
export type Samples = Record<string, number[]>;
export interface Result { workload: string; controls: Record<string, string | number | boolean>; samples: Samples }
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function nativeFrames() {
  return Array.from({ length: 12 }, (_, i) => {
    const bytes = Buffer.alloc(28 + LMU_SHARED_MEMORY_SIZE);
    bytes.write("RQLMUSF\0"); bytes.writeUInt16LE(2, 8);
    bytes.fill(i + 1, 28 + LMU_TELEMETRY_INFO_OFFSET);
    return bytes;
  });
}

async function capture(gameId: GameId, frames: Frame[], fps: number, root: string) {
  const directory = join(root, crypto.randomUUID());
  const recorder = new DirectCaptureRecording(gameId, directory, join(directory, "capture-manifest.json"), { recordLmuOpponents: true, deferOpponentIndexEnqueue: true });
  const lateness: number[] = [], queue: number[] = [];
  let missed = 0, writeNs = 0;
  try {
    await recorder.ready;
    const start = Bun.nanoseconds();
    for (const [i, frame] of frames.entries()) {
      const target = start + (fps ? i * 1e9 / fps : 0);
      if (fps) {
        let left: number;
        while ((left = target - Bun.nanoseconds()) > 0) await Bun.sleep(Math.ceil(left / 1e6));
      }
      const before = Bun.nanoseconds();
      recorder.writeRecord(frame.bytes, frame.timestampMs);
      const end = Bun.nanoseconds();
      writeNs += end - before;
      if (fps) {
        lateness.push((before - target) / 1e6);
        if (end > target + 1e9 / fps) missed++;
        queue.push(recorder.queuedBytes);
      }
    }
    const stop = Bun.nanoseconds();
    await recorder.stop();
    const end = Bun.nanoseconds();
    const manifest = JSON.parse(await readFile(recorder.path, "utf8"));
    assert.equal(manifest.sourceRecordCount, frames.length);
    if (gameId === "lmu") {
      const c = manifest.opponentCompanion;
      assert.equal(c.committedPrefix.recordCount, frames.length);
      assert.equal(c.sha256, sha256(await readFile(join(directory, c.file))));
    } else assert.ok(!manifest.opponentCompanion);
    let count = 0;
    for await (const record of iterateSessionCaptureRecordsFromSource({ rawFile: recorder.path, source: null, gameId, carId: "", trackId: "" }, { strict: true })) {
      if (record.kind !== "frame") continue;
      const expected = frames[count++];
      assert.ok(expected && expected.bytes.equals(record.frame), `${gameId} replay mismatch at ${count - 1}`);
      assert.equal(record.frameTimeMs, expected.timestampMs);
    }
    assert.equal(count, frames.length);
    const samples: Samples = { writeUs: [writeNs / frames.length / 1000], stopMs: [(end - stop) / 1e6], totalMs: [(end - start) / 1e6], submitted: [frames.length], committed: [count] };
    if (fps) Object.assign(samples, { startDelayMs: lateness, missed: [missed], peakQueueBytes: [Math.max(...queue)], firstQuarterBytes: [mean(queue.slice(0, queue.length / 4))], lastQuarterBytes: [mean(queue.slice(-queue.length / 4))] });
    return samples;
  } finally {
    await recorder.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function trials(warmups: number, measured: number, run: () => Promise<Samples>) {
  const samples: Samples = {};
  for (let i = -warmups; i < measured; i++) {
    const result = await run();
    if (i >= 0) for (const [key, values] of Object.entries(result)) (samples[key] ??= []).push(...values);
  }
  return samples;
}

export async function workloads(mode: string, root: string): Promise<Result[]> {
  if (mode === "burst") {
    const results: Result[] = [];
    for (const { gameId, fixture } of fixtures) {
      const data = await readFile(fixturePath(fixture));
      const frames = fixtureFrames(data, gameId, 32);
      assert.equal(frames.length, 32);
      results.push({ workload: `burst/${gameId}`, controls: { fixture, sha256: sha256(data), startFrame: 0, frames: 32, fps: 0, retained: gameId === "lmu", warmups: 2, trials: 10 }, samples: await trials(2, 10, () => capture(gameId, frames, 0, root)) });
    }
    return results;
  }
  if (mode === "paced") {
    const native = nativeFrames();
    const frames = Array.from({ length: 500 }, (_, i) => ({ bytes: native[i % native.length]!, timestampMs: 100 + 4 * i }));
    return [{ workload: "paced/lmu", controls: { sha256: sha256(Buffer.concat(native)), startFrame: 0, frames: 500, fps: 250, retained: true, warmups: 1, trials: 1 }, samples: await trials(1, 1, () => capture("lmu", frames, 250, root)) }];
  }
  const memory = mode.endsWith("-rss");
  const partition = mode.startsWith("partition-");
  assert.ok(["partition-time", "partition-rss", "publication-time", "publication-rss"].includes(mode));
  const frame = nativeFrames()[0]!;
  const reference = partitionLMUSourceFrame(frame)!.primary;
  const subject = Object.create(DirectCaptureRecording.prototype) as DirectCaptureRecording;
  const chunks = Array.from({ length: 128 }, (_, i) => ({ kind: "lap", lapId: String(i + 1), ownedFrameCount: 1, path: String(i + 1) }));
  const snapshot = { chunks };
  Object.assign(subject, { sessionId: 1, persistedManifest: snapshot, publishedLapIds: new Set(chunks.map(c => Number(c.lapId))), parts: new Map(chunks.map(c => [c.path, { info: { path: `/bench/${c.path}` }, owner: { binding: { lapId: Number(c.lapId) } } }])), notify: () => assert.fail("Duplicate lap notification") });
  const ops = memory ? 512 : partition ? 64 : 50;
  const samples = await trials(memory ? 1 : 2, memory ? 1 : 9, async () => {
    if (memory) Bun.gc(true);
    const initial = memory ? process.memoryUsage.rss() : 0;
    let peak = initial, primary: Buffer | undefined;
    const start = Bun.nanoseconds();
    for (let i = 0; i < ops; i++) {
      if (partition) primary = partitionLMUSourceFrame(frame, false)!.primary;
      else await Reflect.apply(subject["publishReady"], subject, [snapshot]);
      if (memory && i % 8 === 7) peak = Math.max(peak, process.memoryUsage.rss());
    }
    const us = (Bun.nanoseconds() - start) / ops / 1000;
    if (partition) assert.ok(primary?.equals(reference));
    const result: Samples = memory ? { rssGrowthBytes: [peak - initial] } : { usPerOp: [us] };
    return result;
  });
  return [{ workload: mode, controls: { ops, warmups: memory ? 1 : 2, trials: memory ? 1 : 9, input: partition ? sha256(frame) : "128-published-laps-v1", expected: partition ? sha256(reference) : "no-notifications" }, samples }];
}
