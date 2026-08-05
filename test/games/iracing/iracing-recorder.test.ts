import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  IRACING_DUMP_MAGIC,
  IRACING_DUMP_VERSION,
  IRacingRecorder,
  readIRacingFrames,
} from "../../../server/games/iracing/recorder";
import {
  IRACING_MAX_SOURCE_FRAME_SIZE,
  IRacingSourceFrameEncoder,
  type IRacingSourceFrameV3,
} from "../../../server/games/iracing/source-frame";
import {
  DumpToBinProcessor,
  IRacingFramePipeline,
  ParsingProcessor,
} from "../../../server/games/iracing/frame-pipeline";
import { initServerGameAdapters } from "../../../server/games/init";
import { getServerGame } from "../../../server/games/registry";
import { initGameAdapters } from "../../../shared/games/init";

const FIXTURE =
  "test/artifacts/sessions/iracing-road-america-gt3.bin.gz";

initGameAdapters();
initServerGameAdapters();

function recorderFrame(sessionInfo: string): IRacingSourceFrameV3 {
  return {
    schemaVersion: 3,
    session: {
      sessionId: 123,
      subSessionId: 456,
      sessionNum: 2,
      driverCarIdx: 7,
      trackId: 99,
      trackName: "Road America",
      trackLengthM: 6515,
      sectorStarts: [0, 0.34, 0.67],
      carId: 42,
      carName: "GT3 Test Car",
      carClassId: 8,
      carClassName: "GT3",
      engineIdleRpm: 900,
      engineRedlineRpm: 8500,
      engineCylinderCount: 8,
    },
    values: {
      SessionTime: 125.5,
      SessionTick: 7530,
      Speed: 72.5,
    },
    sessionInfo,
    sessionInfoUpdate: 7,
  };
}

describe("iRacing recorder container", () => {
  let tempDir = "";

  afterEach(() => {
    if (!tempDir) return;
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  test("uses its own magic, version, and persisted frame count", () => {
    const raw = Buffer.from(gunzipSync(readFileSync(FIXTURE)));

    expect(raw.subarray(0, 8)).toEqual(IRACING_DUMP_MAGIC);
    expect(raw.subarray(0, 8).toString("ascii")).not.toBe("ACCTEST\0");
    expect(raw.readUInt32LE(8)).toBe(IRACING_DUMP_VERSION);
    expect(raw.readUInt32LE(12)).toBe(138);
    expect(readIRacingFrames(FIXTURE)).toHaveLength(138);
  });

  test("contains a self-contained session frame followed by value deltas", () => {
    const frames = readIRacingFrames(FIXTURE);
    expect(frames[0].length).toBeGreaterThan(frames[1].length);

    const adapter = getServerGame("iracing");
    const state = adapter.createParserState?.() ?? null;
    const packets = frames
      .map((frame) => adapter.tryParse(frame, state))
      .filter((packet) => packet !== null);

    expect(packets).toHaveLength(138);
    expect(packets[0]).toMatchObject({
      gameId: "iracing",
      CarOrdinal: 42,
      TrackOrdinal: 99,
    });
    expect(packets[0]?.iracing).toMatchObject({
      carName: "GT3 Test Car",
      trackName: "Road America",
      sectorStarts: [0, 0.34, 0.67],
    });
    expect(packets.at(-1)?.LapNumber).toBe(3);
  });

  test("recovers all complete frames from an interrupted zero-count header", () => {
    tempDir = mkdtempSync(join(tmpdir(), "iracing-recorder-test-"));
    const raw = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
    raw.writeUInt32LE(0, 12);
    const interrupted = join(tempDir, "interrupted.bin");
    writeFileSync(interrupted, raw);

    expect(readIRacingFrames(interrupted)).toHaveLength(138);
  });

  test("stops cleanly at a truncated frame", () => {
    tempDir = mkdtempSync(join(tmpdir(), "iracing-recorder-test-"));
    const raw = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
    const truncated = join(tempDir, "truncated.bin");
    writeFileSync(truncated, raw.subarray(0, raw.length - 3));

    expect(readIRacingFrames(truncated)).toHaveLength(137);
  });

  test("records v3 session frames larger than the historical guard", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "iracing-recorder-test-"));
    const recorder = new IRacingRecorder();
    const path = recorder.start(tempDir);
    const sessionInfo =
      `WeekendInfo:\n  Notes: ${"x".repeat(600 * 1024)}\n`;
    const frame = new IRacingSourceFrameEncoder().encode(
      recorderFrame(sessionInfo),
    );

    expect(frame.length).toBeGreaterThan(512 * 1024);
    expect(frame.length).toBeLessThanOrEqual(IRACING_MAX_SOURCE_FRAME_SIZE);
    recorder.writeFrame(frame);
    await recorder.stop();

    const recorded = readIRacingFrames(path);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual(frame);
  });

  test("rejects frames beyond the shared source-frame size limit", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "iracing-recorder-test-"));
    const recorder = new IRacingRecorder();
    const path = recorder.start(tempDir);

    expect(() =>
      recorder.writeFrame(Buffer.allocUnsafe(IRACING_MAX_SOURCE_FRAME_SIZE + 1)),
    ).toThrow(/iRacing dump frame is too large/);
    await recorder.stop();

    expect(readIRacingFrames(path)).toEqual([]);
    const invalidContainer = Buffer.alloc(21);
    IRACING_DUMP_MAGIC.copy(invalidContainer, 0);
    invalidContainer.writeUInt32LE(IRACING_DUMP_VERSION, 8);
    invalidContainer.writeUInt32LE(1, 12);
    invalidContainer.writeUInt8(0, 16);
    invalidContainer.writeUInt32LE(IRACING_MAX_SOURCE_FRAME_SIZE + 1, 17);
    writeFileSync(path, invalidContainer);
    expect(readIRacingFrames(path)).toEqual([]);
  });

  test("records through DumpToBinProcessor before parser dispatch", async () => {
    const calls: string[] = [];
    const frame = Buffer.from("canonical iRacing frame");
    const pipeline = new IRacingFramePipeline();
    pipeline.register(
      new DumpToBinProcessor({
        writeFrame(value) {
          expect(value).toBe(frame);
          calls.push("dump");
        },
      }),
      new ParsingProcessor(async (value) => {
        expect(value).toBe(frame);
        calls.push("parse");
      }),
    );

    await pipeline.process(frame);

    expect(calls).toEqual(["dump", "parse"]);
  });
});
