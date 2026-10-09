import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { iterateSessionCaptureRecords, iterateSessionFrames, sessionFrameAt } from "@raceiq/capture-formats/session/framing";
import { decodeGenericSparseFrame, encodeGenericSparseFrame, isGenericSparseFrame } from "@raceiq/capture-formats/session/generic-sparse";
import { SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { SessionRecorder } from "@raceiq/capture-formats/session/recorder";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { runInsightScanWithCoverage } from "@raceiq/analysis-core/racing/analysis/laps/insights/scan";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { iterateSessionCaptureFrames } from "@raceiq/backend-core/session-capture/source-loader";
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { ACC_PACKED_MAGIC, packTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import type { GameId } from "@raceiq/shared/games/ids";

const dirs: string[] = [];
initGameAdapters();
initServerGameAdapters();

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixtureFrames(name: string, gameId: GameId): Buffer[] {
  const path = join(ROOT_DIR, "test/artifacts/sessions", name);
  if (gameId === "acc") {
    return readKunosFrames(path).slice(0, 260).map(({ physics, graphics, staticData }) =>
      packTriplet(ACC_PACKED_MAGIC, 1, 1, physics, graphics, staticData));
  }
  if (gameId === "iracing") return readIRacingFrames(path, 260);
  const bytes = gunzipSync(readFileSync(path));
  if (gameId === "lmu") return readLMUFramesFromBuffer(bytes).slice(0, 260);
  const frames: Buffer[] = [];
  const limit = gameId === "f1-2025" ? 520 : 260;
  for (const frame of iterateSessionFrames(bytes)) {
    frames.push(frame);
    if (frames.length === limit) break;
  }
  expect(frames.length).toBeGreaterThan(128);
  return frames;
}

describe("generic sparse session recorder", () => {
  test.each([
    ["fm-2023", "fm-2023-2026-04-09T21-55-03-186Z.bin.gz"],
    ["f1-2025", "f1-2025-2026-04-09T21-34-10-190Z.bin.gz"],
    ["acc", "acc-2026-04-10T02-55-22-777Z.bin.gz"],
    ["ac-evo", "session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz"],
    ["iracing", "iracing-daytona-am-vantage-gt3-pit.bin.gz"],
    ["lmu", "lmu-spa-iron-lynx-gte.bin.gz"],
  ] as const)("restores fixture source bytes and seeks for %s", async (gameId, fixture) => {
    const dir = mkdtempSync(join(tmpdir(), "raceiq-generic-sparse-")); dirs.push(dir);
    const previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    const recorder = new SparseSessionRecorderAdapter();
    recorder.start(gameId); recorder.writeMetaFrame();
    const frames = fixtureFrames(fixture, gameId);
    const offsets: number[] = [];
    for (const frame of frames) { offsets.push(recorder.getCurrentByteOffset()); recorder.writeRecord(frame); }
    const file = recorder.path!;
    await recorder.stop();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    const rawFile = join(dir, "full.bin");
    const rawRecorder = new SessionRecorder();
    rawRecorder.start(rawFile); rawRecorder.writeMetaFrame();
    for (const frame of frames) rawRecorder.writeRecord(frame);
    await rawRecorder.stop();
    const captureSource = (rawFile: string) => ({ rawFile, source: null, gameId, carOrdinal: -1, trackOrdinal: -1 });
    const rawStreamedPackets = await parseRawLapFrames(captureSource(rawFile), 12, frames.length);
    const sparseStreamedPackets = await parseRawLapFrames(captureSource(file), 12, frames.length);
    expect(rawStreamedPackets.length).toBeGreaterThan(0);
    if (gameId === "acc" || gameId === "ac-evo") {
      const withoutReplayClock = (packets: typeof rawStreamedPackets) =>
        packets.map(({ TimestampMS: _timestamp, ...packet }) => packet);
      expect(withoutReplayClock(sparseStreamedPackets)).toEqual(withoutReplayClock(rawStreamedPackets));
    } else {
      expect(sparseStreamedPackets).toEqual(rawStreamedPackets);
    }
    const bytes = readFileSync(file);
    const records = [...iterateSessionCaptureRecords(bytes)];
    expect(records.map((record) => record.kind === "frame" ? record.offset : -1)).toEqual(offsets);
    expect(records.map((record) => record.kind === "frame" ? record.frame : null)).toEqual(frames);
    for (const index of [0, 1, 126, 127, 128, 129, 259]) {
      if (index < frames.length) expect(sessionFrameAt(bytes, offsets[index]!)).toEqual(frames[index]);
    }
    const streamed: Buffer[] = [];
    for await (const record of iterateSessionCaptureFrames({ rawFile: file, source: null, gameId, carOrdinal: -1, trackOrdinal: -1 })) streamed.push(record.frame);
    expect(streamed).toEqual(frames);
    const gzFile = join(dir, "capture.bin.gz");
    writeFileSync(gzFile, gzipSync(bytes));
    const gzFrames: Buffer[] = [];
    for await (const record of iterateSessionCaptureFrames({ rawFile: gzFile, source: null, gameId, carOrdinal: -1, trackOrdinal: -1 })) gzFrames.push(record.frame);
    expect(gzFrames).toEqual(frames);
    if (gameId === "fm-2023" || gameId === "f1-2025") {
      const deltas = records.filter((record) => record.kind === "frame" && isGenericSparseFrame(bytes.subarray(record.offset + 4, record.offset + 4 + bytes.readUInt32LE(record.offset))));
      expect(deltas.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThan(frames.reduce((sum, frame) => sum + frame.length + 4, 0) + 12);
    }
  });
  test.each([
    ["fm-2023", "fm-2023-2026-04-09T21-55-03-186Z.bin.gz"],
    ["f1-2025", "f1-2025-2026-04-09T21-34-10-190Z.bin.gz"],
    ["acc", "acc-2026-04-10T02-55-22-777Z.bin.gz"],
    ["ac-evo", "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz"],
    ["iracing", "iracing-road-america-gt3.bin.gz"],
    ["lmu", "lmu-spa-iron-lynx-gte.bin.gz"],
  ] as const)("preserves acquisition UTC, gaps and source bytes for %s", async (gameId, fixture) => {
    const dir = mkdtempSync(join(tmpdir(), "raceiq-captured-utc-")); dirs.push(dir);
    const frames = fixtureFrames(fixture, gameId);
    const timestamps = frames.map((_, i) => 1_745_000_000_000 + i * 10 + (i >= 2 ? 5_000 : 0));
    const rawFile = join(dir, "raw.bin");
    const sparseFile = join(dir, "sparse.bin");
    const raw = new SessionRecorder();
    const sparse = new SparseSessionRecorder(gameId);
    raw.start(rawFile); sparse.start(sparseFile);
    raw.writeMetaFrame(); sparse.writeMetaFrame();
    const offsets: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      offsets.push(sparse.getCurrentByteOffset());
      raw.writeRecord(frames[i]!, timestamps[i]);
      sparse.writeRecord(frames[i]!, timestamps[i]);
    }
    await raw.stop(); await sparse.stop();
    const bytes = readFileSync(sparseFile);
    const records = [...iterateSessionCaptureRecords(bytes)].filter((record) => record.kind === "frame");
    expect(records.map((record) => record.frameTimeMs)).toEqual(timestamps);
    expect(records.map((record) => record.frame)).toEqual(frames);
    expect(records.map((record) => record.offset)).toEqual(offsets);
    expect(timestamps[2]! - timestamps[1]!).toBe(5_010);
    for (const index of [0, 1, 127, 128, frames.length - 1]) {
      if (index < frames.length) expect(sessionFrameAt(bytes, offsets[index]!)).toEqual(frames[index]);
    }
    const source = (rawFile: string) => ({ rawFile, source: null, gameId, carOrdinal: -1, trackOrdinal: -1 });
    const rawPackets = await parseRawLapFrames(source(rawFile), 12, frames.length);
    const sparsePackets = await parseRawLapFrames(source(sparseFile), 12, frames.length);
    expect(sparsePackets.length).toBeGreaterThan(0);
    expect(sparsePackets).toEqual(rawPackets);
    expect(sparsePackets[0]?.extendedRaceIQ?.frameTimeMs).toBeDefined();
    if (gameId === "acc" || gameId === "ac-evo") {
      expect(sparsePackets[0]!.TimestampMS).toBe(sparsePackets[0]!.extendedRaceIQ!.frameTimeMs!);
    }
    if (gameId === "acc") {
      const coverage = runInsightScanWithCoverage(sparsePackets, "acc").detectorCoverage;
      expect(coverage.some((detector) => detector.status === "checked" || detector.status === "finding")).toBe(true);
      expect(runInsightScanWithCoverage(sparsePackets.map((packet) => ({ ...packet, CurrentLap: 0 })), "acc").detectorCoverage
        .every((detector) => detector.reason === "Insufficient valid-duration lap telemetry")).toBe(true);
      expect(sparsePackets[0]!.TimestampMS).toBe(timestamps[0]);
    }
    const gzFile = join(dir, "sparse.bin.gz");
    writeFileSync(gzFile, gzipSync(bytes));
    const gzPackets = await parseRawLapFrames(source(gzFile), 12, frames.length);
    expect(gzPackets).toEqual(sparsePackets);
  });


  test("rejects invalid bitmap and back-distance, and tolerates a truncated final record", () => {
    const previous = Buffer.alloc(324); previous.writeUInt16LE(2025, 0);
    const next = Buffer.from(previous); next[200] = 1;
    const payload = encodeGenericSparseFrame(next, previous, 20);
    expect(decodeGenericSparseFrame(payload, previous)).toEqual(next);
    const badBitmap = Buffer.from(payload); badBitmap[14] |= 0x80;
    expect(() => decodeGenericSparseFrame(badBitmap, previous)).toThrow();
    const badDistance = Buffer.from(payload); badDistance.writeUInt32LE(0, 5);
    const capture = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 4, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0x44,1,0,0]), previous, Buffer.from([payload.length,0,0,0]), badDistance]);
    expect(() => [...iterateSessionCaptureRecords(capture)]).toThrow(/checkpoint distance/);
    const truncated = Buffer.concat([capture.subarray(0, capture.length - 2)]);
    expect([...iterateSessionCaptureRecords(truncated)].length).toBe(1);
  });
});
