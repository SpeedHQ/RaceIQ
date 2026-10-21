import { describe, expect, test } from "bun:test";
import { F1_HEADER_SIZE, F1_NATIVE_PACKET_IDS, isF1NativePacket } from "../src/f1-2025/f1-wire";

// EA's packed F1 25 version-1 packet sizes, indexed by native packet ID.
const sizes = [1349, 753, 1285, 45, 1284, 1133, 1352, 1239, 1042, 954, 1041, 1460, 231, 273, 101, 1131];
function packet(id: number): Buffer {
  const bytes = Buffer.alloc(sizes[id]!);
  bytes.writeUInt16LE(2025);
  bytes[2] = 25;
  bytes[5] = 1;
  bytes[6] = id;
  bytes[28] = 255;
  if (id === F1_NATIVE_PACKET_IDS.EVENT) bytes.write("SSTA", F1_HEADER_SIZE, "ascii");
  return bytes;
}

describe("F1 2025 native transport validation", () => {
  test("accepts every documented native layout without changing bytes, not header-only or padded frames", () => {
    for (let id = 0; id < sizes.length; id++) {
      const bytes = packet(id), original = Buffer.from(bytes);
      expect(isF1NativePacket(bytes)).toBe(true);
      expect(bytes).toEqual(original);
      expect(isF1NativePacket(bytes.subarray(0, F1_HEADER_SIZE))).toBe(false);
      expect(isF1NativePacket(bytes.subarray(0, bytes.length - 1))).toBe(false);
      expect(isF1NativePacket(Buffer.concat([bytes, Buffer.from([0])]))).toBe(false);
    }
  });

  test("rejects unknown IDs, unsupported versions, invalid player indexes and unusable clocks", () => {
    for (const mutate of [
      (bytes: Buffer) => bytes.writeUInt16LE(2024, 0),
      (bytes: Buffer) => { bytes[2] = 24; },
      (bytes: Buffer) => { bytes[5] = 2; },
      (bytes: Buffer) => { bytes[6] = 16; },
      (bytes: Buffer) => { bytes[6] = 255; },
      (bytes: Buffer) => { bytes[27] = 22; },
      (bytes: Buffer) => { bytes[28] = 22; },
      (bytes: Buffer) => bytes.writeFloatLE(Number.NaN, 15),
      (bytes: Buffer) => bytes.writeFloatLE(Number.POSITIVE_INFINITY, 15),
      (bytes: Buffer) => bytes.writeFloatLE(-1, 15),
    ]) {
      const bytes = packet(F1_NATIVE_PACKET_IDS.EVENT);
      mutate(bytes);
      expect(isF1NativePacket(bytes)).toBe(false);
    }
    expect(isF1NativePacket(Buffer.alloc(F1_HEADER_SIZE - 1))).toBe(false);
  });

  test("rejects unknown or corrupted event codes and out-of-bounds ancillary array counts", () => {
    const event = packet(F1_NATIVE_PACKET_IDS.EVENT);
    event.write("FAKE", F1_HEADER_SIZE, "ascii");
    expect(isF1NativePacket(event)).toBe(false);
    event.write("SSTA", F1_HEADER_SIZE, "ascii");
    event[F1_HEADER_SIZE]! |= 0x80;
    expect(isF1NativePacket(event)).toBe(false);
    for (const [id, largest] of [
      [F1_NATIVE_PACKET_IDS.LOBBY_INFO, 22],
      [F1_NATIVE_PACKET_IDS.TYRE_SETS, 21],
      [F1_NATIVE_PACKET_IDS.LAP_POSITIONS, 50],
    ]) {
      const bytes = packet(id!);
      bytes[F1_HEADER_SIZE] = largest!;
      expect(isF1NativePacket(bytes)).toBe(true);
      bytes[F1_HEADER_SIZE] = largest! + 1;
      expect(isF1NativePacket(bytes)).toBe(false);
    }
  });
});
