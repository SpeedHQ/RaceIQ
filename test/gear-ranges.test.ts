import { describe, test, expect } from "bun:test";
import { computeGearRanges } from "../client/src/lib/gear-ranges";
import type { GearingSample } from "../client/src/lib/gearing-telemetry";
import { initGameAdapters } from "../shared/games/init";

initGameAdapters();

function makePacket(overrides: Partial<GearingSample> = {}): GearingSample {
  return {
    gameId: "fm-2023",
    CarOrdinal: 1,
    TrackOrdinal: 1,
    Accel: 255,
    Brake: 0,
    Gear: 1,
    raceActive: true,
    rpm: 3000,
    EngineMaxRpm: 8000,
    EngineIdleRpm: 1000,
    speedMps: 20,
    AccelerationZ: 0,
    powerW: 100000,
    torqueNm: 300,
    LapNumber: 1,
    DistanceTraveled: 0,
    ...overrides,
  };
}

describe("computeGearRanges", () => {
  test("returns empty array for empty input", () => {
    expect(computeGearRanges([])).toEqual([]);
  });

  test("computes min/max for a single gear", () => {
    const packets = [
      makePacket({ Gear: 1, rpm: 3000, speedMps: 50 }),
      makePacket({ Gear: 1, rpm: 5000, speedMps: 80 }),
      makePacket({ Gear: 1, rpm: 4000, speedMps: 60 }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([{ gear: 1, minRpm: 3000, maxRpm: 5000, minSpeedMps: 50, maxSpeedMps: 80 }]);
  });

  test("computes ranges for multiple gears", () => {
    const packets = [
      makePacket({ Gear: 1, rpm: 7000, speedMps: 80 }),
      makePacket({ Gear: 2, rpm: 5000, speedMps: 100 }),
      makePacket({ Gear: 1, rpm: 2000, speedMps: 30 }),
      makePacket({ Gear: 2, rpm: 6000, speedMps: 120 }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([
      { gear: 1, minRpm: 2000, maxRpm: 7000, minSpeedMps: 30, maxSpeedMps: 80 },
      { gear: 2, minRpm: 5000, maxRpm: 6000, minSpeedMps: 100, maxSpeedMps: 120 },
    ]);
  });

  test("filters out neutral and reverse", () => {
    const packets = [
      makePacket({ Gear: 0, rpm: 3000, speedMps: 0 }),
      makePacket({ Gear: 11, rpm: 2000, speedMps: 10 }),
      makePacket({ Gear: 1, rpm: 4000, speedMps: 60 }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([{ gear: 1, minRpm: 4000, maxRpm: 4000, minSpeedMps: 60, maxSpeedMps: 60 }]);
  });

  test("filters invalid samples (raceActive false for fm-2023)", () => {
    const packets = [
      makePacket({ Gear: 1, rpm: 3000, speedMps: 50, raceActive: false }),
      makePacket({ Gear: 1, rpm: 5000, speedMps: 80, raceActive: true }),
    ];
    const result = computeGearRanges(packets);
    expect(result).toEqual([{ gear: 1, minRpm: 5000, maxRpm: 5000, minSpeedMps: 80, maxSpeedMps: 80 }]);
  });

  test("sorts gears numerically", () => {
    const packets = [
      makePacket({ Gear: 3, rpm: 4000, speedMps: 90 }),
      makePacket({ Gear: 1, rpm: 3000, speedMps: 50 }),
      makePacket({ Gear: 2, rpm: 3500, speedMps: 70 }),
    ];
    const result = computeGearRanges(packets);
    expect(result.map((r) => r.gear)).toEqual([1, 2, 3]);
  });
});
