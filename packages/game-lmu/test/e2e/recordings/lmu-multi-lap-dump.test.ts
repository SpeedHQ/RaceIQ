import { lmuRecordingSupport } from "@raceiq/game-lmu/test-support/recordings";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveTelemetryReplay } from "@raceiq/backend-core/telemetry/replay";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import type { DumpResult } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { parseDump } from "@raceiq/backend-core/test-support/recordings/parse-dump";

const FIXTURE = "packages/game-lmu/test/fixtures/laps/lmu-2026-09-19T20-09-44-686Z.bin.gz";
const ANALYSE_SEMANTIC_IDS = [
  "inputs.accel",
  "inputs.brake",
  "inputs.steer",
  "motion.position-x",
  "motion.position-z",
  "motion.speed",
  "suspension.suspension-travel-m",
  "timing.current-lap",
  "tire.temperature.surface.representative",
  "tires.tire-pressure",
  "tires.tire-slip-ratio",
  "tires.tire-wear",
] as const;

let recording: DumpResult;

beforeAll(async () => {
  recording = await parseDump(lmuRecordingSupport, FIXTURE);
}, 60_000);

afterAll(() => stopMaintenanceTasks());

describe("LMU multi-lap dump", () => {
  test("detects one-based laps, pit-cycle boundaries, and sectors", () => {
    expect(
      recording.laps.map(({ lapNumber, lapTime, classification, isValid, invalidReason }) => ({
        lapNumber,
        lapTime,
        classification,
        isValid,
        invalidReason,
      })),
    ).toEqual([
      { lapNumber: 4, lapTime: 133.14650390625002, classification: "out_lap", isValid: true, invalidReason: null },
      { lapNumber: 5, lapTime: 95.47928710937504, classification: "pace", isValid: true, invalidReason: null },
      { lapNumber: 6, lapTime: 85.16931640624989, classification: "pace", isValid: true, invalidReason: null },
      { lapNumber: 7, lapTime: 85.161865234375, classification: "in_lap", isValid: false, invalidReason: "telemetry lap time mismatch" },
      { lapNumber: 8, lapTime: 14.863720703125182, classification: null, isValid: false, invalidReason: "incomplete" },
    ]);

    expect(recording.laps[4].sectors).toBeNull();

    const bestLap = Math.min(
      ...recording.rawPackets
        .map((packet) => packet.BestLap)
        .filter((lapTime) => lapTime > 0),
    );
    expect(bestLap).toBeCloseTo(85.162, 3);

    for (const lap of recording.laps.slice(0, 4)) {
      expect(lap.sectors).toHaveLength(3);
      expect(lap.sectors!.reduce((sum, sector) => sum + sector, 0)).toBeCloseTo(
        lap.lapTime,
        3,
      );
    }
  });

  test("extracts populated Analyse telemetry and physical variation from valid Bahrain lap", () => {
    const validLap = recording.laps.find((lap) => lap.isValid && lap.classification === "pace")!;
    const replay = resolveTelemetryReplay(
      81,
      {
        id: 81,
        sessionId: 31,
        createdAt: "2026-09-19 11:11:24",
        gameId: "lmu",
        source: null,
        carId: recording.sessions[0]!.carId,
        trackId: recording.sessions[0]!.trackId,
        rawFile: null,
        rawByteOffset: null,
        rawFrameCount: null,
        captureFormatVersion: null,
      },
      validLap.packets,
      ANALYSE_SEMANTIC_IDS,
    );
    expect(replay.envelopes).toHaveLength(8_701);
    expect(
      replay.envelopes.every((envelope) =>
        envelope.values.every(
          (value) => value.state === "ok" && value.value !== null,
        ),
      ),
    ).toBe(true);

    const scalarRange = (semanticId: string) => {
      const values = replay.envelopes
        .map(
          (envelope) =>
            envelope.values.find((value) => value.semanticId === semanticId)
              ?.value,
        )
        .filter((value): value is number => typeof value === "number");
      return Math.max(...values) - Math.min(...values);
    };
    expect(scalarRange("timing.current-lap")).toBeGreaterThan(validLap.lapTime - 1);
    expect(scalarRange("motion.position-x")).toBeGreaterThan(500);
    expect(scalarRange("motion.position-z")).toBeGreaterThan(1_000);
    expect(scalarRange("motion.speed")).toBeGreaterThan(50);
    expect(scalarRange("inputs.accel")).toBe(255);
    expect(scalarRange("inputs.brake")).toBe(255);
    expect(scalarRange("inputs.steer")).toBeGreaterThan(200);
  });
});

