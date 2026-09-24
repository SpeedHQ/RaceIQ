import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { parseDump } from "../support/recordings/parse-dump";

const FIXTURE = "test/artifacts/laps/lmu-2026-09-19T20-09-44-686Z.bin.gz";

let recording: Awaited<ReturnType<typeof parseDump>>;

beforeAll(async () => {
  recording = await parseDump("lmu", FIXTURE);
});

afterAll(() => stopMaintenanceTasks());

describe("LMU multi-lap dump", () => {
  test("detects one-based laps, pit-cycle boundaries, and sectors", () => {
    expect(
      recording.laps.map(({ lapNumber, lapTime, isValid, invalidReason }) => ({
        lapNumber,
        lapTime,
        isValid,
        invalidReason,
      })),
    ).toEqual([
      { lapNumber: 4, lapTime: 133.14650390625002, isValid: false, invalidReason: "outlap" },
      { lapNumber: 5, lapTime: 95.47928710937504, isValid: true, invalidReason: null },
      { lapNumber: 6, lapTime: 85.16931640624989, isValid: true, invalidReason: null },
      { lapNumber: 7, lapTime: 85.161865234375, isValid: false, invalidReason: "inlap" },
    ]);

    const bestLap = Math.min(
      ...recording.rawPackets
        .map((packet) => packet.BestLap)
        .filter((lapTime) => lapTime > 0),
    );
    expect(bestLap).toBeCloseTo(85.162, 3);

    for (const lap of recording.laps) {
      expect(lap.sectors).toHaveLength(3);
      expect(lap.sectors!.reduce((sum, sector) => sum + sector, 0)).toBeCloseTo(
        lap.lapTime,
        3,
      );
    }
  });
});
