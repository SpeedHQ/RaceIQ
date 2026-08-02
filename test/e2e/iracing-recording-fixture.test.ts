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
  "test/artifacts/sessions/iracing-road-america-gt3.bin.gz";

let recording: DumpResult;

beforeAll(async () => {
  recording = await parseDump("iracing", FIXTURE);
});

afterAll(() => stopMaintenanceTasks());

describe("committed iRacing recorder fixture", () => {
  test("replays every recorded SDK tick through the production parser", () => {
    expect(recording.rawPackets).toHaveLength(138);
    expect(recording.sessions).toEqual([
      {
        carOrdinal: 42,
        trackOrdinal: 99,
        gameId: "iracing",
      },
    ]);
    expect(recording.carModel).toBe("GT3 Test Car");
    expect(recording.trackName).toBe("Road America");

    const speeds = recording.rawPackets.map((packet) => packet.Speed);
    const brakeInputs = recording.rawPackets.map((packet) => packet.Brake);
    expect(Math.max(...speeds)).toBeGreaterThan(70);
    expect(Math.max(...brakeInputs)).toBeGreaterThan(150);
  });

  test("keeps delayed native timing attached to the two physical laps", () => {
    expect(recording.laps).toHaveLength(2);
    expect(
      recording.laps.map((lap) => ({
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
    for (const lap of recording.laps) {
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
