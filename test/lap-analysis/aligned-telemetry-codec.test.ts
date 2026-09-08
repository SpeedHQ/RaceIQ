import { describe, expect, test } from "bun:test";
import { alignLapSet } from "../../shared/racing/laps/alignment/build";
import { decodeAlignedLapSet, encodeAlignedLapSet } from "../../shared/racing/laps/alignment/codec";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const telemetry = [0, 1, 2].map((distance, index) => ({
  DistanceTraveled: distance,
  CurrentLap: index,
  TimestampMS: index * 1_000,
  Speed: 30,
  Accel: 0,
  Brake: 0,
  Steer: 0,
  CurrentEngineRpm: 5_000,
  Gear: 4,
  PositionX: distance,
  PositionZ: distance,
  Yaw: 0,
  Fuel: 40,
  TireWearFL: index / 10,
  TireWearFR: index / 10 + 0.01,
  TireWearRL: index / 10 + 0.02,
  TireWearRR: index / 10 + 0.03,
  TireTempFL: 80,
  TireTempFR: 81,
  TireTempRL: 82,
  TireTempRR: 83,
  TirePressureFrontLeft: 27,
  TirePressureFrontRight: 28,
  TirePressureRearLeft: 29,
  TirePressureRearRight: 30,
  BrakeTempFrontLeft: 300,
  BrakeTempFrontRight: 301,
  BrakeTempRearLeft: 302,
  BrakeTempRearRight: 303,
})) as TelemetryPacket[];

describe("aligned telemetry codec", () => {
  test("round-trips sector metadata and every tire-wear wheel", () => {
    const original = alignLapSet([{
      lapId: 7,
      lapNumber: 2,
      lapTime: 62,
      isValid: true,
      telemetry,
      sectorTimes: [20, 21, 21],
      sectorStarts: [0.32, 0.68],
    }], { gridStepMeters: 1 });
    const decoded = decodeAlignedLapSet(encodeAlignedLapSet(original));
    const before = original.laps[0]!;
    const after = decoded.laps[0]!;

    expect(after.sectorTimes).toEqual(before.sectorTimes);
    expect(after.sectorStarts).toEqual(before.sectorStarts);
    expect([...after.tireWear!.FL]).toEqual([...before.tireWear!.FL]);
    expect([...after.tireWear!.FR]).toEqual([...before.tireWear!.FR]);
    expect([...after.tireWear!.RL]).toEqual([...before.tireWear!.RL]);
    expect([...after.tireWear!.RR]).toEqual([...before.tireWear!.RR]);
  });
});
