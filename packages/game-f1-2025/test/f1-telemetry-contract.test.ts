import { registerGame } from "@raceiq/shared/games/registry";
import { f1ServerAdapter } from "../src/index";
import { describe, expect, test } from "bun:test";
import { F1StateAccumulator } from "../src/f1-state";
import { f1Parser } from "../src/game-parser";
import { analyzeLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/analyze";
import { processLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/process";
import { classifyLapCategory } from "@raceiq/analysis-core/racing/laps/classification";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import {
  F1_HEADER_SIZE,
  F1_PACKET_IDS,
  type F1Header,
} from "@raceiq/capture-formats/f1-2025/f1-wire";

function header(packetId: number, sessionTime = 10, sessionUID = 1n): F1Header {
  return {
    packetFormat: 2025,
    gameYear: 25,
    gameMajorVersion: 1,
    gameMinorVersion: 0,
    packetVersion: 1,
    packetId,
    sessionUID,
    sessionTime,
    frameIdentifier: 1,
    overallFrameIdentifier: 1,
    playerCarIndex: 0,
    secondaryPlayerCarIndex: 255,
  };
}

function frame(data: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(F1_HEADER_SIZE), data]);
}

function nativePacket(packetHeader: F1Header, data: Buffer): Buffer {
  const packet = frame(data);
  packet.writeUInt16LE(packetHeader.packetFormat, 0);
  packet.writeUInt8(packetHeader.gameYear, 2);
  packet.writeUInt8(packetHeader.gameMajorVersion, 3);
  packet.writeUInt8(packetHeader.gameMinorVersion, 4);
  packet.writeUInt8(packetHeader.packetVersion, 5);
  packet.writeUInt8(packetHeader.packetId, 6);
  packet.writeBigUInt64LE(packetHeader.sessionUID, 7);
  packet.writeFloatLE(packetHeader.sessionTime, 15);
  packet.writeUInt32LE(packetHeader.frameIdentifier, 19);
  packet.writeUInt32LE(packetHeader.overallFrameIdentifier, 23);
  packet.writeUInt8(packetHeader.playerCarIndex, 27);
  packet.writeUInt8(packetHeader.secondaryPlayerCarIndex, 28);
  return packet;
}

function nativeAccumulator(sessionTime = 0, sessionUID = 1n): F1StateAccumulator {
  const state = f1Parser.createParserState();
  const session = Buffer.alloc(9);
  session.writeUInt8(1, 6);
  for (const [id, bytes] of [
    [F1_PACKET_IDS.MOTION, Buffer.alloc(60)],
    [F1_PACKET_IDS.SESSION, session],
    [F1_PACKET_IDS.LAP_DATA, Buffer.alloc(57)],
    [F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60)],
  ] as const) {
    f1Parser.tryParse(nativePacket(header(id, sessionTime, sessionUID), bytes), state);
  }
  return state;
}

