import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { identifyGT7Track } from "@raceiq/game-gt7-metadata/tracks";
import { decryptGT7Datagram, gt7Parser } from "../src/parser";
import signatures from "../../game-gt7-metadata/src/track-signatures.json";

const packetFixture = readFileSync(new URL("./fixtures/gt7-format-c-packet.bin", import.meta.url));

function makePacket(update: (raw: Buffer) => void): Buffer {
  const encrypted = Buffer.from(packetFixture);
  const raw = decryptGT7Datagram(encrypted);
  if (!raw) throw new Error("Invalid GT7 test fixture");
  const stream = Buffer.alloc(encrypted.length);
  for (let index = 0; index < encrypted.length; index++) stream[index] = encrypted[index]! ^ raw[index]!;
  update(raw);
  if (!raw.subarray(0x40, 0x44).equals(decryptGT7Datagram(packetFixture)!.subarray(0x40, 0x44))) {
    throw new Error("Test packet update must preserve the cleartext nonce source");
  }
  const output = Buffer.alloc(raw.length);
  for (let index = 0; index < raw.length; index++) output[index] = raw[index]! ^ stream[index]!;
  return output;
}

describe("GT7 packet foundation", () => {
  it("decrypts and normalizes a supported format C packet", () => {
    const state = gt7Parser.createParserState();
    const packet = gt7Parser.tryParse(packetFixture, state, 1_000);

    expect(decryptGT7Datagram(packetFixture)?.readUInt32LE(0)).toBe(0x47375330);
    expect(packet).toMatchObject({
      gameId: "gt7",
      carId: "2184",
      trackId: "unknown",
      IsRaceOn: 1,
      LapNumber: 1,
      CurrentLap: 12.345,
      LastLap: 87,
      BestLap: 90,
      Fuel: 42,
      FuelCapacity: 100,
      Speed: 15.5,
      PositionX: -10.5,
      PositionY: 1.25,
      PositionZ: 20.75,
      Gear: 2,
      gt7: { sessionType: "time-trial", suggestedGear: 1 },
    });
  });

  it("rejects datagrams without valid GT7 packet magic", () => {
    const invalid = Buffer.from(packetFixture);
    invalid[0]! ^= 0xff;

    expect(decryptGT7Datagram(invalid)).toBeNull();
    expect(gt7Parser.canHandle(invalid)).toBe(false);
  });

  it("normalizes GT7's no-lap sentinel to lap zero", () => {
    const packet = gt7Parser.tryParse(makePacket((raw) => raw.writeUInt16LE(0xffff, 0x74)), gt7Parser.createParserState(), 1_000);

    expect(packet?.LapNumber).toBe(0);
  });

  it("falls back to elapsed time when the native lap time is outside its valid range", () => {
    const state = gt7Parser.createParserState();
    gt7Parser.tryParse(packetFixture, state, 1_000);
    const packet = gt7Parser.tryParse(makePacket((raw) => raw.writeInt32LE(3_600_001, 0x15c)), state, 3_000);

    expect(packet?.CurrentLap).toBe(2);
  });
});

describe("GT7 track matching", () => {
  it("keeps a high-confidence spatial match when integrated lap distance is skewed", () => {
    const track = signatures.signatures.find((signature) => signature.name === "Deep Forest Raceway");
    if (!track?.path) throw new Error("Deep Forest reference signature missing");

    expect(identifyGT7Track({
      lengthM: track.lengthM * 1.08,
      minX: track.minX,
      maxX: track.maxX,
      minZ: track.minZ,
      maxZ: track.maxZ,
      points: track.path.slice(0, 80).map(([x, z]) => [x, z] as const),
    })).toBe(track.id);
  });
});
