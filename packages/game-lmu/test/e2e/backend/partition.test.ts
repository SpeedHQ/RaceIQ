import { describe, expect, test } from "bun:test";
import {
  LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET,
  LMU_TELEMETRY_INFO_SIZE, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO,
  LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLE,
} from "@raceiq/capture-formats/lmu/layout";
import { createLMUSourceFrameDecoder, decodeLMUSourceFrame, encodeLMUSourceFrame, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { partitionLMUSourceFrame, restoreLMUSourceFrame, getLMUPartitionSourceLength, getLMUPartitionKey } from "@raceiq/capture-formats/lmu/partition";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import type { LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import { createLmuContextEncoder, decodeLmuContext, encodeLmuContext } from "@raceiq/shared/telemetry/lmu-context";
import { lmuParser } from "@raceiq/game-lmu/game-parser";

function withContextJson(source: Buffer, json: string): Buffer {
  const bytes = Buffer.from(json);
  const frame = Buffer.concat([source.subarray(0, LMU_SOURCE_FRAME_V2_SIZE), Buffer.alloc(4), bytes]);
  frame.writeUInt32LE(bytes.length, LMU_SOURCE_FRAME_V2_SIZE);
  return frame;
}

function cachedContext(sequence: string, value = 1): LmuLiveContext {
  return {
    schemaVersion: 1, status: "active", playerVehicleId: 42,
    key: { sessionKey: "cache-test", captureSequence: sequence, frameTime: { domain: "monotonic", nanoseconds: 9007199254740993123n + BigInt(sequence) } },
    supplemental: [{
      semanticId: "lmu.rest.session.time-scale", endpoint: "/rest/sessions", method: "GET",
      sessionKey: "cache-test", vehicleId: null, applicability: "session",
      acquiredAt: { domain: "monotonic", nanoseconds: 9007199254740993123n }, responseVersion: null,
      observation: {
        semanticId: "lmu.rest.session.time-scale", value, unit: "ratio", mappingStatus: "direct", state: "ok",
        confidence: null, freshness: "fresh", confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 },
        provenance: {
          simulator: "lmu", parserId: "cache-test", parserVersion: "1", resolverVersion: "1", catalogVersion: "1", catalogHash: "hash",
          observedAt: { domain: "monotonic", nanoseconds: 9007199254740993123n },
          sourceObservation: { timestamp: { domain: "monotonic", nanoseconds: 9007199254740993123n }, updateSequence: 9007199254740993124n },
        },
        schemaVersion: "1", limitations: ["Escaped quote: \" and braces: } ]"],
      },
    }],
  };
}

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

  test("cached native and projected decoders preserve every key and changed observation byte", () => {
    const source = original();
    for (const projected of [false, true]) {
      const decoder = createLMUSourceFrameDecoder();
      const frame = (sequence: string, value = 1) => {
        const native = withContextJson(source, JSON.stringify(encodeLmuContext(cachedContext(sequence, value))));
        return projected ? pair(native).primary : native;
      };
      const firstFrame = frame("9");
      const first = decoder.decode(firstFrame)!.lmuContext!;
      firstFrame.fill(0); // The cache must own its comparison bytes, not retain caller storage.
      const second = decoder.decode(frame("100"))!.lmuContext!;
      expect(second).toEqual(cachedContext("100"));
      expect(second.supplemental).toBe(first.supplemental);
      expect(second.key).not.toBe(first.key);
      expect(Reflect.set(first.supplemental[0]!.observation, "value", 99)).toBe(false);
      expect(Reflect.set(first.supplemental[0]!.observation.provenance.sourceObservation!, "updateSequence", 0n)).toBe(false);
      const changed = decoder.decode(frame("101", 2))!.lmuContext!;
      expect(changed.supplemental[0]!.acquiredAt).toEqual(first.supplemental[0]!.acquiredAt);
      expect(changed.supplemental[0]!.observation.value).toBe(2);
      expect(changed.supplemental).not.toBe(first.supplemental);
      decoder.reset();
      expect(decoder.decode(frame("101", 2))!.lmuContext).toEqual(changed);
    }
  });

  test("cached keys preserve arbitrary order, escapes, session transitions and JSON.parse duplicate semantics", () => {
    const source = original();
    const decoder = createLMUSourceFrameDecoder();
    const json = (sequence: string) => {
      const { key, ...rest } = encodeLmuContext(cachedContext(sequence));
      return JSON.stringify({ ...rest, key }).replace('"key":', '"\\u006bey":');
    };
    const first = decoder.decode(withContextJson(source, json("9")))!.lmuContext!;
    const second = decoder.decode(withContextJson(source, json("100")))!.lmuContext!;
    expect(second.supplemental).toBe(first.supplemental);
    expect(second).toEqual(cachedContext("100"));
    const duplicate = json("101").replace("{", '{"key":null,');
    const duplicateFirst = decoder.decode(withContextJson(source, duplicate))!.lmuContext!;
    const duplicateNext = decoder.decode(withContextJson(source, duplicate))!.lmuContext!;
    expect(duplicateNext).toEqual(duplicateFirst);
    expect(duplicateNext.supplemental).not.toBe(duplicateFirst.supplemental);
    decoder.decode(withContextJson(source, json("100")));
    const badSession = json("101").replace('"sessionKey":"cache-test","captureSequence"', '"sessionKey":"other","captureSequence"');
    expect(decoder.decode(withContextJson(source, badSession))).toBeNull();
    const nextSession = json("102").replaceAll("cache-test", "next-session");
    expect(decoder.decode(withContextJson(source, nextSession))!.lmuContext!.key.sessionKey).toBe("next-session");
    const empty = JSON.stringify(encodeLmuContext({ ...cachedContext("1"), supplemental: [] }));
    const emptyFirst = decoder.decode(withContextJson(source, empty))!.lmuContext!;
    const emptyNext = decoder.decode(withContextJson(source, empty.replace("cache-test", "empty-next-session")))!.lmuContext!;
    expect(emptyNext.key.sessionKey).toBe("empty-next-session");
    expect(emptyNext.supplemental).toBe(emptyFirst.supplemental);
  });

  test("malformed keys and changed context bytes reject without stale cached fallback", () => {
    const source = original();
    const decoder = createLMUSourceFrameDecoder();
    const valid = JSON.stringify(encodeLmuContext(cachedContext("1")));
    for (const malformed of [
      valid.replace('"captureSequence":"1"', '"captureSequence":"-1"'),
      valid.replace('"captureSequence":"1"', '"captureSequence":"1",'),
      valid.replace('"nanoseconds":"9007199254740993124"', '"nanoseconds":"1.5"'),
      valid.replace('"value":1', '"value":"wrong"'),
      valid.slice(0, -1),
    ]) {
      expect(decoder.decode(withContextJson(source, valid))).not.toBeNull();
      expect(decoder.decode(withContextJson(source, malformed))).toBeNull();
      expect(decoder.decode(withContextJson(source, valid))!.lmuContext).toEqual(cachedContext("1"));
    }
  });

  test("scoped context encoder shares only validated immutable observations and keeps boundary checks", () => {
    const decoder = createLMUSourceFrameDecoder();
    const source = original();
    const first = decoder.decode(withContextJson(source, JSON.stringify(encodeLmuContext(cachedContext("1")))))!.lmuContext!;
    const second = decoder.decode(withContextJson(source, JSON.stringify(encodeLmuContext(cachedContext("2")))))!.lmuContext!;
    const encode = createLmuContextEncoder();
    const firstWire = encode(first);
    const secondWire = encode(second);
    expect(secondWire).toEqual(encodeLmuContext(second));
    expect(secondWire.supplemental).toBe(firstWire.supplemental);
    expect(Reflect.set(firstWire.supplemental[0]!.observation, "value", 99)).toBe(false);
    expect(decodeLmuContext(secondWire)).toEqual(second);
    expect(() => encode({ ...second, key: { ...second.key, sessionKey: "other" } })).toThrow("Invalid LMU live context");
    expect(() => encode({ ...second, key: { ...second.key, captureSequence: "-1" } })).toThrow("Invalid LMU live context");
    const mutable = cachedContext("3");
    encode(mutable);
    mutable.supplemental[0]!.observation.value = 2;
    expect(encode(mutable).supplemental[0]!.observation.value).toBe(2);
    mutable.supplemental[0]!.observation.value = "wrong";
    expect(() => encode(mutable)).toThrow("Invalid LMU live context");
    expect(lmuParser.createParserState()).toBeNull();
    const raw = withContextJson(source, JSON.stringify(encodeLmuContext(cachedContext("4"))));
    const beforeReset = lmuParser.tryParse(raw, null)!;
    expect(lmuParser.createParserState()).toBeNull();
    const afterReset = lmuParser.tryParse(raw, null)!;
    expect(afterReset).toEqual(beforeReset);
    expect(afterReset.lmuContext!.supplemental).not.toBe(beforeReset.lmuContext!.supplemental);
  });
});
