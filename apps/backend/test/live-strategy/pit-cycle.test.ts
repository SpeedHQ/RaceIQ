import { describe, expect, test } from "bun:test";
import { classifyPitCycleLap, forzaPitTransitionEvidence } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { StrategyBoundary, StrategyBoundaryTracker } from "@raceiq/backend-core/live-strategy/strategy-context";
import { StrategyRebuild } from "@raceiq/backend-core/live-strategy/strategy-rebuild";
import type { LapCompleteEvent } from "@raceiq/backend-core/lap-detection/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";

initGameAdapters();
initServerGameAdapters();

function iracing(onPitRoad: boolean): TelemetryPacket {
  return { gameId: "iracing", iracing: { onPitRoad } } as TelemetryPacket;
}

function f1(pitLaneTimerActive: number): TelemetryPacket {
  return { gameId: "f1-2025", f1: { pitLaneTimerActive } } as TelemetryPacket;
}

function kunos(pitStatus: "out" | "pit_lane" | "in_pit"): TelemetryPacket {
  return { gameId: "acc", acc: { pitStatus } } as TelemetryPacket;
}

function forza(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "fm-2023",
    LapNumber: 1,
    CurrentLap: 70,
    LastLap: 0,
    Fuel: 0.05,
    TireWearFL: 0.05,
    TireWearFR: 0.05,
    TireWearRL: 0.05,
    TireWearRR: 0.05,
    ...overrides,
  } as TelemetryPacket;
}

describe("strategy boundary state", () => {
  test("keeps quantized refuel increments together until driving separates a later service", () => {
    const tracker = new StrategyBoundaryTracker();
    const packet = (fuel: number, distance = 100, lap = 1) => forza({ Fuel: fuel, DistanceTraveled: distance, LapNumber: lap });

    expect(tracker.observe(packet(0.05), packet(0.06)) & StrategyBoundary.Fuel).toBeTruthy();
    expect(tracker.observe(packet(0.06), packet(0.06)) & StrategyBoundary.Fuel).toBe(0);
    expect(tracker.observe(packet(0.06), packet(0.07)) & StrategyBoundary.Fuel).toBe(0);
    expect(tracker.observe(packet(0.07), packet(0.07)) & StrategyBoundary.Fuel).toBe(0);
    expect(tracker.observe(packet(0.07), packet(0.08)) & StrategyBoundary.Fuel).toBe(0);
    expect(tracker.observe(packet(0.08), packet(0.08, 101)) & StrategyBoundary.Fuel).toBe(0);
    expect(tracker.observe(packet(0.08, 101), packet(0.09, 101)) & StrategyBoundary.Fuel).toBeTruthy();
  });

  test("treats pit entry as service boundary, suppresses exit duplicate, and resets on next visit", () => {
    const tracker = new StrategyBoundaryTracker();
    const packet = (pitStatus: "out" | "pit_lane" | "in_pit", fuel: number) => ({ ...forza({ gameId: "acc", Fuel: fuel }), acc: { pitStatus } }) as TelemetryPacket;

    expect(tracker.observe(packet("out", 0.05), packet("pit_lane", 0.05)) & StrategyBoundary.Pit).toBeTruthy();
    expect(tracker.observe(packet("pit_lane", 0.05), packet("in_pit", 0.08)) & (StrategyBoundary.Pit | StrategyBoundary.Fuel)).toBe(0);
    expect(tracker.observe(packet("in_pit", 0.08), packet("out", 0.08)) & StrategyBoundary.Pit).toBe(0);
    expect(tracker.observe(packet("out", 0.08), packet("pit_lane", 0.08)) & StrategyBoundary.Pit).toBeTruthy();
  });

  test("keeps tire replacement independent and clears service marker on reset", () => {
    const tracker = new StrategyBoundaryTracker();
    const packet = (fuel: number, wear = 0.05) => forza({ Fuel: fuel, TireWearFL: wear });

    tracker.observe(packet(0.05), packet(0.06));
    expect(tracker.observe(packet(0.06), packet(0.07, 0.01)) & StrategyBoundary.Tires).toBeTruthy();
    tracker.reset();
    expect(tracker.observe(packet(0.07), packet(0.08)) & StrategyBoundary.Fuel).toBeTruthy();
  });
  test("keeps configuration and timebase boundaries while refueling is coalesced", () => {
    const tracker = new StrategyBoundaryTracker();
    const before = forza({ Fuel: 0.05, TimestampMS: 10_000 });
    tracker.observe(before, forza({ Fuel: 0.06, TimestampMS: 11_000 }));

    expect(tracker.observe(forza({ Fuel: 0.06, TimestampMS: 11_000 }), forza({ Fuel: 0.07, TimestampMS: 12_000, carId: "other" })) & StrategyBoundary.Configuration).toBeTruthy();
    expect(tracker.observe(forza({ Fuel: 0.07, TimestampMS: 12_000 }), forza({ Fuel: 0.08, TimestampMS: 1_000 })) & StrategyBoundary.Rewind).toBeTruthy();
  });

});

