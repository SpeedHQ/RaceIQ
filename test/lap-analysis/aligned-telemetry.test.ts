import { describe, expect, test } from "bun:test";
import { alignLapSet, type AlignmentLapInput } from "../../shared/racing/laps/alignment/build";
import type { TelemetryPacket } from "../../shared/telemetry/types";

function telemetry(wearRR: number[] = [0, 0.1, 0.2]): TelemetryPacket[] {
  return [0, 1, 2].map((distance, index) => ({
    DistanceTraveled: distance,
    CurrentLap: index,
    TimestampMS: index * 1_000,
    Speed: 20 + index,
    Accel: 128,
    Brake: 0,
    Steer: 0,
    CurrentEngineRpm: 4_000 + index,
    Gear: 3,
    PositionX: 0,
    PositionZ: 0,
    Yaw: 0,
    Fuel: 50 - index,
    TireWearFL: index / 10,
    TireWearFR: index / 10,
    TireWearRL: index / 10,
    TireWearRR: wearRR[index],
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
}

function input(lapId: number, wearRR?: number[]): AlignmentLapInput {
  return {
    lapId,
    lapNumber: lapId,
    lapTime: 60 + lapId,
    isValid: true,
    telemetry: telemetry(wearRR),
    sectorTimes: [20, 21, 22],
    sectorStarts: [0.33, 0.67],
  };
}

describe("aligned telemetry", () => {
  test("keeps ordered laps on an endpoint-inclusive one-metre grid", () => {
    const set = alignLapSet([input(3), input(1), input(2)], { gridStepMeters: 1 });
    expect([...set.distanceMeters]).toEqual([0, 1, 2]);
    expect(set.distanceStartMeters).toBe(0);
    expect(set.distanceEndMeters).toBe(2);
    expect(set.stepMeters).toBe(1);
    expect(set.laps.map((lap) => lap.lapId)).toEqual([3, 1, 2]);
    expect(set.laps[0]?.sectorTimes).toEqual([20, 21, 22]);
    expect(set.laps[0]?.sectorStarts).toEqual([0.33, 0.67]);
  });

  test("retains zero wear and requires every wheel channel", () => {
    const available = alignLapSet([input(1)], { gridStepMeters: 1 }).laps[0]!;
    expect(available.tireWear).not.toBeNull();
    expect(available.tireWear?.FL[0]).toBe(0);
    expect(available.tireWear?.RR[0]).toBe(0);

    const unavailable = alignLapSet([input(2, [-1, Number.NaN, -1])], { gridStepMeters: 1 }).laps[0]!;
    expect(unavailable.tireWear).toBeNull();
  });
});
