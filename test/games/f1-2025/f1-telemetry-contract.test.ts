import { describe, expect, test } from "bun:test";
import { buildTelemetryCatalog } from "../../../scripts/catalog/builder";
import { F1StateAccumulator } from "../../../server/games/f1-2025/f1-state";
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
  test("maps blistering and competitor pit extensions to canonical semantics", async () => {
    const catalog = await buildTelemetryCatalog();
    const blistering = catalog.variables.find((variable) => variable.id === "tires.blistering");

    expect(blistering).toMatchObject({
      canonicalUnit: "%",
      shape: "per-wheel",
      cardinality: { kind: "fixed", count: 4 },
      ordering: ["FL", "FR", "RL", "RR"],
      games: {
        "f1-2025": {
          kind: "direct",
          nativeUnit: "%",
          sources: {
            FL: ["f1.tyreBlistersFL"],
            FR: ["f1.tyreBlistersFR"],
            RL: ["f1.tyreBlistersRL"],
            RR: ["f1.tyreBlistersRR"],
          },
        },
      },
    });
    expect(
      catalog.variables.find((variable) => variable.id === "race.competitor.pit-status"),
    ).toMatchObject({
      canonicalUnit: "enum",
      shape: "structured",
      games: {
        "f1-2025": {
          kind: "normalized",
          nativeUnit: "enum",
          sources: ["f1.grid[].pitStatus"],
        },
      },
    });
    expect(
      catalog.variables.find((variable) => variable.id === "race.competitor.on-pit-road"),
    ).toMatchObject({
      canonicalUnit: "boolean",
      shape: "structured",
      games: {
        "f1-2025": {
          kind: "normalized",
          nativeUnit: "boolean",
          sources: ["f1.grid[].onPitRoad"],
        },
      },
    });
  });

  test("preserves blister wheel order and normalizes competitor pit state", () => {
    const accumulator = new F1StateAccumulator();
    const participants = Buffer.alloc(1 + 3 * 57);
    const lapData = Buffer.alloc(3 * 57);

    participants.writeUInt8(3, 0);
    ["Leader", "Pitting", "Pit Area"].forEach((name, index) => {
      const offset = 1 + index * 57;
      participants.writeUInt8(index + 1, offset + 1);
      participants.writeUInt8(index + 2, offset + 3);
      participants.write(name, offset + 7, "utf8");
    });
    [0, 1, 2].forEach((pitStatus, index) => {
      const offset = index * 57;
      lapData.writeUInt8(index + 1, offset + 32);
      lapData.writeUInt8(pitStatus, offset + 34);
      lapData.writeFloatLE(3_000 - index * 100, offset + 24);
    });

    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(4), frame(participants));
    accumulator.feed(header(6), frame(Buffer.alloc(60)));
    accumulator.feed(header(2), frame(lapData));

    const carDamage = Buffer.alloc(46);
    carDamage.writeUInt8(33, 24);
    carDamage.writeUInt8(44, 25);
    carDamage.writeUInt8(11, 26);
    carDamage.writeUInt8(22, 27);
    const packet = accumulator.feed(header(10), frame(carDamage));

    expect(packet).not.toBeNull();
    expect([
      packet!.f1?.tyreBlistersFL,
      packet!.f1?.tyreBlistersFR,
      packet!.f1?.tyreBlistersRL,
      packet!.f1?.tyreBlistersRR,
    ]).toEqual([11, 22, 33, 44]);
    expect(packet!.f1?.grid.map((entry) => entry.pitStatus)).toEqual([
      "none",
      "pitting",
      "in-pit-area",
    ]);
    expect(packet!.f1?.grid.map((entry) => entry.onPitRoad)).toEqual([
      false,
      true,
      true,
    ]);
  });

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