describe("StrategyRebuild segment breaks", () => {
  test("does not carry an abandoned crossed lap into same-number lap in next segment", () => {
    const rebuild = new StrategyRebuild(1, "local-player", "2025-01-01T00:00:00.000Z");
    const packet = (fuel: number, timestamp: number, distance: number) => forza({
      LapNumber: 1, Fuel: fuel, TimestampMS: timestamp, DistanceTraveled: distance, CurrentLap: distance / 1000,
    });
    rebuild.observe(packet(0.05, 1_000, 1_000));
    rebuild.observe(packet(0.07, 2_000, 2_000));
    rebuild.breakSegment();

    const first = packet(0.05, 3_000, 3_000);
    const last = packet(0.03, 4_000, 4_000);
    rebuild.observe(first);
    rebuild.prepare({ lapNumber: 1, packets: [first, last], lapDistStart: 0, lapTime: 70, isValid: true, sectors: null } satisfies LapCompleteEvent);

    expect(rebuild.summaries().at(-1)?.fuel.eligibleLaps).toBe(1);
    expect(rebuild.summaries().at(-1)?.fuel.value).toBeCloseTo(0.02, 4);
  });
});

describe("classifyPitCycleLap", () => {
  test("classifies iRacing pit entry and exit laps", () => {
    expect(classifyPitCycleLap([iracing(false), iracing(true)])).toBe("inlap");
    expect(classifyPitCycleLap([iracing(true), iracing(false)])).toBe("outlap");
  });

  test("classifies F1 pit entry and exit laps", () => {
    expect(classifyPitCycleLap([f1(0), f1(1)])).toBe("inlap");
    expect(classifyPitCycleLap([f1(1), f1(0)])).toBe("outlap");
  });

  test("preserves Kunos pit-cycle behavior", () => {
    expect(classifyPitCycleLap([kunos("out"), kunos("pit_lane")])).toBe("inlap");
    expect(classifyPitCycleLap([kunos("in_pit"), kunos("out")])).toBe("outlap");
    expect(classifyPitCycleLap([kunos("in_pit"), kunos("pit_lane")])).toBe("pit lap");
  });

  test("leaves Forza unclassified because its catalog has no pit-state source", () => {
    expect(classifyPitCycleLap([{ gameId: "fm-2023" } as TelemetryPacket])).toBeNull();
  });
});

describe("forzaPitTransitionEvidence", () => {
  test("uses timing gap with optional fuel and tire-service reinforcement", () => {
    const evidence = forzaPitTransitionEvidence(
      forza({ LapNumber: 1, CurrentLap: 70, Fuel: 0.04 }),
      forza({
        LapNumber: 2,
        CurrentLap: 6,
        LastLap: 99,
        Fuel: 0.13,
        TireWearFL: 0.001,
        TireWearFR: 0.001,
        TireWearRL: 0.001,
        TireWearRR: 0.001,
      }),
    );

    expect(evidence).toEqual({
      detected: true,
      raceOffObserved: false,
      timingGap: true,
      fuelIncreased: true,
      tireWearRefreshed: true,
    });
  });

  test("race-off marker detects a pit transition when service channels are unavailable", () => {
    const evidence = forzaPitTransitionEvidence(
      forza({ TireWearFL: -1, TireWearFR: -1, TireWearRL: -1, TireWearRR: -1 }),
      forza({
        LapNumber: 2,
        CurrentLap: 0.1,
        LastLap: 70.1,
        TireWearFL: -1,
        TireWearFR: -1,
        TireWearRL: -1,
        TireWearRR: -1,
      }),
      true,
    );

    expect(evidence.detected).toBe(true);
    expect(evidence.fuelIncreased).toBe(false);
    expect(evidence.tireWearRefreshed).toBe(false);
  });

  test("ordinary lap rollover is not a pit transition", () => {
    const evidence = forzaPitTransitionEvidence(
      forza({ LapNumber: 1, CurrentLap: 70 }),
      forza({ LapNumber: 2, CurrentLap: 0.1, LastLap: 70.1, Fuel: 0.049 }),
    );

    expect(evidence.detected).toBe(false);
  });
});
