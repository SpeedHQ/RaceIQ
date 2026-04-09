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

/** Simulate completing a lap: feed a mid-lap packet then a new-lap packet. */
function completeLap(tracker: PitTracker, lapNum: number, opts: {
  fuel: number;
  wearFL: number; wearFR: number; wearRL: number; wearRR: number;
  lapTime?: number;
}) {
  const lapTime = opts.lapTime ?? 90;
  // Mid-lap: set CurrentLap to the lap time (this is what lastCurrentLap captures)
  tracker.feed(pkt({
    LapNumber: lapNum,
    CurrentLap: lapTime,
    Fuel: opts.fuel + 0.01, // slightly more fuel than at boundary
    TireWearFL: opts.wearFL - 0.001,
    TireWearFR: opts.wearFR - 0.001,
    TireWearRL: opts.wearRL - 0.001,
    TireWearRR: opts.wearRR - 0.001,
  }), 5000);
  // Lap boundary
  tracker.feed(pkt({
    LapNumber: lapNum + 1,
    CurrentLap: 0,
    Fuel: opts.fuel,
    TireWearFL: opts.wearFL,
    TireWearFR: opts.wearFR,
    TireWearRL: opts.wearRL,
    TireWearRR: opts.wearRR,
  }), 5000);
}

describe("PitTracker", () => {
  test("no estimate before first completed lap", () => {
    const tracker = new PitTracker();
    const r = tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.05, CurrentLap: 10 }), 5000);
    expect(r.tireLapsToBad).toBeNull();
    expect(r.tireLapsToCritical).toBeNull();
    expect(r.tireWearPerLap).toBe(0);
    expect(r.fuelLapsRemaining).toBeNull();
  });

  test("fuel: rolling average of last 5 valid laps", () => {
    const tracker = new PitTracker();
    // Init
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, CurrentLap: 0 }), 5000);
    // Complete 3 laps using 0.10 fuel each
    completeLap(tracker, 1, { fuel: 0.90, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 2, { fuel: 0.80, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 3, { fuel: 0.70, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.70, CurrentLap: 5 }), 5000);
    expect(r.fuelPerLap).toBeCloseTo(0.10, 2);
    expect(r.fuelLapsRemaining).toBeCloseTo(7.0, 0);
  });

  test("tire: per-tire rolling average of last 3 laps, worst governs", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);

    // 3 laps: FL wears 0.08, 0.10, 0.12 → avg FL = 0.10
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.08, wearFR: 0.05, wearRL: 0.04, wearRR: 0.04 });
    completeLap(tracker, 2, { fuel: 0.8, wearFL: 0.18, wearFR: 0.10, wearRL: 0.08, wearRR: 0.08 });
    completeLap(tracker, 3, { fuel: 0.7, wearFL: 0.30, wearFR: 0.15, wearRL: 0.12, wearRR: 0.12 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.7, TireWearFL: 0.30, TireWearFR: 0.15, TireWearRL: 0.12, TireWearRR: 0.12, CurrentLap: 5 }), 5000);
    // FL avg = (0.08 + 0.10 + 0.12) / 3 = 0.10
    expect(r.tireWearPerLap).toBeCloseTo(0.10, 2);
    // health = 1 - 0.30 = 0.70, bad threshold = 0.40, wear until bad = 0.30
    // At 0.10/lap → 3.0 laps
    expect(r.tireLapsToBad).toBeCloseTo(3.0, 0);
  });

  test("tireLapsToCritical uses 20% health threshold", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.10, wearFR: 0.10, wearRL: 0.10, wearRR: 0.10 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.10, TireWearFR: 0.10, TireWearRL: 0.10, TireWearRR: 0.10, CurrentLap: 5 }), 5000);
    // health = 0.90, critical = 0.20, wear until critical = 0.70
    // At 0.10/lap → 7.0 laps
    expect(r.tireLapsToCritical).toBeCloseTo(7.0, 0);
  });

  test("setTireThresholds changes bad health target", () => {
    const tracker = new PitTracker();
    tracker.setTireThresholds(0.70); // ACC stricter

    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.10, wearFR: 0.08, wearRL: 0.06, wearRR: 0.06 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, CurrentLap: 5 }), 5000);
    // health = 0.90, bad = 0.70, wear until bad = 0.20, at 0.10/lap → 2.0
    expect(r.tireLapsToBad).toBeCloseTo(2.0, 0);
    // Critical unchanged: 7.0
    expect(r.tireLapsToCritical).toBeCloseTo(7.0, 0);
  });

  test("returns 0 when already past threshold", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.50, TireWearFR: 0.50, TireWearRL: 0.50, TireWearRR: 0.50, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.65, wearFR: 0.65, wearRL: 0.65, wearRR: 0.65 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.65, TireWearFR: 0.65, TireWearRL: 0.65, TireWearRR: 0.65, CurrentLap: 5 }), 5000);
    // health = 0.35, below bad (0.40) → 0
    expect(r.tireLapsToBad).toBe(0);
    // Above critical (0.20): 0.15 / 0.15 = 1.0
    expect(r.tireLapsToCritical).toBeCloseTo(1.0, 0);
  });

  test("pitInLaps uses whichever runs out first", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.90, wearFL: 0.10, wearFR: 0.10, wearRL: 0.10, wearRR: 0.10 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.90, TireWearFL: 0.10, TireWearFR: 0.10, TireWearRL: 0.10, TireWearRR: 0.10, CurrentLap: 5 }), 5000);
    // Fuel: 0.90 / 0.10 = 9.0
    // Tires to bad: (0.90 - 0.40) / 0.10 = 5.0
    expect(r.limitedBy).toBe("tires");
    expect(r.pitInLaps).toBeCloseTo(5.0, 0);
  });

  test("outlier rejection: skips formation lap (>2x average lap time)", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);

    // Normal lap: 90s, 0.10 fuel
    completeLap(tracker, 1, { fuel: 0.90, wearFL: 0.05, wearFR: 0.05, wearRL: 0.05, wearRR: 0.05, lapTime: 90 });
    // Another normal lap
    completeLap(tracker, 2, { fuel: 0.80, wearFL: 0.10, wearFR: 0.10, wearRL: 0.10, wearRR: 0.10, lapTime: 91 });

    // Formation/safety car lap: 200s (>2x 90.5 avg) — should be excluded
    completeLap(tracker, 3, { fuel: 0.78, wearFL: 0.11, wearFR: 0.11, wearRL: 0.11, wearRR: 0.11, lapTime: 200 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.78, CurrentLap: 5 }), 5000);
    // Fuel should still be ~0.10 (formation lap's 0.02 excluded)
    expect(r.fuelPerLap).toBeCloseTo(0.10, 1);
  });

  test("outlier rejection: skips refuel lap (fuel increased)", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 0.50, CurrentLap: 0 }), 5000);
    // Normal lap
    completeLap(tracker, 1, { fuel: 0.40, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0, lapTime: 90 });
    // Pit stop: fuel increased from 0.40 to 0.90
    completeLap(tracker, 2, { fuel: 0.90, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0, lapTime: 90 });

    const r = tracker.feed(pkt({ LapNumber: 3, Fuel: 0.90, CurrentLap: 5 }), 5000);
    // Should only have the first lap's 0.10 usage, pit lap excluded
    expect(r.fuelPerLap).toBeCloseTo(0.10, 2);
  });
});

