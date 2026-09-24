import { describe, expect, test } from "bun:test";
import { computeEffectiveGearing, effectiveGearReady, updateEffectiveGearing } from "../client/src/lib/gear-ranges";
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
    rpm: 3_000,
    EngineMaxRpm: 8_000,
    EngineIdleRpm: 1_000,
    speedMps: 20,
    AccelerationZ: 0,
    powerW: 100_000,
    torqueNm: 300,
    LapNumber: 1,
    DistanceTraveled: 0,
    ...overrides,
  };
}

describe("effective gearing inference", () => {
  test("learns redline speed from consistent RPM and speed samples", () => {
    const rpmPerMps = 120;
    const packets = Array.from({ length: 25 }, (_, index) => {
      const rpm = 2_000 + index * 200;
      return makePacket({ Gear: 3, rpm, speedMps: rpm / rpmPerMps });
    });

    const learned = computeEffectiveGearing(packets)[3];
    expect(learned.rpmPerMps).toBeCloseTo(rpmPerMps, 6);
    expect(learned.sampleCount).toBe(25);
    expect(effectiveGearReady(learned)).toBe(true);
    expect(8_000 / learned.rpmPerMps).toBeCloseTo(66.666, 2);
  });

  test("keeps independent effective ratios for each observed gear", () => {
    const learned = computeEffectiveGearing([makePacket({ Gear: 1, rpm: 4_000, speedMps: 20 }), makePacket({ Gear: 2, rpm: 4_000, speedMps: 40 }), makePacket({ Gear: 3, rpm: 4_000, speedMps: 50 })]);

    expect(Object.keys(learned)).toEqual(["1", "2", "3"]);
    expect(learned[1].rpmPerMps).toBe(200);
    expect(learned[2].rpmPerMps).toBe(100);
    expect(learned[3].rpmPerMps).toBe(80);
  });

  test("rejects shift-slip outliers and samples without drive load", () => {
    let learned = computeEffectiveGearing(Array.from({ length: 6 }, (_, index) => makePacket({ rpm: 3_000 + index * 200, speedMps: (3_000 + index * 200) / 100 })));
    learned = updateEffectiveGearing(learned, makePacket({ rpm: 7_000, speedMps: 20 }));
    learned = updateEffectiveGearing(learned, makePacket({ rpm: 4_000, speedMps: 40, Accel: 0 }));
    learned = updateEffectiveGearing(learned, makePacket({ rpm: 4_000, speedMps: 40, Brake: 255 }));

    expect(learned[1].sampleCount).toBe(6);
    expect(learned[1].rpmPerMps).toBeCloseTo(100, 6);
  });
});
