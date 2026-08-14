import { describe, expect, test } from "bun:test";
import { classifyLap } from "../../shared/racing/laps/classification";
import type { TelemetryPacket } from "../../shared/telemetry/types";

function iracing(onPitRoad: boolean): TelemetryPacket {
  return { gameId: "iracing", iracing: { onPitRoad } } as TelemetryPacket;
}

function f1(
  pitLaneTimerActive: number,
  f1Fields: Record<string, unknown> = {},
  fields: Partial<TelemetryPacket> = {},
): TelemetryPacket {
  return {
    gameId: "f1-2025",
    f1: { pitLaneTimerActive, ...f1Fields },
    ...fields,
  } as TelemetryPacket;
}

function kunos(
  pitStatus: "out" | "pit_lane" | "in_pit",
  flagStatus?: string,
): TelemetryPacket {
  return { gameId: "acc", acc: { pitStatus, flagStatus } } as TelemetryPacket;
}

describe("classifyLap", () => {
  test("classifies normalized pit entry and exit signals", () => {
    expect(classifyLap([iracing(false), iracing(true)])).toEqual({
      phase: "in",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap([iracing(true), iracing(false)])).toEqual({
      phase: "out",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap([f1(0), f1(1)])).toEqual({
      phase: "in",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap([f1(1), f1(0)])).toEqual({
      phase: "out",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap([kunos("out"), kunos("pit_lane")]).phase).toBe("in");
    expect(classifyLap([kunos("in_pit"), kunos("out")]).phase).toBe("out");
    expect(classifyLap([kunos("in_pit"), kunos("pit_lane")]).phase).toBe("pit");
  });

  test("classifies F1 grid start from race-start metadata, not lap number alone", () => {
    const gridStart = {
      gameId: "f1-2025",
      LapNumber: 1,
      RacePosition: 3,
      CurrentRaceTime: 0.342,
      DistanceTraveled: 222.45,
      f1: { gridPosition: 3, pitLaneTimerActive: 0 },
    } as TelemetryPacket;
    const stationary = { ...gridStart, CurrentRaceTime: 0, DistanceTraveled: 0 };
    expect(classifyLap([stationary, gridStart])).toEqual({
      phase: "grid_start",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap([{ ...gridStart, f1: { pitLaneTimerActive: 0 } } as TelemetryPacket]).phase).toBe("flying");
    expect(classifyLap([{ ...gridStart, LapNumber: 2 }]).phase).toBe("flying");
  });

  test("preserves grid-start and caution overlap", () => {
    const gridStartUnderCaution = f1(
      0,
      { gridPosition: 3, safetyCarStatus: 1 },
      {
        LapNumber: 1,
        RacePosition: 3,
        CurrentRaceTime: 0.342,
        DistanceTraveled: 222.45,
      },
    );
    expect(classifyLap([gridStartUnderCaution])).toEqual({
      phase: "grid_start",
      conditions: ["caution"],
      paceEligibility: "excluded",
    });
  });

  test("preserves out-lap and yellow overlap", () => {
    expect(classifyLap([
      kunos("in_pit", "yellow"),
      kunos("out", "yellow"),
    ])).toEqual({
      phase: "out",
      conditions: ["caution"],
      paceEligibility: "excluded",
    });
  });

  test("preserves pit-lap and safety-car overlap", () => {
    expect(classifyLap([
      f1(1, { safetyCarStatus: 1 }),
      f1(1, { safetyCarStatus: 1 }),
    ])).toEqual({
      phase: "pit",
      conditions: ["caution"],
      paceEligibility: "excluded",
    });
  });

  test("maps F1 caution, slow zone, and formation independently in canonical order", () => {
    expect(classifyLap([f1(0, { safetyCarStatus: 2 })])).toEqual({
      phase: "flying",
      conditions: ["slow_zone"],
      paceEligibility: "excluded",
    });
    expect(classifyLap([f1(0, { safetyCarStatus: 3 })])).toEqual({
      phase: "flying",
      conditions: ["formation"],
      paceEligibility: "excluded",
    });

    expect(classifyLap([
      f1(0, { safetyCarStatus: 3 }),
      f1(0, { safetyCarStatus: 2 }),
      f1(0, { safetyCarStatus: 1 }),
      f1(0, { vehicleFIAFlags: 3 }),
    ])).toEqual({
      phase: "flying",
      conditions: ["caution", "slow_zone", "formation"],
      paceEligibility: "excluded",
    });
  });

  test("uses eligible flying phase when source exposes no non-pace signal", () => {
    expect(classifyLap([{ gameId: "fm-2023" } as TelemetryPacket])).toEqual({
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    });
  });
});
