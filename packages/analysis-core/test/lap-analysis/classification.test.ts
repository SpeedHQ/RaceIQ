import { describe, expect, test } from "bun:test";
import { classifyLapCategory } from "@raceiq/analysis-core/racing/laps/classification";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

function f1Packet(time: number, native: Partial<NonNullable<TelemetryPacket["f1"]>> = {}) {
  // Deliberately narrow in-process fixture: classification reads only these source fields.
  const packet = {
    gameId: "f1-2025", CurrentRaceTime: time, LapNumber: 1, RacePosition: 3,
    f1: { sessionType: "practice", vehicleFIAFlags: 0, safetyCarStatus: 0,
      vehicleFIAFlagsUpdatedAt: time, safetyCarStatusUpdatedAt: time, ...native },
  } as TelemetryPacket;
  return packet;
}

describe("native lap category evidence", () => {
  test("transient player yellow survives a later green observation", () => {
    const packets = [f1Packet(1), f1Packet(2, { vehicleFIAFlags: 3 }), f1Packet(3, { vehicleFIAFlags: 1 })];
    expect(classifyLapCategory(packets, null, undefined, true)).toBe("caution");
    expect(classifyLapCategory(packets, null, undefined, false)).toBe("caution");
  });

  test.each([1, 2])("global safety-car state %i excludes the affected lap", (safetyCarStatus) => {
    expect(classifyLapCategory([f1Packet(1), f1Packet(2, { safetyCarStatus })], null, undefined, true)).toBe("caution");
  });

  test("formation, blue flags, and stale prior-lap yellow are not current caution evidence", () => {
    expect(classifyLapCategory([f1Packet(1, { safetyCarStatus: 3 })], null, undefined, true)).toBeNull();
    expect(classifyLapCategory([f1Packet(1, { vehicleFIAFlags: 2 })], null, undefined, true)).toBe("pace");
    expect(classifyLapCategory([f1Packet(5, { vehicleFIAFlags: 3, vehicleFIAFlagsUpdatedAt: 4 })], null, undefined, true)).toBeNull();
  });

  test("first packet of the next lap cannot give the completed lap a caution", () => {
    const boundary = f1Packet(3, { vehicleFIAFlags: 3 });
    expect(classifyLapCategory([f1Packet(1), f1Packet(2), boundary], null, boundary, true)).toBe("pace");
  });

  test("a source-backed standing start outranks pit and caution evidence", () => {
    expect(classifyLapCategory([
      f1Packet(1, { sessionType: "race", raceStartAt: 1, vehicleFIAFlags: 3 }),
      f1Packet(2, { sessionType: "race", raceStartAt: 1 }),
    ], "inlap", undefined, true)).toBe("grid_start");
  });

  test.each([
    ["outlap", "out_lap"], ["inlap", "in_lap"], ["pit lap", "pit_lap"],
  ] as const)("native %s evidence remains independent of bad recording quality", (reason, category) => {
    expect(classifyLapCategory([f1Packet(1, { vehicleFIAFlags: 3 })], reason, undefined, false)).toBe(category);
  });

  test("the #222 scalar values without a start sequence remain unknown", () => {
    const packet = f1Packet(0.342, { sessionType: "unknown", gridPosition: 3,
      vehicleFIAFlagsUpdatedAt: undefined, safetyCarStatusUpdatedAt: undefined });
    packet.DistanceTraveled = 222.45;
    expect(classifyLapCategory([packet], null, undefined, true)).toBeNull();
  });
});
test("AC Evo lap classification reads native session context; unknown stays unknown", () => {
  const packet = {
    gameId: "ac-evo", CurrentRaceTime: 1, LapNumber: 2,
    acc: { pitStatus: "out", flagStatus: "none", acEvo: { sessionType: "practice" } },
  } as unknown as TelemetryPacket;
  expect(classifyLapCategory([packet], null, undefined, true)).toBe("pace");
  const unknownPacket = {
    ...packet,
    acc: { ...packet.acc, acEvo: { ...packet.acc?.acEvo, sessionType: "unknown" } },
  } as TelemetryPacket;
  expect(classifyLapCategory([unknownPacket], null, undefined, true)).toBeNull();
});
