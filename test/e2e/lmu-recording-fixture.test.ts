import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import type { DumpResult } from "../support/recordings/parse-dump";
import { parseDump } from "../support/recordings/parse-dump";

const FIXTURE = "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz";

let recording: DumpResult;

beforeAll(async () => {
  recording = await parseDump("lmu", FIXTURE);
});

afterAll(() => stopMaintenanceTasks());

describe("committed LMU seed fixture", () => {
  test("replays compact real telemetry through production parser", () => {
    expect(recording.rawPackets).toHaveLength(4_309);
    expect(recording.sessions).toEqual([
      {
        carOrdinal: 1_896_582_084,
        trackOrdinal: 924_331_282,
        gameId: "lmu",
      },
    ]);
    expect(recording.carModel).toBe("Iron Lynx #60:LM");
    expect(recording.trackName).toBe("Circuit de Spa-Francorchamps");

    const speeds = recording.rawPackets.map((packet) => packet.Speed);
    const brakeInputs = recording.rawPackets.map((packet) => packet.Brake);
    expect(Math.max(...speeds)).toBeGreaterThan(70);
    expect(Math.max(...brakeInputs)).toBeGreaterThan(150);
    expect(
      recording.rawPackets.every(
        (packet) => packet.lmu?.driverName === "RaceIQ Fixture",
      ),
    ).toBe(true);
  });

  test("retains complete race laps and native timing", () => {
    expect(
      recording.laps.map((lap) => ({
        lapNumber: lap.lapNumber,
        lapTime: lap.lapTime,
        isValid: lap.isValid,
      })),
    ).toEqual([
      {
        lapNumber: 5,
        lapTime: 141.47467041015625,
        isValid: false,
      },
      {
        lapNumber: 6,
        lapTime: 141.98638916015625,
        isValid: false,
      },
      {
        lapNumber: 7,
        lapTime: 142.2401123046875,
        isValid: true,
      },
    ]);

    const validLap = recording.laps.at(-1);
    expect(validLap?.sectors).toHaveLength(3);
    expect(
      validLap!.sectors!.reduce((sum, sector) => sum + sector, 0),
    ).toBeCloseTo(validLap!.lapTime, 3);
  });
});
