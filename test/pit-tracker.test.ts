import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import { PitTracker } from "../server/sector-tracker";

function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 0,
    DistanceTraveled: 0,
    CurrentLap: 0,
    LastLap: 0,
    BestLap: 0,
    LapNumber: 1,
    PositionX: 0,
    PositionZ: 0,
    Speed: 50,
    Fuel: 1.0,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    ...overrides,
  } as TelemetryPacket;
}

describe("PitTracker tire estimates", () => {
  test("no estimate before first completed lap", () => {
    const tracker = new PitTracker();
    const r = tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.05 }), 5000);
    expect(r.tireLapsToBad).toBeNull();
    expect(r.tireLapsToCritical).toBeNull();
    expect(r.tireWearPerLap).toBe(0);
  });

  test("uses last lap wear rate after first completed lap", () => {
    const tracker = new PitTracker();
    // Lap 1: tires at 0% wear
    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, Fuel: 1 }), 5000);

    // Lap 2 starts: tires at 5% wear (worst tire wore 0.05 in one lap)
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.05, TireWearFR: 0.04, TireWearRL: 0.03, TireWearRR: 0.03, Fuel: 0.9 }), 5000);

    const r = tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.06, TireWearFR: 0.05, TireWearRL: 0.04, TireWearRR: 0.04, Fuel: 0.89 }), 5000);
    // Last lap wear rate = 0.05 (worst tire FL)
    expect(r.tireWearPerLap).toBe(0.05);
    expect(r.tireLapsToBad).not.toBeNull();
    expect(r.tireLapsToCritical).not.toBeNull();
  });

  test("tireLapsToBad uses game yellow threshold (default 0.40)", () => {
    const tracker = new PitTracker();
    // Default badHealthThreshold = 0.40

    // Lap 1: fresh tires
    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, Fuel: 1 }), 5000);
    // Lap 2: worst tire wore 0.10 per lap
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, Fuel: 0.9 }), 5000);

    // Current state: worst wear = 0.10, health = 0.90
    // Wear until bad (0.40 health) = 0.90 - 0.40 = 0.50
    // At 0.10 per lap → 5.0 laps
    const r = tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, Fuel: 0.89 }), 5000);
    expect(r.tireLapsToBad).toBeCloseTo(5.0, 0);
  });

  test("tireLapsToCritical uses 20% health threshold", () => {
    const tracker = new PitTracker();

    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, Fuel: 1 }), 5000);
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, Fuel: 0.9 }), 5000);

    // Current: worst wear = 0.10, health = 0.90
    // Wear until critical (0.20 health) = 0.90 - 0.20 = 0.70
    // At 0.10 per lap → 7.0 laps
    const r = tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, Fuel: 0.89 }), 5000);
    expect(r.tireLapsToCritical).toBeCloseTo(7.0, 0);
  });

  test("setTireThresholds changes bad health target", () => {
    const tracker = new PitTracker();
    tracker.setTireThresholds(0.70); // ACC-like stricter threshold

    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, Fuel: 1 }), 5000);
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, Fuel: 0.9 }), 5000);

    // health = 0.90, badThreshold = 0.70, wear until bad = 0.20
    // At 0.10 per lap → 2.0 laps
    const r = tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, Fuel: 0.89 }), 5000);
    expect(r.tireLapsToBad).toBeCloseTo(2.0, 0);
    // Critical (0.20) unchanged: 7.0 laps
    expect(r.tireLapsToCritical).toBeCloseTo(7.0, 0);
  });

  test("wear rate updates each lap (uses last lap only)", () => {
    const tracker = new PitTracker();

    // Lap 1: fresh
    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, Fuel: 1 }), 5000);
    // Lap 2: wore 0.10
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, TireWearFR: 0.10, TireWearRL: 0.10, TireWearRR: 0.10, Fuel: 0.9 }), 5000);
    expect(tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.10, Fuel: 0.89 }), 5000).tireWearPerLap).toBe(0.10);

    // Lap 3: wore only 0.02 this lap (tires cooled down, less aggressive)
    tracker.feed(pkt({ LapNumber: 3, TireWearFL: 0.12, TireWearFR: 0.12, TireWearRL: 0.12, TireWearRR: 0.12, Fuel: 0.8 }), 5000);
    const r = tracker.feed(pkt({ LapNumber: 3, TireWearFL: 0.12, TireWearFR: 0.12, TireWearRL: 0.12, TireWearRR: 0.12, Fuel: 0.79 }), 5000);
    // Should use last lap rate (0.02), not average
    expect(r.tireWearPerLap).toBeCloseTo(0.02, 5);
  });

  test("returns 0 laps when already past threshold", () => {
    const tracker = new PitTracker();

    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.50, TireWearFR: 0.50, TireWearRL: 0.50, TireWearRR: 0.50, Fuel: 1 }), 5000);
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.65, TireWearFR: 0.65, TireWearRL: 0.65, TireWearRR: 0.65, Fuel: 0.9 }), 5000);

    // health = 0.35, below default bad threshold (0.40)
    const r = tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0.65, TireWearFR: 0.65, TireWearRL: 0.65, TireWearRR: 0.65, Fuel: 0.89 }), 5000);
    expect(r.tireLapsToBad).toBe(0);
    // Still above critical (0.20): health 0.35 - 0.20 = 0.15 remaining at 0.15/lap → 1.0
    expect(r.tireLapsToCritical).toBeCloseTo(1.0, 0);
  });

  test("fuel estimate uses recent 5-lap average", () => {
    const tracker = new PitTracker();

    // Complete 3 laps using 0.10 fuel each
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0 }), 5000);
    tracker.feed(pkt({ LapNumber: 2, Fuel: 0.90 }), 5000);
    tracker.feed(pkt({ LapNumber: 3, Fuel: 0.80 }), 5000);
    tracker.feed(pkt({ LapNumber: 4, Fuel: 0.70 }), 5000);

    // Fuel = 0.70, avg per lap = 0.10, laps remaining = 7.0
    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.70 }), 5000);
    expect(r.fuelPerLap).toBeCloseTo(0.10, 2);
    expect(r.fuelLapsRemaining).toBeCloseTo(7.0, 0);
  });

  test("pitInLaps uses whichever runs out first", () => {
    const tracker = new PitTracker();

    // Fuel: 0.10/lap, start at 1.0 → 10 laps of fuel
    // Tires: 0.10/lap wear, start fresh → 6 laps to bad (0.40)
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0 }), 5000);
    tracker.feed(pkt({ LapNumber: 2, Fuel: 0.90, TireWearFL: 0.10, TireWearFR: 0.10, TireWearRL: 0.10, TireWearRR: 0.10 }), 5000);

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.90, TireWearFL: 0.10, TireWearFR: 0.10, TireWearRL: 0.10, TireWearRR: 0.10 }), 5000);
    // Fuel: 0.90 / 0.10 = 9.0 laps
    // Tires to bad: (0.90 - 0.40) / 0.10 = 5.0 laps
    expect(r.limitedBy).toBe("tires");
    expect(r.pitInLaps).toBeCloseTo(5.0, 0);
  });
});
