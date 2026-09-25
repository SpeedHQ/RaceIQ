import { describe, expect, test } from "bun:test";
import { classifyPitCycleLap, forzaPitTransitionEvidence } from "../../shared/racing/laps/pit-cycle";
import type { TelemetryPacket } from "../../shared/telemetry/types";

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
