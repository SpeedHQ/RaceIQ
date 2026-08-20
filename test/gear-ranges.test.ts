import { describe, test, expect } from "bun:test";
import { computeGearRanges, type GearRange } from "../client/src/lib/gear-ranges";
import type { DisplayPacket } from "../client/src/lib/convert-packet";

function makePacket(overrides: Partial<DisplayPacket>): DisplayPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 0,
    EngineMaxRpm: 8000,
    EngineIdleRpm: 1000,
    CurrentEngineRpm: 3000,
    AccelerationX: 0,
    AccelerationY: 0,
    AccelerationZ: 0,
    VelocityX: 0,
    VelocityY: 0,
    VelocityZ: 0,
    AngularVelocityX: 0,
    AngularVelocityY: 0,
    AngularVelocityZ: 0,
    Yaw: 0,
    Pitch: 0,
    Roll: 0,
    NormSuspensionTravelFL: 0,
    NormSuspensionTravelFR: 0,
    NormSuspensionTravelRL: 0,
    NormSuspensionTravelRR: 0,
    TireSlipRatioFL: 0,
    TireSlipRatioFR: 0,
    TireSlipRatioRL: 0,
    TireSlipRatioRR: 0,
    WheelRotationSpeedFL: 0,
    WheelRotationSpeedFR: 0,
    WheelRotationSpeedRL: 0,
    WheelRotationSpeedRR: 0,
    WheelOnRumbleStripFL: 0,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
    WheelInPuddleDepthFL: 0,
    WheelInPuddleDepthFR: 0,
    WheelInPuddleDepthRL: 0,
    WheelInPuddleDepthRR: 0,
    SurfaceRumbleFL_2: 0,
    SurfaceRumbleFR_2: 0,
    SurfaceRumbleRL_2: 0,
    SurfaceRumbleRR_2: 0,
    TireSlipCombinedFL_2: 0,
    TireTempFL: 0,
    TireTempFR: 0,
    TireTempRL: 0,
    TireTempRR: 0,
    Boost: 0,
    Fuel: 0,
    DistanceTraveled: 0,
    BestLap: 0,
    LastLap: 0,
    CurrentLap: 0,
    CurrentRaceTime: 0,
    LapNumber: 1,
    RacePosition: 1,
    Accel: 255,
    Brake: 0,
    Clutch: 0,
    HandBrake: 0,
    Gear: 1,
    Steer: 0,
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    SurfaceRumbleFL: 0,
    SurfaceRumbleFR: 0,
    SurfaceRumbleRL: 0,
    SurfaceRumbleRR: 0,
    TireSlipAngleFL: 0,
    TireSlipAngleFR: 0,
    TireSlipAngleRL: 0,
    TireSlipAngleRR: 0,
    TireCombinedSlipFL: 0,
    TireCombinedSlipFR: 0,
    TireCombinedSlipRL: 0,
    TireCombinedSlipRR: 0,
    SuspensionTravelMFL: 0,
    SuspensionTravelMFR: 0,
    SuspensionTravelMRL: 0,
    SuspensionTravelMRR: 0,
    CarOrdinal: 1,
    CarClass: 1,
    CarPerformanceIndex: 700,
    DrivetrainType: 1,
    NumCylinders: 6,
    PositionX: 0,
    PositionY: 0,
    PositionZ: 0,
    Speed: 20,
    Power: 100000,
    Torque: 300,
    TrackOrdinal: 1,
    DisplaySpeed: 72,
    DisplayTireTempFL: 0,
    DisplayTireTempFR: 0,
    DisplayTireTempRL: 0,
    DisplayTireTempRR: 0,
    DisplayPower: 134,
    DisplayTorque: 300,
    ...overrides,
  } as DisplayPacket;
}

describe("computeGearRanges", () => {
  test("returns empty array for empty input", () => {
    expect(computeGearRanges([])).toEqual([]);
  });

  test("computes min/max for a single gear", () => {
    const packets = [
      makePacket({ Gear: 1, CurrentEngineRpm: 3000, DisplaySpeed: 50 }),
      makePacket({ Gear: 1, CurrentEngineRpm: 5000, DisplaySpeed: 80 }),
      makePacket({ Gear: 1, CurrentEngineRpm: 4000, DisplaySpeed: 60 }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([
      { gear: 1, minRpm: 3000, maxRpm: 5000, minSpeed: 50, maxSpeed: 80 },
    ]);
  });

  test("computes ranges for multiple gears", () => {
    const packets = [
      makePacket({ Gear: 1, CurrentEngineRpm: 7000, DisplaySpeed: 80 }),
      makePacket({ Gear: 2, CurrentEngineRpm: 5000, DisplaySpeed: 100 }),
      makePacket({ Gear: 1, CurrentEngineRpm: 2000, DisplaySpeed: 30 }),
      makePacket({ Gear: 2, CurrentEngineRpm: 6000, DisplaySpeed: 120 }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([
      { gear: 1, minRpm: 2000, maxRpm: 7000, minSpeed: 30, maxSpeed: 80 },
      { gear: 2, minRpm: 5000, maxRpm: 6000, minSpeed: 100, maxSpeed: 120 },
    ]);
  });

  test("filters out neutral and reverse", () => {
    const packets = [
      makePacket({ Gear: 0, CurrentEngineRpm: 3000, DisplaySpeed: 0 }),
      makePacket({ Gear: 11, CurrentEngineRpm: 2000, DisplaySpeed: 10 }),
      makePacket({ Gear: 1, CurrentEngineRpm: 4000, DisplaySpeed: 60 }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([
      { gear: 1, minRpm: 4000, maxRpm: 4000, minSpeed: 60, maxSpeed: 60 },
    ]);
  });

  test("filters invalid samples (IsRaceOn <= 0 for fm-2023)", () => {
    const packets = [
      makePacket({ Gear: 1, CurrentEngineRpm: 3000, DisplaySpeed: 50, IsRaceOn: 0 }),
      makePacket({ Gear: 1, CurrentEngineRpm: 5000, DisplaySpeed: 80, IsRaceOn: 1 }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([
      { gear: 1, minRpm: 5000, maxRpm: 5000, minSpeed: 80, maxSpeed: 80 },
    ]);
  });

  test("sorts gears numerically", () => {
    const packets = [
      makePacket({ Gear: 3, CurrentEngineRpm: 4000, DisplaySpeed: 90 }),
      makePacket({ Gear: 1, CurrentEngineRpm: 3000, DisplaySpeed: 50 }),
      makePacket({ Gear: 2, CurrentEngineRpm: 3500, DisplaySpeed: 70 }),
    ];
    const result = computeGearRanges(packets);
    expect(result.map((r) => r.gear)).toEqual([1, 2, 3]);
  });
});
