import { describe, expect, test } from "bun:test";
import { classifyPitCycleLap } from "../../shared/racing/laps/pit-cycle";
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