function parseNative(
  state: F1StateAccumulator,
  packetId: number,
  data: Buffer,
  sessionTime: number,
  sessionUID = 1n,
): TelemetryPacket | null {
  return f1Parser.tryParse(nativePacket(header(packetId, sessionTime, sessionUID), data), state);
}
describe("F1 telemetry contract", () => {
  test("normalizes fuel to a fraction and preserves power in watts", () => {
    const accumulator = new F1StateAccumulator();

    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(2), frame(Buffer.alloc(57)));

    const carTelemetry = Buffer.alloc(60);
    carTelemetry.writeUInt8(90, 32);
    carTelemetry.writeUInt8(88, 36);
    accumulator.feed(header(6), frame(carTelemetry));

    const carStatus = Buffer.alloc(55);
    carStatus.writeFloatLE(55, 5);
    carStatus.writeFloatLE(110, 9);
    carStatus.writeFloatLE(500_000, 29);
    carStatus.writeFloatLE(120_000, 33);
    const packet = accumulator.feed(header(7), frame(carStatus));

    expect(packet).not.toBeNull();
    expect(packet!.Fuel).toBeCloseTo(0.5);
    expect(packet!.FuelCapacity).toBeCloseTo(110);
    expect(packet!.Power).toBeCloseTo(620_000);
    expect(packet!.TireTempFL).toBe(90);
    expect(packet!.TireCarcassTempFL).toBe(88);
  });

  test("reads player's raw lap-invalid flag into emitted telemetry", () => {
    const accumulator = new F1StateAccumulator();
    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(6), frame(Buffer.alloc(60)));
    const lapData = Buffer.alloc(57);
    for (const raw of [0, 1] as const) {
      lapData.writeUInt8(raw, 37);
      const packet = accumulator.feed(header(2), frame(lapData));
      expect(packet?.f1?.currentLapInvalid).toBe(raw);
    }
  });

  test("real multi-packet snapshots support sustained DRS and ERS observations", () => {
    registerGame(f1ServerAdapter);
    for (const drsActive of [false, true]) {
      const accumulator = new F1StateAccumulator();
      const motion = Buffer.alloc(60);
      accumulator.feed({ ...header(0), sessionTime: 0 }, frame(motion));
      accumulator.feed({ ...header(1), sessionTime: 0 }, frame(Buffer.alloc(9)));
      accumulator.feed({ ...header(2), sessionTime: 0 }, frame(Buffer.alloc(57)));
      accumulator.feed({ ...header(10), sessionTime: 0 }, frame(Buffer.alloc(46)));
      const telemetry = Buffer.alloc(60);
      telemetry.writeUInt16LE(216, 0);
      telemetry.writeFloatLE(1, 2);
      telemetry.writeInt8(6, 15);
      telemetry.writeUInt16LE(10_000, 16);
      telemetry.writeUInt8(drsActive ? 1 : 0, 18);
      const status = Buffer.alloc(55);
      status.writeUInt16LE(15_000, 17);
      status.writeFloatLE(50, 5);
      status.writeFloatLE(100, 9);
      status.writeInt8(1, 28);
      status.writeUInt8(2, 41);
      const packets: TelemetryPacket[] = [];
      for (let tick = 0; tick <= 80; tick++) {
        const time = tick / 20;
        status.writeUInt8(time >= 0.2 ? 1 : 0, 22);
        status.writeFloatLE(10 - time * 0.01, 13);
        status.writeFloatLE(Math.max(0, 100_000 * (1 - time)), 37);
        status.writeFloatLE(100_000 * Math.min(time, 1), 50);
        status.writeFloatLE(time >= 1 ? 1_000 : 120_000, 33);
        for (const [packetId, data] of [[6, telemetry], [7, status], [0, motion]] as const) {
          const packet = accumulator.feed({ ...header(packetId), sessionTime: time }, frame(data));
          if (packet) packets.push(packet);
        }
      }
      const insights = analyzeLap(processLap(packets, "f1-2025").packets, "f1-2025");
      expect(insights.some((insight) => insight.id === "driving-unused-drs")).toBe(!drsActive);
      expect(insights.some((insight) => insight.id === "mech-ers-depletion")).toBe(true);
    }
  });

  test("preserves authoritative final classification packet", () => {
    const accumulator = new F1StateAccumulator();
    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(2), frame(Buffer.alloc(57)));
    accumulator.feed(header(6), frame(Buffer.alloc(60)));

    const finalClassification = Buffer.alloc(1 + 22 * 46);
    finalClassification.writeUInt8(1, 0);
    finalClassification.writeUInt8(2, 1);
    finalClassification.writeUInt8(5, 3);
    finalClassification.writeUInt8(5, 6);
    finalClassification.writeUInt8(6, 7);
    finalClassification.writeUInt32LE(90_123, 8);
    const packet = accumulator.feed(header(8), frame(finalClassification));

    expect(packet?.RacePosition).toBe(2);
    expect(packet?.BestLap).toBeCloseTo(90.123);
    expect(packet?.f1?.gridPosition).toBe(5);
    expect(packet?.f1?.resultStatus).toBe(5);
    expect(packet?.f1?.resultReason).toBe(6);
    expect(packet?.f1?.resultSource).toBe("final-classification");
  });
  test("primes parser state without emitting a packet", () => {
    const accumulator = new F1StateAccumulator();
    const motion = frame(Buffer.alloc(60));
    const session = frame(Buffer.alloc(9));
    const lapData = frame(Buffer.alloc(57));
    accumulator.primeParserState(header(0), motion);
    accumulator.primeParserState(header(1), session);
    accumulator.primeParserState(header(2), lapData);
    expect(accumulator.feed(header(6), frame(Buffer.alloc(60)))).not.toBeNull();
  });
  // F1 25 UDP v3 semantics: FIA flag 3 is yellow; SafetyCar 1/2 are SC/VSC and 3 is formation (ADR0011).
  test("native FIA flags and safety-car status distinguish yellow, non-yellow, and formation", () => {
    const state = nativeAccumulator();
    const lapPackets: TelemetryPacket[] = [];
    for (const [time, flag] of [[1, 3], [2, 2], [3, 0]] as const) {
      const status = Buffer.alloc(55);
      status.writeInt8(flag, 28);
      const packet = parseNative(state, F1_PACKET_IDS.CAR_STATUS, status, time);
      if (packet) lapPackets.push(packet);
    }
    expect(lapPackets[0]?.f1?.vehicleFIAFlags).toBe(3);
    expect(classifyLapCategory(lapPackets, null, undefined, true)).toBe("caution");
    const freshSession = Buffer.alloc(125);
    freshSession.writeUInt8(1, 6);
    freshSession.writeUInt8(0, 124);
    const fresh = parseNative(state, F1_PACKET_IDS.SESSION, freshSession, 3)!;
    const clearLapPackets = [lapPackets[1]!, fresh];
    expect(classifyLapCategory(clearLapPackets, null, undefined, true)).toBe("pace");

    for (const [statusValue, expected] of [[1, "caution"], [2, "caution"], [3, null]] as const) {
      const stateForStatus = nativeAccumulator();
      const session = Buffer.alloc(125);
      session.writeUInt8(1, 6);
      session.writeUInt8(statusValue, 124);
      const first = parseNative(stateForStatus, F1_PACKET_IDS.SESSION, session, 1)!;
      const clearFlags = Buffer.alloc(55);
      const firstWithClearFlags = parseNative(stateForStatus, F1_PACKET_IDS.CAR_STATUS, clearFlags, 1)!;
      const later = parseNative(stateForStatus, F1_PACKET_IDS.SESSION, session, 2)!;
      expect(first.f1?.safetyCarStatus).toBe(statusValue);
      expect(classifyLapCategory([firstWithClearFlags, later], null, undefined, true)).toBe(expected);
    }

    const absentState = nativeAccumulator();
    const withoutEvidence = parseNative(absentState, F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60), 20)!;
    expect(withoutEvidence.f1?.vehicleFIAFlags).toBeUndefined();
    expect(withoutEvidence.f1?.vehicleFIAFlagsUpdatedAt).toBeUndefined();
    expect(withoutEvidence.f1?.safetyCarStatusUpdatedAt).toBe(0);
    expect(classifyLapCategory([withoutEvidence], null, undefined, true)).toBeNull();
  });

  test("a transient native yellow remains attributable to its lap after green", () => {
    const state = nativeAccumulator();
    const yellowStatus = Buffer.alloc(55);
    yellowStatus.writeInt8(3, 28);
    const yellow = parseNative(state, F1_PACKET_IDS.CAR_STATUS, yellowStatus, 10)!;
    const greenStatus = Buffer.alloc(55);
    greenStatus.writeInt8(0, 28);
    const green = parseNative(state, F1_PACKET_IDS.CAR_STATUS, greenStatus, 11)!;
    const greenSession = Buffer.alloc(125);
    greenSession.writeUInt8(1, 6);
    greenSession.writeUInt8(0, 124);
    const refreshedGreen = parseNative(state, F1_PACKET_IDS.SESSION, greenSession, 11)!;
    expect(refreshedGreen.f1?.vehicleFIAFlags).toBe(0);
    expect(refreshedGreen.f1?.vehicleFIAFlagsUpdatedAt).toBe(11);
    expect(classifyLapCategory([yellow, green], null, undefined, true)).toBe("caution");
    expect(classifyLapCategory([green, refreshedGreen], null, undefined, true)).toBe("pace");
    const nextLapStatus = parseNative(state, F1_PACKET_IDS.CAR_STATUS, greenStatus, 12)!;
    const nextLapSessionData = Buffer.alloc(125);
    nextLapSessionData.writeUInt8(1, 6);
    nextLapSessionData.writeUInt8(0, 124);
    const nextLapSession = parseNative(state, F1_PACKET_IDS.SESSION, nextLapSessionData, 12)!;
    expect(classifyLapCategory([nextLapStatus, nextLapSession], null, undefined, true)).toBe("pace");
  });

  test("standing start requires native STLG then LGOT and resets across state boundaries", () => {
    const state = nativeAccumulator(1);
    const event = (code: string, lights?: number) => {
      const data = Buffer.alloc(lights === undefined ? 4 : 5);
      data.write(code, 0, 4, "ascii");
      if (lights !== undefined) data.writeUInt8(lights, 4);
      return data;
    };
    const withoutLights = parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 2)!;
    expect(withoutLights.f1?.raceStartAt).toBeUndefined();
    const clearStatus = Buffer.alloc(55);
    const noStartFlag = parseNative(state, F1_PACKET_IDS.CAR_STATUS, clearStatus, 2)!;
    const clearSession = Buffer.alloc(125);
    clearSession.writeUInt8(1, 6);
    const noStartSession = parseNative(state, F1_PACKET_IDS.SESSION, clearSession, 2)!;
    const noStartLap = [noStartFlag, noStartSession];
    expect(classifyLapCategory(noStartLap, null, undefined, true)).toBe("pace");
    parseNative(state, F1_PACKET_IDS.EVENT, event("STLG", 5), 3);
    const afterLights = parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 4)!;
    expect(afterLights.f1?.raceStartAt).toBe(4);
    expect(classifyLapCategory([afterLights], null, undefined, true)).toBe("grid_start");

    parseNative(state, F1_PACKET_IDS.EVENT, event("STLG", 5), 5);
    const nextSession = Buffer.alloc(9);
    nextSession.writeUInt8(1, 6);
    for (const [packetId, data] of [
      [F1_PACKET_IDS.MOTION, Buffer.alloc(60)],
      [F1_PACKET_IDS.SESSION, nextSession],
      [F1_PACKET_IDS.LAP_DATA, Buffer.alloc(57)],
      [F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60)],
    ] as const) {
      parseNative(state, packetId, data, 5.5, 2n);
    }
    const unknownSession = parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 6, 2n)!;
    expect(unknownSession.f1?.raceStartAt).toBeUndefined();

    const rewound = nativeAccumulator(10);
    parseNative(rewound, F1_PACKET_IDS.EVENT, event("STLG", 5), 11);
    const rewindPacket = parseNative(rewound, F1_PACKET_IDS.EVENT, event("LGOT"), 1)!;
    expect(rewindPacket.f1?.raceStartAt).toBeUndefined();
    const reset = nativeAccumulator(1);
    parseNative(reset, F1_PACKET_IDS.EVENT, event("STLG", 5), 2);
    reset.reset();
    const resetSession = Buffer.alloc(9);
    resetSession.writeUInt8(1, 6);
    for (const [packetId, data] of [
      [F1_PACKET_IDS.MOTION, Buffer.alloc(60)],
      [F1_PACKET_IDS.SESSION, resetSession],
      [F1_PACKET_IDS.LAP_DATA, Buffer.alloc(57)],
      [F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60)],
    ] as const) {
      parseNative(reset, packetId, data, 3);
    }
    const resetLightsOut = parseNative(reset, F1_PACKET_IDS.EVENT, event("LGOT"), 4)!;
    expect(resetLightsOut.f1?.raceStartAt).toBeUndefined();
  });
  test("lights-out at time zero classifies lap one, not later laps", () => {
    const state = nativeAccumulator();
    const event = (code: string, lights?: number) => {
      const data = Buffer.alloc(lights === undefined ? 4 : 5);
      data.write(code, 0, 4, "ascii");
      if (lights !== undefined) data.writeUInt8(lights, 4);
      return data;
    };
    parseNative(state, F1_PACKET_IDS.EVENT, event("STLG", 5), 0);
    parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 0);

    const firstLapData = Buffer.alloc(57);
    firstLapData.writeUInt8(1, 33);
    const firstLap = parseNative(state, F1_PACKET_IDS.LAP_DATA, firstLapData, 0.342)!;
    expect(firstLap.f1?.raceStartAt).toBe(0);
    expect(firstLap.LapNumber).toBe(1);
    expect(classifyLapCategory([firstLap], null, undefined, true)).toBe("grid_start");

    const clearStatus = parseNative(
      state,
      F1_PACKET_IDS.CAR_STATUS,
      Buffer.alloc(55),
      90,
    )!;
    const clearSessionData = Buffer.alloc(125);
    clearSessionData.writeUInt8(1, 6);
    const clearSession = parseNative(state, F1_PACKET_IDS.SESSION, clearSessionData, 90)!;
    expect(clearStatus.f1?.vehicleFIAFlagsUpdatedAt).toBe(90);
    expect(clearSession.f1?.safetyCarStatusUpdatedAt).toBe(90);
    const secondLapData = Buffer.alloc(57);
    secondLapData.writeUInt8(2, 33);
    const secondLap = parseNative(state, F1_PACKET_IDS.LAP_DATA, secondLapData, 90)!;
    expect(secondLap.f1?.raceStartAt).toBe(0);
    expect(secondLap.LapNumber).toBe(2);
    expect(secondLap.f1?.vehicleFIAFlagsUpdatedAt).toBe(90);
    expect(secondLap.f1?.safetyCarStatusUpdatedAt).toBe(90);
    expect(classifyLapCategory([secondLap], null, undefined, true)).toBe("pace");
  });
});
