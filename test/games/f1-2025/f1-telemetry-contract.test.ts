import { describe, expect, test } from "bun:test";
import { F1StateAccumulator } from "../../../server/games/f1-2025/f1-state";
import { initGameAdapters } from "@shared/games/init";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import type { TelemetryPacket } from "@shared/telemetry/types";
import {
  F1_HEADER_SIZE,
  type F1Header,
} from "../../../server/games/f1-2025/f1-wire";

function header(packetId: number): F1Header {
  return {
    packetFormat: 2025,
    gameYear: 25,
    gameMajorVersion: 1,
    gameMinorVersion: 0,
    packetVersion: 1,
    packetId,
    sessionUID: 1n,
    sessionTime: 10,
    frameIdentifier: 1,
    overallFrameIdentifier: 1,
    playerCarIndex: 0,
    secondaryPlayerCarIndex: 255,
  };
}

function frame(data: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(F1_HEADER_SIZE), data]);
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

  test("real multi-packet snapshots support sustained DRS and ERS observations", () => {
    initGameAdapters();
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
      const insights = analyzeLap(packets, "f1-2025");
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
});
