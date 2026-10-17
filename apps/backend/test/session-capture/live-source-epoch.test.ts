import { afterAll, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { decompressIfGzipSync, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { CapturingDbAdapter, NullWsAdapter, SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { createLiveGameParserCodec } from "../../src/session-capture/live-game-codecs";
import { initServerGameAdapters } from "../../src/games/init";

const paths: string[] = [];
afterAll(async () => { await Promise.all(paths.map((path) => rm(path, { force: true }))); });

class DelayedSecondSession extends CapturingDbAdapter {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  private calls = 0;
  override async insertSession(...args: Parameters<CapturingDbAdapter["insertSession"]>): Promise<number> {
    if (++this.calls === 2) { this.entered.resolve(); await this.release.promise; }
    return super.insertSession(...args);
  }
}
class TrackedRecorder extends SparseSessionRecorderAdapter {
  constructor() { super("others", {}, "offline"); }
  override start(...args: Parameters<SparseSessionRecorderAdapter["start"]>): void {
    super.start(...args);
    if (this.path) paths.push(this.path);
  }
}

test("queued native input is rebound to the new source epoch instead of retaining the old ordinal", async () => {
  initServerGameAdapters();
  const fixture = decompressIfGzipSync(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/fm-2023-with-pitting.bin.gz")));
  const first = iterateSessionCaptureRecords(fixture).find((record) => record.kind === "frame");
  if (!first || first.kind !== "frame") throw new Error("Forza fixture has no native frame");
  const codec = createLiveGameParserCodec("fm-2023");
  const db = new DelayedSecondSession();
  const recorder = new TrackedRecorder();
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, enqueueSessionCaptureSplits: false,
  });
  const input = (sequence: number, carId: number) => {
    const frame = Buffer.from(first.frame);
    frame.writeInt32LE(1, 0);
    frame.writeUInt32LE(1_000 + sequence * 1_000, 4);
    frame.writeInt32LE(carId, 212);
    frame.writeFloatLE(0, 288);
    frame.writeFloatLE(20 + sequence, 292);
    const packet = codec.parseFrame(frame, null);
    if (!packet) throw new Error("Forza native frame was not parsed");
    pipeline.captureParserSource({ gameId: "fm-2023", sequence, frame, locator: null });
    return { frame, packet };
  };
  try {
    for (let sequence = 0; sequence < 4; sequence++) {
      const value = input(sequence, 3631);
      await pipeline.processPacket(value.packet, value.frame);
    }
    const previousEpoch = recorder.epoch;
    const a = input(4, 9999);
    const processingA = pipeline.processPacket(a.packet, a.frame);
    await db.entered.promise;
    expect(recorder.epoch).toBe(previousEpoch);
    expect(recorder.active).toBe(true);
    const b = input(5, 9999);
    const processingB = pipeline.processPacket(b.packet, b.frame);
    db.release.resolve();
    await Promise.all([processingA, processingB]);
    const newSource = recorder.path;
    if (!newSource) throw new Error("New source epoch did not start");
    await pipeline.finalizeCurrentSession();
    const recorded = [...iterateSessionCaptureRecords(await readFile(newSource))].filter((record) => record.kind === "frame");
    expect(recorded.map((record) => record.frame)).toEqual([a.frame, b.frame]);
    expect(db.laps.filter((lap) => lap.sessionId === 2).map((lap) => lap.rawFrameCount)).toEqual([2]);
    expect(db.laps.filter((lap) => lap.sessionId === 2).map((lap) => lap.rawByteOffset)).toEqual([recorded[0]!.offset]);
  } finally {
    db.release.resolve();
    await pipeline.finalizeCurrentSession();
  }
});
