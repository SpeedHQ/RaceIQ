import { registerGame } from "@raceiq/shared/games/registry";
import { iracingServerAdapter } from "../src/index";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import {
  describe,
  expect,
  test,
} from "bun:test";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { IRacingIbtReader } from "../src/ibt-reader";
import { previewIbtFile } from "../src/ibt-preview";
import { normalizeIRacingFrame } from "../src/normalizer";
import { IRacingTelemetrySource } from "../src/source";
import {
  IRacingSourceFrameEncoder,
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  type IRacingSourceFrameV3,
} from "@raceiq/capture-formats/iracing/source-frame";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import { RaceEngineerTriggerCatalog } from "@raceiq/backend-core/live-strategy/race-engineer-triggers/catalog";
import { LiveEngineerVoiceEngine } from "@raceiq/backend-core/live-strategy/live-engineer-voice-engine";
import {
  IRSDK_VAR_HEADER_SIZE,
} from "@raceiq/capture-formats/iracing/variable-table";
import {
  DEFAULT_IDENTITY,
  DISK_HEADER_SIZE,
  ROW_LENGTH,
  createRecording,
  syntheticSessionInfo,
  writeCString,
} from "./support/games/iracing-ibt";

registerGame(iracingServerAdapter);
registerServerGame(iracingServerAdapter);

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
      expect(frame?.values.EngineWarnings).toBe(0xf0000001);
      expect(frame?.values.PitRepairLeft).toBeCloseTo(12.375);
      expect(frame?.values.PitOptRepairLeft).toBeCloseTo(3.625);
      expect(frame?.values.LFbrakeLinePress).toBeCloseTo(1200.25);
      const packet = normalizeIRacingFrame(frame!);
      expect(packet.iracing?.engineWarnings).toBe(0xf0000001);
      expect(packet.iracing?.pitRepairLeft).toBeCloseTo(12.375);
      expect(packet.iracing?.pitOptRepairLeft).toBeCloseTo(3.625);
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
      expect(secondFrame?.values.EngineWarnings).toBe(0xf0000001);
      expect(secondFrame?.values.PitRepairLeft).toBeCloseTo(12.375);
      expect(secondFrame?.values.Speed).toBeCloseTo(51.5);
      expect(secondFrame?.values.LFbrakeLinePress).toBeCloseTo(1201.5);
      expect(
        (secondFrame as IRacingSourceFrameV3 | null)?.sessionInfo,
      ).toBe(syntheticSessionInfo(DEFAULT_IDENTITY));
      expect(
        (secondFrame as IRacingSourceFrameV3 | null)?.sessionInfoUpdate,
      ).toBe(0);
      const oldValues = { ...frame!.values };
      delete oldValues.EngineWarnings;
      delete oldValues.PitRepairLeft;
      delete oldValues.PitOptRepairLeft;
      const oldFrame = decodeIRacingSourceFrame(new IRacingSourceFrameEncoder().encode({
        schemaVersion: 2,
        session: frame!.session,
        values: oldValues,
      }));
      expect(oldFrame).not.toBeNull();
      const oldPacket = normalizeIRacingFrame(oldFrame!);
      expect(oldPacket.iracing).not.toHaveProperty("engineWarnings");
      expect(oldPacket.iracing).not.toHaveProperty("pitRepairLeft");
      expect(oldPacket.iracing).not.toHaveProperty("pitOptRepairLeft");

      await source.stop();
    } finally {
      recording.cleanup();
    }
  });
  test("routes decoded native iRacing warnings through live voice delivery", async () => {
    const recording = createRecording("native-damage.ibt", [
      { sessionTime: 10, sessionTick: 600, speed: 50, lapDistancePct: 0.2, engineWarnings: 0, pitRepairLeft: 0, pitOptRepairLeft: 0 },
      { sessionTime: 13, sessionTick: 603, speed: 50, lapDistancePct: 0.3, engineWarnings: 0x80000004, pitRepairLeft: 8.5, pitOptRepairLeft: 0 },
      { sessionTime: 16.01, sessionTick: 606, speed: 50, lapDistancePct: 0.4, engineWarnings: 0x80000004, pitRepairLeft: 5.49, pitOptRepairLeft: 0 },
      { sessionTime: 16.02, sessionTick: 607, speed: 50, lapDistancePct: 0.41, engineWarnings: 0x80000004, pitRepairLeft: 5.48, pitOptRepairLeft: 0 },
    ]);
    try {
      const reader = new IRacingIbtReader(recording.path);
      reader.start();
      const delivered: Buffer[] = [];
      const source = new IRacingTelemetrySource({
        reader,
        dispatchRawFrame: async (raw) => { delivered.push(raw); },
      });
      while (await source.pollOnce()) { /* drain native fixture */ }

      const projector = new LiveTelemetryProjector();
      const catalog = new RaceEngineerTriggerCatalog();
      const emitted: unknown[] = [];
      const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
      const decoder = createIRacingSourceDecoderState();
      for (const raw of delivered) {
        const frame = decodeIRacingSourceFrame(raw, decoder);
        expect(frame).not.toBeNull();
        const packet = normalizeIRacingFrame(frame!);
        const semanticFrame = projector.project({
          packet,
          sessionId: 1,
          receivedAtMs: packet.TimestampMS,
        }).semanticFrame;
        engine.consume(catalog.consume(semanticFrame));
      }
      const segments = emitted
        .filter((message): message is { type: string; segmentIds: string[] } =>
          typeof message === "object" && message !== null &&
          "type" in message && message.type === "live-engineer-voice-line" &&
          "segmentIds" in message && Array.isArray(message.segmentIds))
        .flatMap((message) => message.segmentIds);
      expect(segments).toContain("race-engineer.damage-oil-pressure-warning");
      expect(segments).toContain("race-engineer.damage-required-repairs");
      expect(segments).not.toContain("race-engineer.damage-pit-limiter");
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
