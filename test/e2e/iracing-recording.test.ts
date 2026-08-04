import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import { initServerGameAdapters } from "../../server/games/init";
import {
  IRACING_DUMP_MAGIC,
  IRACING_DUMP_VERSION,
  IRacingRecorder,
  readIRacingFrames,
} from "../../server/games/iracing/recorder";
import type { IRacingSdkSnapshot } from "../../server/games/iracing/sdk-reader";
import {
  type IRacingFrameReader,
  IRacingTelemetrySource,
} from "../../server/games/iracing/source";
import { initGameAdapters } from "../../shared/games/init";
import { parseDump } from "../support/recordings/parse-dump";

initGameAdapters();
initServerGameAdapters();

function snapshot(tick: number): IRacingSdkSnapshot {
  return {
    tick,
    sessionInfoUpdate: 1,
    sessionInfo: `
WeekendInfo:
  TrackID: 99
  TrackLength: 6.515 km
  TrackDisplayName: Road America
  SessionID: 123
  SubSessionID: 456
SplitTimeInfo:
  Sectors:
  - SectorNum: 0
    SectorStartPct: 0.000000
  - SectorNum: 1
    SectorStartPct: 0.340000
  - SectorNum: 2
    SectorStartPct: 0.670000
DriverInfo:
  DriverCarIdx: 7
  DriverCarIdleRPM: 900
  DriverCarRedLine: 8500
  DriverCarEngCylinderCount: 8
  Drivers:
  - CarIdx: 7
    CarID: 42
    CarScreenName: GT3 Test Car
    CarClassID: 8
    CarClassShortName: GT3
`,
    values: {
      SessionTick: tick,
      SessionNum: 2,
      SessionTime: tick / 60,
      IsOnTrack: true,
      Lap: 3,
      LapDist: 1200 + tick,
      LapDistPct: 0.184,
      LapCurrentLapTime: 25.5,
      LapLastLapTime: 122.4,
      Speed: 72.5,
      RPM: 7000,
    },
  };
}

describe("iRacing dump-mode recording", () => {
  test("records an iRacing-specific container and replays it through the production parser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iracing-recording-"));
    const snapshots = [snapshot(7530), snapshot(7531)];
    const reader: IRacingFrameReader = {
      start() {},
      async stop() {},
      readLatest() {
        return snapshots.shift() ?? null;
      },
    };
    const recorder = new IRacingRecorder();
    const source = new IRacingTelemetrySource({
      reader,
      recorder,
      recordingEnabled: true,
      recordingDir: dir,
      pollIntervalMs: 60_000,
      async dispatchRawFrame() {},
    });

    try {
      source.start();
      expect(await source.pollOnce()).toBe(true);
      expect(await source.pollOnce()).toBe(true);
      await Promise.all([source.stop(), recorder.stop()]);

      const path = recorder.path;
      expect(path).not.toBeNull();
      const bytes = readFileSync(path!);
      expect(bytes.subarray(0, 8)).toEqual(IRACING_DUMP_MAGIC);
      expect(bytes.subarray(0, 8).toString("ascii")).not.toBe("ACCTEST\0");
      expect(bytes.readUInt32LE(8)).toBe(IRACING_DUMP_VERSION);
      expect(bytes.readUInt32LE(12)).toBe(2);

      const frames = readIRacingFrames(path!);
      expect(frames).toHaveLength(2);
      const gzipPath = `${path}.gz`;
      writeFileSync(gzipPath, gzipSync(bytes));
      expect(readIRacingFrames(gzipPath)).toEqual(frames);

      const replay = await parseDump("iracing", path!);
      expect(replay.rawPackets).toHaveLength(2);
      expect(replay.rawPackets[0]).toMatchObject({
        gameId: "iracing",
        CarOrdinal: 42,
        TrackOrdinal: 99,
      });
      expect(replay.rawPackets[0]?.iracing).toMatchObject({
        carName: "GT3 Test Car",
        trackName: "Road America",
        sectorStarts: [0, 0.34, 0.67],
      });
      expect(replay.carModel).toBe("GT3 Test Car");
      expect(replay.trackName).toBe("Road America");
    } finally {
      await source.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
