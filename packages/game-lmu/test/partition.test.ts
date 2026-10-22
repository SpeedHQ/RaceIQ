import { describe, expect, test } from "bun:test";
import {
  LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET,
  LMU_TELEMETRY_INFO_SIZE, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO,
  LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLE,
} from "@raceiq/capture-formats/lmu/layout";
import { decodeLMUSourceFrame, encodeLMUSourceFrame, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { partitionLMUSourceFrame, restoreLMUSourceFrame, getLMUPartitionSourceLength, getLMUPartitionKey } from "@raceiq/capture-formats/lmu/partition";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import type { LmuLiveContext } from "@raceiq/shared/telemetry/lmu";

function original(sequence = 1, slot = 0): Buffer {
  const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  memory.writeUInt8(2, LMU_TELEMETRY_HEADER_OFFSET);
  memory.writeUInt8(slot, LMU_TELEMETRY_HEADER_OFFSET + 1);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
  memory.writeInt32LE(2, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  memory.writeDoubleLE(sequence, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
  for (let index = 0; index < 2; index++) {
    const telemetry = LMU_TELEMETRY_INFO_OFFSET + index * LMU_TELEMETRY_INFO_SIZE;
    const scoring = LMU_SCORING_VEHICLES_OFFSET + index * LMU_SCORING_VEHICLE_SIZE;
    memory.writeInt32LE(index === slot ? 42 : 77, telemetry + LMU_TELEMETRY.id);
    memory.writeDoubleLE(sequence, telemetry + LMU_TELEMETRY.elapsedTime);
    memory.writeDoubleLE(index === slot ? 61 : 83, telemetry + LMU_TELEMETRY.localVelocity);
    memory.writeInt32LE(index === slot ? 42 : 77, scoring + LMU_SCORING_VEHICLE.id);
    memory.writeUInt8(index === slot ? 1 : 0, scoring + LMU_SCORING_VEHICLE.isPlayer);
    Buffer.from(index === slot ? "Player" : "OPPONENT-PRIVATE-MARKER").copy(memory, scoring + LMU_SCORING_VEHICLE.driverName);
  }
  const scoringStream = LMU_SCORING_VEHICLES_OFFSET + 104 * LMU_SCORING_VEHICLE_SIZE;
  Buffer.from("OPPONENT-RESULT-STREAM").copy(memory, scoringStream);
  const context: LmuLiveContext = {
    schemaVersion: 1, status: "active", playerVehicleId: 42,
    key: { sessionKey: "partition-test", captureSequence: String(sequence), frameTime: { domain: "session", milliseconds: sequence * 1000 } },
    supplemental: [], competitors: [
      { vehicleId: 42, incarnation: 0, isPlayer: true, channels: {} },
      { vehicleId: 77, incarnation: 1, isPlayer: false, channels: {} },
    ],
  };
  const frame = encodeLMUSourceFrame(memory, 1700000000000 + sequence, { context });
  if (!frame) throw new Error("Invalid controlled native fixture");
  return frame;
}

function pair(frame: Buffer) {
  const result = partitionLMUSourceFrame(frame);
  if (!result?.companion) throw new Error("Expected retained partition pair");
  return { primary: result.primary, companion: result.companion };
}

function sparseRoundtrip(frames: readonly Buffer[]): Buffer[] {
  const encoder = new SparseCaptureEncoder("lmu");
  const bytes: Buffer[] = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
  let offset = bytes.reduce((sum, part) => sum + part.length, 0);
  for (const frame of frames) {
    const payload = encoder.encode(frame, offset);
    const prefix = encodeFrameLength(payload.length, 1700000000000 + offset);
    bytes.push(prefix, payload);
    offset += prefix.length + payload.length;
  }
  return [...iterateSessionCaptureRecords(Buffer.concat(bytes), 0, { strict: true })]
    .flatMap((record) => record.kind === "frame" ? [record.frame] : []);
}

describe("LMU player/opponent source partition", () => {
  test("retains exact source bytes once while primary independently exposes only player context", () => {
    for (const slot of [0, 1]) {
      const source = original(1, slot);
      const { primary, companion } = pair(source);
      expect(restoreLMUSourceFrame(primary, companion)).toEqual(source);
      expect(getLMUPartitionSourceLength(primary)).toBe(source.length);
      expect(getLMUPartitionKey(primary)).toBe(getLMUPartitionKey(companion));
      expect(primary.includes(Buffer.from("OPPONENT-PRIVATE-MARKER"))).toBe(false);
      expect(primary.includes(Buffer.from("OPPONENT-RESULT-STREAM"))).toBe(false);
      const decoded = decodeLMUSourceFrame(primary)!;
      expect(decoded.schemaVersion).toBe(5);
      expect(decoded.telemetry.readInt32LE(LMU_TELEMETRY.id)).toBe(42);
      expect(decoded.telemetry.readDoubleLE(LMU_TELEMETRY.localVelocity)).toBe(61);
      expect(decoded.lmuContext?.competitors).toBeUndefined();
      expect(decoded.lmuContext?.key.captureSequence).toBe("1");
      expect(decoded.rawSharedMemory).toBeUndefined();
    }
  });

  test("preserves legacy v2 and arbitrary valid context property order/whitespace", () => {
    const source = original();
    const v2 = Buffer.from(source.subarray(0, LMU_SOURCE_FRAME_V2_SIZE));
    v2.writeUInt16LE(2, 8);
    const legacy = pair(v2);
    expect(restoreLMUSourceFrame(legacy.primary, legacy.companion)).toEqual(v2);
    const parsed = JSON.parse(source.subarray(LMU_SOURCE_FRAME_V2_SIZE + 4).toString("utf8"));
    const { competitors, ...rest } = parsed;
    for (const value of [{ competitors, ...rest }, { ...rest, competitors }]) {
      const json = Buffer.from(JSON.stringify(value, null, 2));
      const reordered = Buffer.concat([source.subarray(0, LMU_SOURCE_FRAME_V2_SIZE), Buffer.alloc(4), json]);
      reordered.writeUInt32LE(json.length, LMU_SOURCE_FRAME_V2_SIZE);
      const split = pair(reordered);
      expect(restoreLMUSourceFrame(split.primary, split.companion)).toEqual(reordered);
      expect(decodeLMUSourceFrame(split.primary)?.lmuContext?.competitors).toBeUndefined();
    }
  });

  test("rejects mismatched, truncated and overlapping companion payloads", () => {
    const first = pair(original(1));
    const second = pair(original(2));
    expect(() => restoreLMUSourceFrame(first.primary, second.companion)).toThrow();
    expect(() => restoreLMUSourceFrame(first.primary, first.companion.subarray(0, -1))).toThrow();
    const overlapping = Buffer.from(first.companion);
    overlapping.writeUInt32LE(28, 80);
    expect(() => restoreLMUSourceFrame(first.primary, overlapping)).toThrow();
    const corrupt = Buffer.from(first.companion);
    corrupt[corrupt.length - 1] ^= 1;
    expect(() => restoreLMUSourceFrame(first.primary, corrupt)).toThrow();
  });

  test("sparse primary and companion streams roundtrip variable metadata and slot changes", () => {
    const sources = [original(1), original(2), original(100), original(101, 1)];
    const pairs = sources.map(pair);
    const primaries = sparseRoundtrip(pairs.map((item) => item.primary));
    const companions = sparseRoundtrip(pairs.map((item) => item.companion));
    expect(primaries).toEqual(pairs.map((item) => item.primary));
    expect(companions).toEqual(pairs.map((item) => item.companion));
    for (let index = 0; index < sources.length; index++) expect(restoreLMUSourceFrame(primaries[index]!, companions[index]!)).toEqual(sources[index]);
  });
});
