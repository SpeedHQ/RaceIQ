import { describe, expect, test } from "bun:test";
import { F1StateAccumulator } from "../../../server/games/f1-2025/f1-state";
import {
  F1_HEADER_SIZE,
  type F1Header,
} from "../../../server/games/f1-2025/f1-wire";

function header(packetId: number, sessionUIDOrOverallFrameIdentifier: bigint | number = 1): F1Header {
  const sessionUID = typeof sessionUIDOrOverallFrameIdentifier === "bigint" ? sessionUIDOrOverallFrameIdentifier : 1n;
  const overallFrameIdentifier = typeof sessionUIDOrOverallFrameIdentifier === "number" ? sessionUIDOrOverallFrameIdentifier : 1;
  return {
    packetFormat: 2025,
    gameYear: 25,
    gameMajorVersion: 1,
    gameMinorVersion: 0,
    packetVersion: 1,
    packetId,
    sessionUID,
    sessionTime: 10,
    frameIdentifier: 1,
    overallFrameIdentifier,
    playerCarIndex: 0,
    secondaryPlayerCarIndex: 255,
  };
}

function frame(data: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(F1_HEADER_SIZE), data]);
}

function sessionHistoryFrame(sectors: { s1: number; s2: number; s3: number; lapTime: number }): Buffer {
  const data = Buffer.alloc(21);
  data.writeUInt8(0, 0);
  data.writeUInt8(1, 1);
  data.writeUInt8(1, 4);
  data.writeUInt8(1, 5);
  data.writeUInt8(1, 6);
  data.writeUInt32LE(Math.round(sectors.lapTime * 1000), 7);
  data.writeUInt16LE(Math.round(sectors.s1 * 1000), 11);
  data.writeUInt16LE(Math.round(sectors.s2 * 1000), 14);
  data.writeUInt16LE(Math.round(sectors.s3 * 1000), 17);
  return frame(data);
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
    const packet = accumulator.feed(header(7, 42), frame(carStatus));

    expect(packet).not.toBeNull();
    expect(packet!.f1?.overallFrameIdentifier).toBe(42);
    expect(packet!.f1?.packetId).toBe(7);
    expect(packet!.Fuel).toBeCloseTo(0.5);
    expect(packet!.FuelCapacity).toBeCloseTo(110);
    expect(packet!.Power).toBeCloseTo(620_000);
    expect(packet!.TireTempFL).toBe(90);
    expect(packet!.TireCarcassTempFL).toBe(88);
  });

  test("marks damage unavailable until native CarDamage packet arrives", () => {
    const accumulator = new F1StateAccumulator();

    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(2), frame(Buffer.alloc(57)));
    const beforeDamage = accumulator.feed(header(6), frame(Buffer.alloc(60)));
    expect(beforeDamage?.f1?.damageAvailable).toBe(false);

    const damage = Buffer.alloc(46);
    damage.writeUInt8(25, 28);
    const afterDamage = accumulator.feed(header(10), frame(damage));
    expect(afterDamage?.f1?.damageAvailable).toBe(true);
    expect(afterDamage?.f1?.frontLeftWingDamage).toBe(25);
  });

  test("preserves player car identity and local native pit status", () => {
    const accumulator = new F1StateAccumulator();
    const playerCarIndex = 2;
    const playerHeader = (packetId: number): F1Header => ({
      ...header(packetId),
      playerCarIndex,
    });

    accumulator.feed(playerHeader(0), frame(Buffer.alloc(3 * 60)));
    accumulator.feed(playerHeader(1), frame(Buffer.alloc(9)));

    const lapData = Buffer.alloc(3 * 57);
    lapData.writeUInt8(2, playerCarIndex * 57 + 34);
    accumulator.feed(playerHeader(2), frame(lapData));

    const participants = Buffer.alloc(1 + 3 * 57);
    participants.writeUInt8(3, 0);
    accumulator.feed(playerHeader(4), frame(participants));
    const packet = accumulator.feed(
      playerHeader(6),
      frame(Buffer.alloc(3 * 60)),
    );

    expect(packet?.f1?.playerCarIndex).toBe(2);
    expect(packet?.f1?.pitStatus).toBe(2);
    expect(packet?.f1?.grid.map(({ carIndex, isPlayer }) => ({ carIndex, isPlayer }))).toEqual([
      { carIndex: 0, isPlayer: false },
      { carIndex: 1, isPlayer: false },
      { carIndex: 2, isPlayer: true },
    ]);
  });

  test("clears cached lap sectors when the session UID changes", () => {
    const accumulator = new F1StateAccumulator();
    const oldSectors = { s1: 30, s2: 31, s3: 29, lapTime: 90 };

    accumulator.feed(header(0, 1n), frame(Buffer.alloc(60)));
    accumulator.feed(header(1, 1n), frame(Buffer.alloc(9)));
    accumulator.feed(header(2, 1n), frame(Buffer.alloc(57)));
    accumulator.feed(header(6, 1n), frame(Buffer.alloc(60)));
    const oldSessionPacket = accumulator.feed(
      header(11, 1n),
      sessionHistoryFrame(oldSectors),
    );
    expect(oldSessionPacket?.f1?.lapSectors?.[1]).toEqual(oldSectors);

    accumulator.feed(header(0, 2n), frame(Buffer.alloc(60)));
    accumulator.feed(header(1, 2n), frame(Buffer.alloc(9)));
    accumulator.feed(header(2, 2n), frame(Buffer.alloc(57)));
    const newSessionPacket = accumulator.feed(
      header(6, 2n),
      frame(Buffer.alloc(60)),
    );
    expect(newSessionPacket).not.toBeNull();
    expect(newSessionPacket?.f1?.lapSectors?.[1]).toBeUndefined();

    const newSectors = { s1: 30.5, s2: 31.5, s3: 29.5, lapTime: 91.5 };
    const newHistoryPacket = accumulator.feed(
      header(11, 2n),
      sessionHistoryFrame(newSectors),
    );
    expect(newHistoryPacket?.f1?.lapSectors?.[1]).toEqual(newSectors);
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
});
