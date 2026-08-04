import {
  describe,
  expect,
  test,
} from "bun:test";
import {
  readFileSync,
  writeFileSync,
} from "fs";
import { IRacingIbtReader } from "../../../server/games/iracing/ibt-reader";
import { previewIbtFile } from "../../../server/games/iracing/import-ibt";
import { normalizeIRacingFrame } from "../../../server/games/iracing/normalizer";
import { IRacingTelemetrySource } from "../../../server/games/iracing/source";
import { initServerGameAdapters } from "../../../server/games/init";
import { initGameAdapters } from "../../../shared/games/init";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  type IRacingSourceFrameV3,
} from "../../../server/games/iracing/source-frame";
import {
  IRSDK_VAR_HEADER_SIZE,
} from "../../../server/games/iracing/variable-table";
import {
  DEFAULT_IDENTITY,
  DISK_HEADER_SIZE,
  ROW_LENGTH,
  createRecording,
  syntheticSessionInfo,
  writeCString,
} from "../../support/games/iracing-ibt";

initGameAdapters();
initServerGameAdapters();

describe("IRacingIbtReader", () => {
  test("streams SDK-compatible snapshots and exposes disk metadata", async () => {
    const recording = createRecording();
    try {
      const path = recording.path;
      const reader = new IRacingIbtReader(path);

      expect(reader.readLatest()).toBeNull();
      reader.start();
      reader.start();

      expect(reader.metadata).toMatchObject({
        version: 2,
        status: 1,
        tickRate: 60,
        lapCount: 1,
        recordCount: 2,
        rowLength: ROW_LENGTH,
        trailingBytes: 0,
      });
      expect(reader.metadata?.sessionStartDate.toISOString()).toBe(
        "2025-09-09T04:08:51.000Z",
      );
      expect(reader.metadata?.missingRaceIQVariables).not.toContain(
        "Speed",
      );
      expect(reader.metadata?.missingRaceIQVariables).toContain(
        "LFshockDefl",
      );

      const first = reader.readLatest();
      expect(first).not.toBeNull();
      expect(first?.tick).toBe(600);
      expect(first?.values).toMatchObject({
        SessionTime: 10,
        SessionTick: 600,
        SessionNum: 2,
        IsOnTrack: true,
        OnPitRoad: false,
        Speed: 50.5,
        Lap: 3,
      });
      expect(first?.values.LFbrakeLinePress).toBeCloseTo(1200.25);
      expect(first?.sessionInfo).toBe(syntheticSessionInfo(DEFAULT_IDENTITY));
      expect(first?.sessionInfoUpdate).toBe(0);
      expect(reader.recordsRead).toBe(1);
      expect(reader.done).toBe(false);

      const second = reader.readLatest();
      expect(second?.tick).toBe(601);
      expect(second?.values.Speed).toBeCloseTo(51.5);
      expect(reader.recordsRead).toBe(2);
      expect(reader.done).toBe(true);
      expect(reader.readLatest()).toBeNull();

      await reader.stop();
      await reader.stop();
      expect(reader.readLatest()).toBeNull();
    } finally {
      recording.cleanup();
    }
  });

  test("reuses the existing source-frame and normalizer path", async () => {
    const recording = createRecording();
    try {
      const reader = new IRacingIbtReader(recording.path);
      const delivered: Buffer[] = [];
      reader.start();
      const source = new IRacingTelemetrySource({
        reader,
        dispatchRawFrame: async (raw) => {
          delivered.push(raw);
        },
      });

      expect(await source.pollOnce()).toBe(true);
      expect(await source.pollOnce()).toBe(true);
      expect(await source.pollOnce()).toBe(false);
      expect(delivered).toHaveLength(2);
      expect(delivered[1].length).toBeLessThan(delivered[0].length / 10);

      const decoder = createIRacingSourceDecoderState();
      const frame = decodeIRacingSourceFrame(delivered[0], decoder);
      expect(frame?.session).toMatchObject({
        sessionId: 123,
        subSessionId: 456,
        sessionNum: 2,
        trackId: 99,
        trackName: "Road America",
        sectorStarts: [0, 0.34, 0.67],
        carId: 42,
        carName: "GT3 Test Car",
      });
      expect(frame).not.toBeNull();
      expect(frame).toMatchObject({
        schemaVersion: 3,
        sessionInfo: syntheticSessionInfo(DEFAULT_IDENTITY),
        sessionInfoUpdate: 0,
      });
      expect((frame as IRacingSourceFrameV3 | null)?.sessionInfo).toBe(
        syntheticSessionInfo(DEFAULT_IDENTITY),
      );
      expect(frame?.values.LFbrakeLinePress).toBeCloseTo(1200.25);
      const packet = normalizeIRacingFrame(frame!);
      expect(packet.gameId).toBe("iracing");
      expect(packet.sessionUID).toBe("456:123:2");
      expect(packet.Speed).toBeCloseTo(50.5);
      expect(packet.LapNumber).toBe(3);
      expect(packet.iracing?.lapDistancePct).toBeCloseTo(0.25);
      expect(packet).not.toHaveProperty("sessionInfo");
      expect(packet).not.toHaveProperty("sessionInfoUpdate");
      expect(packet.iracing).not.toHaveProperty("sessionInfo");
      expect(packet.iracing).not.toHaveProperty("sessionInfoUpdate");

      const secondFrame = decodeIRacingSourceFrame(delivered[1], decoder);
      expect(secondFrame?.values.Speed).toBeCloseTo(51.5);
      expect(secondFrame?.values.LFbrakeLinePress).toBeCloseTo(1201.5);
      expect(
        (secondFrame as IRacingSourceFrameV3 | null)?.sessionInfo,
      ).toBe(syntheticSessionInfo(DEFAULT_IDENTITY));
      expect(
        (secondFrame as IRacingSourceFrameV3 | null)?.sessionInfoUpdate,
      ).toBe(0);

      await source.stop();
    } finally {
      recording.cleanup();
    }
  });

  test("reports missing required inputs while retaining other native channels", async () => {
    const recording = createRecording();
    try {
      const path = recording.path;
      const bytes = readFileSync(path);
      const speedNameOffset =
        DISK_HEADER_SIZE + 5 * IRSDK_VAR_HEADER_SIZE + 16;
      bytes.fill(0, speedNameOffset, speedNameOffset + 32);
      writeCString(bytes, speedNameOffset, 32, "UnavailableSpeedDetail");
      writeFileSync(path, bytes);

      const preview = await previewIbtFile(path);
      expect(preview.missingRequiredVariables).toContain("Speed");
      expect(preview.reason).toContain(
        "missing channels required for RaceIQ lap import: Speed",
      );
    } finally {
      recording.cleanup();
    }
  });

  test("rejects a recording whose declared rows are truncated", () => {
    const recording = createRecording();
    try {
      const path = recording.path;
      const bytes = readFileSync(path);
      writeFileSync(path, bytes.subarray(0, bytes.length - 1));

      const reader = new IRacingIbtReader(path);
      expect(() => reader.start()).toThrow(
        "Truncated iRacing IBT",
      );
      expect(reader.metadata).toBeNull();
      expect(reader.readLatest()).toBeNull();
    } finally {
      recording.cleanup();
    }
  });
});
