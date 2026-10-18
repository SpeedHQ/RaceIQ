import { describe, expect, test } from "bun:test";
import { classifyLapCategory } from "@raceiq/analysis-core/racing/laps/classification";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";

function pacePacket(gameId: GameId): TelemetryPacket {
  return {
    gameId, CurrentRaceTime: 10, LapNumber: 1,
    ...(gameId === "f1-2025" ? { f1: {
      sessionType: "practice", vehicleFIAFlags: 0, safetyCarStatus: 0,
      vehicleFIAFlagsUpdatedAt: 10, safetyCarStatusUpdatedAt: 10,
    } } : {}),
    ...(gameId === "acc" || gameId === "ac-evo" ? { acc: {
      pitStatus: "out", flagStatus: "none", sessionType: "practice",
      acEvo: { sessionType: "practice" },
    } } : {}),
  } as TelemetryPacket;
}

describe.each(KNOWN_GAME_IDS)("%s pace classification", (gameId) => {
  test("a quality-valid flying lap is pace, including recorded lap 1", () => {
    expect(classifyLapCategory([pacePacket(gameId)], null, undefined, true)).toBe("pace");
  });

  test("invalid recording quality and empty telemetry cannot establish pace", () => {
    expect(classifyLapCategory([pacePacket(gameId)], null, undefined, false)).toBeNull();
    expect(classifyLapCategory([], null, undefined, true)).toBeNull();
  });

  test.each([
    ["outlap", "out_lap"], ["inlap", "in_lap"], ["pit lap", "pit_lap"],
  ] as const)("%s evidence takes precedence over pace", (reason, category) => {
    expect(classifyLapCategory([pacePacket(gameId)], reason, undefined, true)).toBe(category);
  });
});

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

function accPitEntry(overrides: Partial<TelemetryPacket> = {}): [TelemetryPacket, TelemetryPacket] {
  const before = {
    gameId: "acc", TimestampMS: 1_000, PositionX: 100, PositionY: 5, PositionZ: 200,
    Speed: 0, acc: { pitStatus: "out", flagStatus: "none", sessionType: "practice" },
  } as TelemetryPacket;
  const after = {
    ...before, TimestampMS: 1_190, PositionX: 343.5,
    acc: { ...before.acc, pitStatus: "pit_lane" }, ...overrides,
  } as TelemetryPacket;
  return [before, after];
}

test("ACC teleport to pits is reset, independently of validity and pit-cycle category", () => {
  const packets = accPitEntry();
  expect(classifyLapCategory(packets, "inlap", undefined, false)).toBe("reset");
  expect(classifyLapCategory(packets, "pit lap", undefined, true)).toBe("reset");
});

test.each([
  { PositionX: 101 },
  { TimestampMS: 11_000 },
  { TimestampMS: 1_000 },
  { TimestampMS: 900 },
  { PositionX: Number.NaN },
  { PositionX: 0, PositionY: 0, PositionZ: 0 },
  { Speed: Number.NaN },
])("ACC pit entry without reliable teleport evidence stays in-lap: %j", (overrides) => {
  expect(classifyLapCategory(accPitEntry(overrides), "inlap", undefined, true)).toBe("in_lap");
});

test("physically plausible driven pit entry is not a reset", () => {
  const packets = accPitEntry({ TimestampMS: 2_000, PositionX: 160, Speed: 60 });
  packets[0].Speed = 60;
  expect(classifyLapCategory(packets, "inlap", undefined, true)).toBe("in_lap");
});

test("next-lap boundary and other games cannot supply ACC reset evidence", () => {
  const packets = accPitEntry();
  expect(classifyLapCategory(packets, "inlap", packets[1], false)).toBe("in_lap");
  expect(classifyLapCategory(packets.map((packet) => ({ ...packet, gameId: "ac-evo" })), "inlap")).toBe("in_lap");
});

test.each([0, 1_792_287_555_620])("ACC captures with repeated timestamp %i use native time only within the same lap", (timestamp) => {
  const packets = accPitEntry();
  packets[0].TimestampMS = timestamp;
  packets[1].TimestampMS = timestamp;
  packets[0].LapNumber = 4;
  packets[1].LapNumber = 4;
  packets[0].CurrentLap = 10.922;
  packets[1].CurrentLap = 11.112;
  expect(classifyLapCategory(packets, "inlap", undefined, false)).toBe("reset");
  packets[1].LapNumber = 5;
  expect(classifyLapCategory(packets, "inlap", undefined, false)).toBe("in_lap");
});
