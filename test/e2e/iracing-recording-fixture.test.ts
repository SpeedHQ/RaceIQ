import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline"
import type { DumpResult } from "../helpers/parse-dump";
import { parseDump } from "../helpers/parse-dump";

const FIXTURE =
  "test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz";

let recording: DumpResult;

beforeAll(async () => {
  recording = await parseDump("iracing", FIXTURE);
});

afterAll(() => stopMaintenanceTasks());

describe("committed iRacing seed fixture", () => {
  test("replays the compact real-telemetry window through the production parser", () => {
    expect(recording.rawPackets).toHaveLength(6_357);
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
