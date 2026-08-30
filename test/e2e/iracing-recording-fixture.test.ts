import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline"
import type { DumpResult } from "../support/recordings/parse-dump";
import { parseDump } from "../support/recordings/parse-dump";

const FIXTURE =
  "test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz";

let recording: DumpResult;
let roadAmericaRecording: DumpResult;

beforeAll(async () => {
  recording = await parseDump("iracing", FIXTURE);
  roadAmericaRecording = await parseDump(
    "iracing",
    "test/artifacts/sessions/iracing-road-america-gt3.bin.gz",
  );
}, 30_000);

afterAll(() => stopMaintenanceTasks());

describe("committed iRacing recorder fixture", () => {
  test("replays every recorded SDK tick through the production parser", () => {
    expect(roadAmericaRecording.rawPackets).toHaveLength(138);
    expect(roadAmericaRecording.sessions).toEqual([
      {
        carOrdinal: 42,
        trackOrdinal: 99,
        gameId: "iracing",
      },
    ]);
    expect(roadAmericaRecording.carModel).toBe("GT3 Test Car");
    expect(roadAmericaRecording.trackName).toBe("Road America");

    const speeds = roadAmericaRecording.rawPackets.map((packet) => packet.Speed);
    const brakeInputs = roadAmericaRecording.rawPackets.map((packet) => packet.Brake);
    expect(Math.max(...speeds)).toBeGreaterThan(70);
    expect(Math.max(...brakeInputs)).toBeGreaterThan(150);
  });

  test("keeps delayed native timing attached to the two physical laps", () => {
    expect(roadAmericaRecording.laps).toHaveLength(2);
    expect(
      roadAmericaRecording.laps.map((lap) => ({
        lapNumber: lap.lapNumber,
        lapTime: lap.lapTime,
        isValid: lap.isValid,
        rawFrameCount: lap.rawFrameCount,
      })),
    ).toEqual([
      {
        lapNumber: 1,
        lapTime: 31.917,
        isValid: true,
        rawFrameCount: 65,
      },
      {
        lapNumber: 2,
        lapTime: 32.045,
        isValid: true,
        rawFrameCount: 62,
      },
    ]);
  });

  test("persists native three-sector timing from the recording", () => {
    for (const lap of roadAmericaRecording.laps) {
      expect(lap.sectors).not.toBeNull();
      const sectors = lap.sectors!;
      expect(sectors).toHaveLength(3);
      expect(sectors[0]).toBeGreaterThan(10);
      expect(sectors[1]).toBeGreaterThan(10);
      expect(sectors[2]).toBeGreaterThan(9);
      expect(sectors.reduce((sum, time) => sum + time, 0)).toBeCloseTo(
        lap.lapTime,
        6,
      );
    }
  });
});

describe("committed iRacing seed fixture", () => {
  test("replays the compact real-telemetry window through the production parser", () => {
    expect(recording.rawPackets).toHaveLength(44_495);
    expect(recording.sessions).toEqual([
      {
        carOrdinal: 206,
        trackOrdinal: 192,
        gameId: "iracing",
      },
    ]);
    expect(recording.carModel).toBe("Aston Martin Vantage GT3 EVO");
    expect(recording.trackName).toBe("Daytona International Speedway");

    const speeds = recording.rawPackets.map((packet) => packet.Speed);
    const brakeInputs = recording.rawPackets.map((packet) => packet.Brake);
    expect(Math.max(...speeds)).toBeGreaterThan(70);
    expect(Math.max(...brakeInputs)).toBeGreaterThan(150);
    expect(recording.rawPackets.some((packet) => packet.iracing?.onPitRoad)).toBe(true);
    expect(recording.rawPackets.some((packet) => packet.iracing?.onPitRoad === false)).toBe(true);
  });

  test("retains complete laps around lap 415's pit service", () => {
    expect(recording.laps.map((lap) => lap.lapNumber)).toEqual([
      413,
      414,
      415,
      416,
      417,
    ]);

    const pitEntry = recording.rawPackets.findIndex(
      (packet, index) =>
        packet.iracing?.onPitRoad === true &&
        recording.rawPackets[index - 1]?.iracing?.onPitRoad === false,
    );
    const pitExit = recording.rawPackets.findIndex(
      (packet, index) =>
        packet.iracing?.onPitRoad === false &&
        recording.rawPackets[index - 1]?.iracing?.onPitRoad === true,
    );
    expect(pitEntry).toBeGreaterThan(0);
    expect(recording.rawPackets[pitEntry]?.LapNumber).toBe(414);
    expect(pitExit).toBeGreaterThan(pitEntry);
    expect(recording.rawPackets[pitExit]?.LapNumber).toBe(415);

    const pitLap = recording.laps.find((lap) => lap.lapNumber === 415);
    expect(pitLap).toBeDefined();
    expect(pitLap!.packets.some((packet) => packet.iracing?.onPitRoad)).toBe(true);
    expect(pitLap!.packets[0]?.Fuel).toBeLessThan(2);
    expect(pitLap!.packets.at(-1)?.Fuel).toBeGreaterThan(100);
  });

  test("persists native five-sector timing from the recording", () => {
    for (const lap of recording.laps) {
      expect(lap.sectors).not.toBeNull();
      const sectors = lap.sectors!;
      expect(sectors).toHaveLength(5);
      expect(sectors.every((sector) => sector > 10)).toBe(true);
      expect(sectors.reduce((sum, time) => sum + time, 0)).toBeCloseTo(
        lap.lapTime,
        6,
      );
    }
  });
});
