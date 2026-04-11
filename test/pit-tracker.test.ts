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
  test("fm-2023: seeds fuel only (compound unknown)", () => {
    expect(PitTracker.shouldSeedFuel("fm-2023")).toBe(true);
    expect(PitTracker.shouldSeedTires("fm-2023")).toBe(false);
  });

  test("f1-2025: seeds tires only (no refueling)", () => {
    expect(PitTracker.shouldSeedFuel("f1-2025")).toBe(false);
    expect(PitTracker.shouldSeedTires("f1-2025")).toBe(true);
  });

  test("acc: seeds both fuel and tires", () => {
    expect(PitTracker.shouldSeedFuel("acc")).toBe(true);
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

describe("PitTracker wear curve interpolation", () => {
  /** Build packets simulating a lap with non-uniform wear profile. */
  function makeLapPackets(opts: {
    trackLen: number;
    distStart: number;
    count: number;
    /** Per-tire wear at each fraction [0,1] of the lap. Returns delta from start. */
    wearProfile: (frac: number) => [number, number, number, number];
  }): TelemetryPacket[] {
    const packets: TelemetryPacket[] = [];
    for (let i = 0; i < opts.count; i++) {
      const frac = i / (opts.count - 1);
      const [fl, fr, rl, rr] = opts.wearProfile(frac);
      packets.push(pkt({
        DistanceTraveled: opts.distStart + frac * opts.trackLen,
        CurrentLap: frac * 90,
        LapNumber: 1,
        TireWearFL: fl,
        TireWearFR: fr,
        TireWearRL: rl,
        TireWearRR: rr,
      }));
    }
    return packets;
  }

  test("updateWearCurves builds reference from completed lap", () => {
    const tracker = new PitTracker();
    const packets = makeLapPackets({
      trackLen: 1000,
      distStart: 0,
      count: 200,
      wearProfile: (f) => [f * 0.10, f * 0.08, f * 0.06, f * 0.06],
    });
    tracker.updateWearCurves(packets, 0);
    const ref = tracker._getRefWearCurve();
    expect(ref).not.toBeNull();
    expect(ref!.length).toBe(1000);
    // Total wear should match profile endpoint
    expect(ref!.totalWear[0]).toBeCloseTo(0.10, 2); // FL
    expect(ref!.totalWear[1]).toBeCloseTo(0.08, 2); // FR
  });

  test("averaged reference from 3 laps", () => {
    const tracker = new PitTracker();
    // 3 laps with varying FL wear: 0.08, 0.10, 0.12 → avg 0.10
    for (const total of [0.08, 0.10, 0.12]) {
      const packets = makeLapPackets({
        trackLen: 1000,
        distStart: 0,
        count: 200,
        wearProfile: (f) => [f * total, f * 0.05, f * 0.04, f * 0.04],
      });
      tracker.updateWearCurves(packets, 0);
    }
    const ref = tracker._getRefWearCurve();
    expect(ref).not.toBeNull();
    expect(ref!.totalWear[0]).toBeCloseTo(0.10, 2); // FL averaged
  });

  test("curve-based estimate adjusts mid-lap based on wear deviation", () => {
    const tracker = new PitTracker();
    // Build reference: uniform 0.10 FL wear over 1000m
    const packets = makeLapPackets({
      trackLen: 1000,
      distStart: 0,
      count: 200,
      wearProfile: (f) => [f * 0.10, f * 0.05, f * 0.04, f * 0.04],
    });
    tracker.updateWearCurves(packets, 0);

    // Init tracker state
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.20, TireWearFR: 0.10, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 0 }), 1000);
    // Simulate next lap boundary to set liveWearAtLapStart
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.20, TireWearFR: 0.10, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 85 }), 1000);
    tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.20, TireWearFR: 0.10, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 0 }), 1000);

    // At 500m (50%), ref says FL should have worn 0.05.
    // If actual FL is 0.06 (wore 0.01 more than expected), projected = 0.10 + 0.01 = 0.11
    const r = tracker.feed(pkt({
      LapNumber: 2,
      DistanceTraveled: 500,
      TireWearFL: 0.26, // 0.20 + 0.06 delta
      TireWearFR: 0.12,
      TireWearRL: 0.10,
      TireWearRR: 0.10,
      CurrentLap: 45,
      Fuel: 0.89,
    }), 1000, 0);

    // FL projected wear per lap should be ~0.11 (ref 0.10 + deviation 0.01)
    expect(r.tireEstimates.wearPerLap[0]).toBeCloseTo(0.11, 1);
  });

  test("falls back to rolling average when no curves", () => {
    const tracker = new PitTracker();
    // No curves built — just per-lap history
    tracker._seedForTest([], [
      { fl: 0.10, fr: 0.08, rl: 0.06, rr: 0.06 },
    ]);
    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, CurrentLap: 0, Fuel: 1 }), 5000);
    const r = tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.10, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, CurrentLap: 10, Fuel: 1 }), 5000);
    // Should use rolling average fallback
    expect(r.tireWearPerLap).toBeCloseTo(0.10, 2); // worst = FL
    expect(r.tireLapsToBad).not.toBeNull();
  });

  test("non-uniform wear profile gives better mid-lap estimates", () => {
    const tracker = new PitTracker();
    // Reference: first half of track causes 80% of wear (heavy braking zone)
    const packets = makeLapPackets({
      trackLen: 1000,
      distStart: 0,
      count: 200,
      wearProfile: (f) => {
        // 80% of wear in first 50% of distance
        const w = f < 0.5 ? f * 2 * 0.08 : 0.08 + (f - 0.5) * 2 * 0.02;
        return [w, w * 0.8, w * 0.6, w * 0.6];
      },
    });
    tracker.updateWearCurves(packets, 0);

    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0, Fuel: 1 }), 1000);
    tracker.feed(pkt({ LapNumber: 1, CurrentLap: 85, Fuel: 0.95 }), 1000);
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0, Fuel: 0.9 }), 1000);

    // At 750m (75% through), past the heavy zone — reference says most wear already happened
    // On pace: FL ref at 750m ≈ 0.08 + 0.5*0.02 = 0.09
    // Actual FL = 0.09 (on pace) → deviation = 0, projected = totalWear (0.10)
    const r = tracker.feed(pkt({
      LapNumber: 2,
      DistanceTraveled: 750,
      TireWearFL: 0.09,
      TireWearFR: 0.072,
      TireWearRL: 0.054,
      TireWearRR: 0.054,
      CurrentLap: 67,
      Fuel: 0.88,
    }), 1000, 0);

    // Projected FL ≈ 0.10 (reference total + ~0 deviation)
    expect(r.tireEstimates.wearPerLap[0]).toBeCloseTo(0.10, 1);
  });
});
