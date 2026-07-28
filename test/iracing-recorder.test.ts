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
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import {
  IRACING_DUMP_MAGIC,
  IRACING_DUMP_VERSION,
  readIRacingFrames,
} from "../server/games/iracing/recorder";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { initGameAdapters } from "../shared/games/init";

const FIXTURE =
  "test/artifacts/sessions/iracing-road-america-gt3.bin.gz";

initGameAdapters();
initServerGameAdapters();

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
});
