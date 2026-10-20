import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { encodeFrameLength, iterateSessionFrames, iterateSessionCaptureRecords, iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";
import { SessionRecorder } from "@raceiq/capture-formats/session/recorder";
import { SparseCaptureEncoder, SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { decodeF1CaptureFrame, encodeF1CaptureFrame, F1_HEADER_SIZE, isF1CaptureFrame, parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";
import { readSessionPackets } from "@raceiq/backend-core/test-support/recordings/session-frames";
import { f1ServerAdapter } from "../src/index";
import { f1Parser } from "../src/game-parser";
import { normalizeTelemetryPacket } from "@raceiq/telemetry-core/telemetry/normalization";
import { getServerGame, registerServerGame } from "@raceiq/backend-core/games/registry";
import { registerGame } from "@raceiq/shared/games/registry";
import { compactF1CaptureRecords } from "@raceiq/capture-formats/session/framing";
import { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";
import { loadSessionCapture } from "@raceiq/backend-core/session-capture/source-loader";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

registerGame(f1ServerAdapter);
registerServerGame(f1ServerAdapter);

const FIXTURE = "f1-2025-2026-04-22T11-42-43-029Z.bin.gz";
function normalizedPackets(file: string): TelemetryPacket[] {
  const game = getServerGame("f1-2025");
  return readSessionPackets(file, f1ServerAdapter).map((packet) => {
    normalizeTelemetryPacket(packet, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
    return packet;
  });
}

describe("F1 capture-only motion compaction", () => {
  test("preserves parsed recording output, legacy reads, and only omits platform channels", async () => {
    const fixture = getRecordingFixture(FIXTURE);
    if (!fixture) throw new Error(`Required recording fixture missing: ${FIXTURE}`);
    const source = gunzipSync(readFileSync(fixture));
    const original = Buffer.from(source);
    const frames = [...iterateSessionFrames(source)];
    expect(frames.length).toBeGreaterThan(0);
    const root = mkdtempSync(join(tmpdir(), "f1-capture-contract-"));
    const compactPath = join(root, "compact.bin");
    const legacyPath = join(root, "legacy.bin");
    const compactRecorder = new SparseSessionRecorder("f1-2025");
    const legacyRecorder = new SessionRecorder();
    try {
      compactRecorder.start(compactPath);
      compactRecorder.writeMetaFrame();
      legacyRecorder.start(legacyPath);
      legacyRecorder.writeMetaFrame();
      let compactMotionCount = 0;
      for (const frame of frames) {
        const before = Buffer.from(frame);
        const encoded = encodeF1CaptureFrame(frame);
        expect(frame).toEqual(before);
        if (isF1CaptureFrame(encoded)) {
          compactMotionCount++;
          expect(encoded.length).toBe(frame.length - 56 + 9);
          const decoded = decodeF1CaptureFrame(encoded);
          expect(decoded.length).toBe(frame.length);
          expect(decoded.subarray(0, F1_HEADER_SIZE)).toEqual(frame.subarray(0, F1_HEADER_SIZE));
          for (let i = F1_HEADER_SIZE; i < frame.length; i++) {
            const body = i - F1_HEADER_SIZE;
            const omitted = (body >= 16 && body < 48) || (body >= 132 && body < 144) || (body >= 156 && body < 168);
            expect(decoded[i]).toBe(omitted ? 0 : frame[i]);
          }
        } else expect(encoded).toBe(frame);
        compactRecorder.writeRecord(frame);
        legacyRecorder.writeRecord(frame);
      }
      await Promise.all([compactRecorder.stop(), legacyRecorder.stop()]);
      expect(compactMotionCount).toBeGreaterThan(0);
      expect(source).toEqual(original);
      const compactRecords = [...iterateSessionCaptureRecords(readFileSync(compactPath))]
        .filter((record) => record.kind === "frame").map((record) => record.frame);
      const legacyRecords = [...iterateSessionCaptureRecords(readFileSync(legacyPath))]
        .filter((record) => record.kind === "frame").map((record) => record.frame);
      expect(compactRecords.length).toBe(frames.length);
      expect(legacyRecords.length).toBe(frames.length);
      const compactBytes = readFileSync(compactPath);
      const targetIndex = Math.min(30, compactRecords.length - 1);
      const targetOffset = [...iterateSessionCaptureRecords(compactBytes)]
        .filter((record) => record.kind === "frame")[targetIndex]!.offset;
      const sought = [...iterateSessionCaptureRecords(compactBytes, targetOffset)]
        .filter((record) => record.kind === "frame").map((record) => record.frame);
      expect(sought).toEqual(compactRecords.slice(targetIndex));
      const chunked = async function* () {
        for (let offset = 0; offset < compactBytes.length;) {
          const size = offset < 256 ? 7 : 65536;
          yield compactBytes.subarray(offset, offset + size);
          offset += size;
        }
      };
      const asyncFrames: Buffer[] = [];
      for await (const record of iterateSessionCaptureRecordsAsync(chunked())) {
        if (record.kind === "frame") asyncFrames.push(record.frame);
      }
      expect(asyncFrames).toEqual(compactRecords);
      const compactDecoded = compactRecords.map(decodeF1CaptureFrame);
      const rawPackets = normalizedPackets(fixture);
      const parseState = f1Parser.createParserState();
      const parsed = compactDecoded.flatMap((frame) => {
        const packet = f1ServerAdapter.tryParse(frame, parseState);
        return packet ? [packet] : [];
      });
      const game = getServerGame("f1-2025");
      for (const packet of parsed) normalizeTelemetryPacket(packet, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
      expect(parsed).toEqual(rawPackets);
      expect(normalizedPackets(legacyPath)).toEqual(rawPackets);
    } finally {
      if (compactRecorder.recording) await compactRecorder.stop();
      if (legacyRecorder.recording) await legacyRecorder.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
  test("worker-written compact source loads through backend loader and real F1 parser", async () => {
    const fixture = getRecordingFixture(FIXTURE);
    if (!fixture) throw new Error(`Required recording fixture missing: ${FIXTURE}`);
    const root = mkdtempSync(join(tmpdir(), "f1-worker-capture-"));
    const path = join(root, "worker.bin");
    const recorder = new WorkerSessionRecorder("f1-2025");
    try {
      recorder.start(path);
      recorder.writeMetaFrame();
      const sourceFrames = [...iterateSessionFrames(gunzipSync(readFileSync(fixture)))].slice(0, 600);
      for (const frame of sourceFrames) recorder.writeRecord(frame);
      await recorder.stop();
      const source = { rawFile: path, source: null, gameId: "f1-2025" as const, carId: "", trackId: "" };
      const capture = await loadSessionCapture(source);
      const records = [...iterateSessionCaptureRecords(capture)]
        .filter((record) => record.kind === "frame");
      expect(records.length).toBeGreaterThan(0);
      const replayed = await parseRawLapFrames(source, records[0]!.offset, records.length);
      const expectedState = f1Parser.createParserState();
      const expected = sourceFrames.flatMap((frame) => {
        const packet = f1Parser.tryParse(frame, expectedState);
        if (!packet) return [];
        normalizeTelemetryPacket(packet, f1ServerAdapter.coordSystem === "standard-xyz", f1ServerAdapter.runtime.normSuspensionTravelMm);
        return [packet];
      });
      expect(expected.length).toBeGreaterThan(0);
      expect(replayed).toEqual(expected);
    } finally {
      if (recorder.state !== "closed" && recorder.state !== "failed") await recorder.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, { timeout: 180_000 });

  test("codec preserves retained channels, player identity, and native tails; rejects malformed envelopes", () => {
    const native = Buffer.alloc(F1_HEADER_SIZE + 228);
    native.writeUInt16LE(2025, 0);
    native[2] = 25;
    native[5] = 1;
    native[6] = 13;
    native[27] = 7;
    native[F1_HEADER_SIZE + 144] = 99;
    native[F1_HEADER_SIZE + 224] = 0xa5;
    const encoded = encodeF1CaptureFrame(native);
    expect(encoded.length).toBe(native.length - 56 + 9);
    const decoded = decodeF1CaptureFrame(encoded);
    const framedNative = Buffer.concat([encodeFrameLength(native.length), native]);
    const compactedRaw = compactF1CaptureRecords(framedNative);
    expect(compactedRaw).not.toBe(framedNative);
    const compactedRecord = [...iterateSessionFrames(compactedRaw)][0]!;
    expect(decodeF1CaptureFrame(compactedRecord)).toEqual(decoded);
    expect(decoded[27]).toBe(7);
    expect(decoded.subarray(F1_HEADER_SIZE + 144, F1_HEADER_SIZE + 156)).toEqual(native.subarray(F1_HEADER_SIZE + 144, F1_HEADER_SIZE + 156));
    expect(decoded.subarray(F1_HEADER_SIZE + 168)).toEqual(native.subarray(F1_HEADER_SIZE + 168));
    expect(decodeF1CaptureFrame(native)).toBe(native);
    const badVersion = Buffer.from(encoded);
    badVersion[4] = 99;
    expect(() => decodeF1CaptureFrame(badVersion)).toThrow();
    const badLength = Buffer.from(encoded);
    badLength[5]--;
    expect(() => decodeF1CaptureFrame(badLength)).toThrow();
  });

  test("lossless maintenance preserves omitted native values; new capture checkpoints do not mutate live state", () => {
    const fixture = getRecordingFixture(FIXTURE)!;
    const frames = [...iterateSessionFrames(gunzipSync(readFileSync(fixture)))].slice(0, 600);
    const state = f1Parser.createParserState();
    for (const frame of frames) f1Parser.tryParse(frame, state);
    const motionEx = Buffer.alloc(F1_HEADER_SIZE + 224);
    frames[frames.length - 1]!.copy(motionEx, 0, 0, F1_HEADER_SIZE);
    motionEx[6] = 13;
    for (let offset = F1_HEADER_SIZE; offset < motionEx.length; offset += 4) motionEx.writeFloatLE(1, offset);
    const live = f1Parser.tryParse(motionEx, state);
    expect(live?.AngularVelocityX).toBe(1);
    const checkpoint = state.captureCheckpoint();
    const saved = JSON.parse(Buffer.from(checkpoint).toString());
    for (const field of ["suspensionVelocityRL", "suspensionVelocityRR", "suspensionVelocityFL", "suspensionVelocityFR",
      "localVelocityX", "localVelocityY", "localVelocityZ", "angularAccelerationX", "angularAccelerationY", "angularAccelerationZ"]) {
      expect(saved.motionEx[field]).toBe(0);
    }
    expect(saved.motionEx.angularVelocityX).toBe(1);
    expect(f1Parser.tryParse(motionEx, state)).toEqual(live);
    const restored = f1Parser.createParserState();
    restored.restoreCheckpoint(checkpoint);
    const header = parseF1Header(motionEx);
    expect(restored.feed(header, decodeF1CaptureFrame(encodeF1CaptureFrame(motionEx)))).toEqual(live);
    expect(new SparseCaptureEncoder("f1-2025").encode(motionEx, 12)).toEqual(motionEx);
    const projected = new SparseCaptureEncoder("f1-2025", true).encode(motionEx, 12);
    expect(isF1CaptureFrame(projected)).toBe(true);
    for (const version of [0, 2]) {
      const unsupported = Buffer.from(motionEx);
      unsupported[5] = version;
      expect(encodeF1CaptureFrame(unsupported)).toBe(unsupported);
    }
    const truncated = motionEx.subarray(0, 252);
    expect(encodeF1CaptureFrame(truncated)).toBe(truncated);
  });
});