describe("PitTracker history seeding per game", () => {
  test("shouldSeedTires returns false for fm-2023", () => {
    expect(PitTracker.shouldSeedTires("fm-2023")).toBe(false);
  });

  test("shouldSeedTires returns true for f1-2025", () => {
    expect(PitTracker.shouldSeedTires("f1-2025")).toBe(true);
  });

  test("shouldSeedTires returns true for acc", () => {
    expect(PitTracker.shouldSeedTires("acc")).toBe(true);
  });

  test("seeded fuel data produces immediate estimate", () => {
    const tracker = new PitTracker();
    tracker._seedForTest([0.08, 0.09], []);

    // No laps completed yet, but fuel history is seeded
    tracker.feed(pkt({ LapNumber: 1, Fuel: 0.50, CurrentLap: 0 }), 5000);
    const r = tracker.feed(pkt({ LapNumber: 1, Fuel: 0.50, CurrentLap: 10 }), 5000);

    expect(r.fuelPerLap).toBeCloseTo(0.085, 2);
    expect(r.fuelLapsRemaining).not.toBeNull();
    // Tires not seeded — no tire estimate
    expect(r.tireWearPerLap).toBe(0);
    expect(r.tireLapsToBad).toBeNull();
  });

  test("seeded tire data produces immediate tire estimate (F1/ACC)", () => {
    const tracker = new PitTracker();
    tracker._seedForTest([], [{ fl: 0.03, fr: 0.03, rl: 0.02, rr: 0.02 }]);

    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.10, TireWearFR: 0.10, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 0 }), 5000);
    const r = tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.10, TireWearFR: 0.10, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 10 }), 5000);

    // Worst tire wear rate = FL 0.03/lap
    expect(r.tireWearPerLap).toBeCloseTo(0.03, 2);
    expect(r.tireLapsToBad).not.toBeNull();
    expect(r.tireLapsToCritical).not.toBeNull();
  });

  test("fresh session laps replace seeded data via rolling average", () => {
    const tracker = new PitTracker();
    // Seed with 0.05 fuel/lap
    tracker._seedForTest([0.05, 0.05], []);

    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, CurrentLap: 0 }), 5000);
    // Complete 3 laps using 0.10 fuel each
    completeLap(tracker, 1, { fuel: 0.90, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 2, { fuel: 0.80, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 3, { fuel: 0.70, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.70, CurrentLap: 5 }), 5000);
    // Rolling 5: [0.05, 0.05, 0.10, 0.10, 0.10] → avg = 0.08
    expect(r.fuelPerLap).toBeCloseTo(0.08, 2);
  });
});
