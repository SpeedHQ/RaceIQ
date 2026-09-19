import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveTelemetryReplay } from "../../server/telemetry/replay";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import type { DumpResult } from "../support/recordings/parse-dump";
import { parseDump } from "../support/recordings/parse-dump";

const FIXTURE = "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz";
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
  recording = await parseDump("lmu", FIXTURE);
});

afterAll(() => stopMaintenanceTasks());

describe("committed LMU seed fixture", () => {
  test("replays compact real telemetry through production parser", () => {
    const session = recording.sessions[0]!;
    const identity = recording.rawPackets[0]?.lmu;
    if (!identity) throw new Error("LMU fixture has no packet identity");
    expect(session).toEqual(
      expect.objectContaining({
        carOrdinal: -1,
        trackOrdinal: -1,
        identity: {
          carId: identity.carId,
          trackId: identity.trackId,
        },
        gameId: "lmu",
      }),
    );
    expect(recording.carModel).toBe(identity.carModel);
    expect(recording.trackName).toBe(identity.trackName);

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

  test("extracts populated Analyse telemetry from the valid lap", () => {
    const validLap = recording.laps.at(-1)!;
    const replay = resolveTelemetryReplay(
      81,
      {
        id: 81,
        sessionId: 31,
        createdAt: "2026-09-19 11:11:24",
        gameId: "lmu",
        rawFile: null,
        rawByteOffset: null,
        rawFrameCount: null,
      },
      validLap.packets,
      ANALYSE_SEMANTIC_IDS,
    );
    expect(replay.envelopes).toHaveLength(1_423);
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
    expect(scalarRange("timing.current-lap")).toBeGreaterThan(142);
    expect(scalarRange("motion.position-x")).toBeGreaterThan(1_000);
    expect(scalarRange("motion.position-z")).toBeGreaterThan(1_500);
    expect(scalarRange("motion.speed")).toBeGreaterThan(50);
    expect(scalarRange("inputs.accel")).toBe(255);
    expect(scalarRange("inputs.brake")).toBe(255);
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
        lapNumber: 6,
        lapTime: 141.47467041015625,
        isValid: false,
      },
      {
        lapNumber: 7,
        lapTime: 141.98638916015625,
        isValid: false,
      },
      {
        lapNumber: 8,
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
