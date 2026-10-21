import { expect, test } from "bun:test";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump-decoder";
import { encodeMetaFrame, encodeFrameLength, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame,
  encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords, type SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { lmuServerAdapter } from "@raceiq/game-lmu";
import { createNativeOnlineRecordingCodec, encodeNativeOnlineRecording } from "@raceiq/backend-core/session-capture/online-recording-codec";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_TELEMETRY } from "@raceiq/capture-formats/lmu/layout";
import { iterateOnlineLapSourceRecords, type OnlineLapSource } from "@raceiq/backend-core/session-capture/online-source";

registerServerGame(lmuServerAdapter);
const codec = createNativeOnlineRecordingCodec("lmu");
const originals = [
  [1, "lmu-2026-09-19T20-09-44-686Z.bin.gz"],
  [2, "lmu-2026-09-22T21-18-23-218Z.bin.gz.part1"],
] as const;

// The split v2 original exceeds a whole-buffer limit; only read its first three actual polls.
async function nativeFrames(filename: string) {
  const file = createReadStream(resolve(import.meta.dir, "../../../../test/artifacts/laps", filename));
  const gzip = createGunzip();
  const chunks: Buffer[] = [];
  let length = 0, needed = 21;
  try {
    for await (const chunk of file.pipe(gzip)) {
      const bytes = chunk as Buffer;
      chunks.push(bytes);
      length += bytes.length;
      if (needed === 21 && length >= 21) needed = 16 + 3 * (5 + Buffer.concat(chunks).readUInt32LE(17));
      if (length >= needed) {
        const frames = readLMUFramesFromBuffer(Buffer.concat(chunks), 3);
        if (frames.length !== 3) throw new Error("Genuine LMU original lacks three native polls");
        return frames;
      }
    }
    throw new Error("Genuine LMU original ended before its native polls");
  } finally {
    gzip.destroy();
    file.destroy();
  }
}

const framed = (frame: Buffer, atMs?: number) => Buffer.concat([encodeFrameLength(frame.length, atMs), frame]);

async function sourceRecords(predecessor: readonly Buffer[], prefix: readonly Buffer[], owned: Buffer, startMs: number) {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-overlap-"));
  const header = Buffer.concat([encodeMetaFrame(4), encodeSparseCaptureFormatFrame()]);
  const checkpoint = framed(owned);
  const beforeOwned = Buffer.concat([header, ...prefix]);
  const capture = {
    rawFile: join(directory, "current.bin"), source: null, gameId: "lmu" as const,
    carId: "fixture-car", trackId: "fixture-track",
  };
  const previousFile = join(directory, "previous.bin");
  const previousBytes = Buffer.concat([header, checkpoint, ...predecessor, checkpoint]);
  const source: OnlineLapSource = {
    lapId: 1, sessionId: 1, gameId: "lmu", carId: capture.carId, trackId: capture.trackId,
    lapGuid: "9a25770b-0285-4f04-a128-7277a5234760", originalActivityId: "fixture-activity",
    sourceRevision: "fixture-revision", ownerUserId: "fixture-owner", sourceKind: "native_capture",
    frameClock: "unknown", clockAnchor: null,
    sourceClock: { domain: "fixture-native-clock", startMs, endMs: startMs + 1 },
    driverAttributionStints: [],
    capturedBinding: { id: "unproven", gameId: "lmu", sourceKind: "fixture", nativeIdentity: "unproven",
      confirmation: "user_confirmed", revision: 1 },
    lapNumber: 1, lapTime: 1, sectorTimes: null, totalTimeMs: null, sectorTimesMs: null,
    recordedAt: null, createdAt: "2026-09-19T20:09:44.686Z", carSetup: null, tuneId: null,
    capture, publicationIdentity: "fixture-publication",
    window: { startByteOffset: beforeOwned.length, frameCount: 1, trailingContextFrameCount: 0 },
    contextParts: [{
      capture: { ...capture, rawFile: previousFile },
      chunk: {
        id: "previous", kind: "auxiliary", path: "previous.bin", byteLength: previousBytes.length,
        firstOrdinal: 0, recordCount: predecessor.length, sourceStart: 0, sourceEnd: predecessor.length,
        sourceByteStart: 0, sourceByteEnd: predecessor.reduce((sum, bytes) => sum + bytes.length, 0),
        ownedFrameByteOffset: header.length + checkpoint.length,
      },
    }],
  };
  try {
    // The checkpoint and duplicated finish trigger are not original predecessor records.
    writeFileSync(previousFile, previousBytes);
    writeFileSync(capture.rawFile, Buffer.concat([beforeOwned, framed(owned), framed(owned)]));
    const result = [];
    for await (const record of iterateOnlineLapSourceRecords(source)) result.push(record);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [version, filename] of originals) {
  test(`LMU v${version} source merges only exact bounded member overlap`, async () => {
    const [a, b, c] = await nativeFrames(filename);
    const native = decodeLMUSourceFrame(b!)!;
    const startMs = native.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime) * 1000 - 1;
    for (const [history, prefix, expected] of [
      [[a!, b!], [a!, b!], [a!, b!]],
      [[a!, b!], [b!, c!], [b!, c!]],
      [[a!, b!], [a!, c!], [a!, c!]],
      [[a!, b!, c!], [], [b!, c!]],
      [[a!], [a!, b!, c!], [b!, c!]],
      [[a!], [], [a!]],
    ]) {
      const result = await sourceRecords(history!.map(frame => framed(frame)), prefix!.map(frame => framed(frame)), c!, startMs);
      expect(result.map(({ scope }) => scope)).toEqual([...expected!.map(() => "context" as const), "lap" as const]);
      expect(result.map(({ record }) => record.kind === "frame" ? record.frame : null)).toEqual([...expected!, c!]);
    }
    const minimal = await sourceRecords([framed(a!), framed(b!)], [framed(a!), framed(b!)], c!, startMs + 1);
    expect(minimal.map(({ record }) => record.kind === "frame" ? record.frame : null)).toEqual([b!, c!]);
  }, 60_000);

  test(`LMU v${version} source retains distinct polls despite equal or backwards acquisition clocks`, async () => {
    const [a, b, c] = await nativeFrames(filename);
    const startMs = decodeLMUSourceFrame(b!)!.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime) * 1000 - 1;
    for (const delta of [0, -1]) {
      const current = Buffer.from(b!);
      current.writeDoubleLE(a!.readDoubleLE(20) + delta, 20);
      const result = await sourceRecords([framed(a!)], [framed(current)], c!, startMs);
      expect(result.map(({ record }) => record.kind === "frame" ? record.frame : null)).toEqual([a!, current, c!]);
      expect(decodeLMUSourceFrame(current)!.telemetry).toEqual(decodeLMUSourceFrame(b!)!.telemetry);
    }
    const separatelyRecorded = await sourceRecords([framed(b!, 1000)], [framed(b!, 1001)], c!, startMs);
    expect(separatelyRecorded.map(({ record }) => record.kind === "frame" ? record.frameTimeMs : null)).toEqual([1000, 1001, undefined]);
  }, 60_000);

  test(`LMU v${version} source resets context at real segment boundaries and holds malformed provenance`, async () => {
    const [a, b, c] = await nativeFrames(filename);
    const startMs = decodeLMUSourceFrame(b!)!.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime) * 1000 - 1;
    for (const [history, prefix] of [
      [[framed(a!)], [encodeSegmentBoundaryFrame(), framed(b!)]],
      [[framed(a!), encodeSegmentBoundaryFrame(), framed(b!)], []],
    ]) {
      const result = await sourceRecords(history!, prefix!, c!, startMs);
      expect(result.map(({ record }) => record.kind === "frame" ? record.frame : null)).toEqual([b!, c!]);
    }
    const malformed = Buffer.from(b!);
    malformed.writeUInt16LE(3, 8);
    await expect(sourceRecords([framed(a!)], [framed(malformed)], c!, startMs))
      .rejects.toMatchObject({ code: "source_context_unavailable" });
    await expect(sourceRecords([framed(malformed)], [], c!, startMs))
      .rejects.toMatchObject({ code: "source_context_unavailable" });
  }, 60_000);
}

for (const [version, filename] of originals) {
  test(`native LMU v${version} transport preserves real predecessor bytes and rejects malformed schemas`, async () => {
    const frames = await nativeFrames(filename);
    expect(frames[0]!.readUInt16LE(8)).toBe(version);
    async function* records(): AsyncGenerator<SessionCaptureRecord> {
      yield { kind: "segment-context", offset: 0, endOffset: 0 };
      for (const frame of frames.slice(0, 2)) yield { kind: "frame", frame, offset: 0, endOffset: 0 };
      yield { kind: "segment-context-end", offset: 0, endOffset: 0 };
      yield { kind: "frame", frame: frames[2]!, offset: 0, endOffset: 0 };
    }
    const bytes = await encodeNativeOnlineRecording(records(), "lmu");
    expect(await codec.isServiceCompatible(bytes, "lmu")).toBe(true);
    const retained = [...iterateSessionCaptureRecords(bytes)].filter(record => record.kind === "frame");
    expect(retained.map(record => record.frame)).toEqual(frames);
    const badVersion = Buffer.from(frames[0]!); badVersion.writeUInt16LE(3, 8);
    const badClock = Buffer.from(frames[0]!); badClock.writeDoubleLE(Number.NaN, 20);
    for (const frame of [frames[0]!.subarray(0, -1), Buffer.concat([frames[0]!, Buffer.alloc(1)]), badVersion, badClock]) {
      async function* malformed(): AsyncGenerator<SessionCaptureRecord> {
        yield { kind: "frame", frame, offset: 0, endOffset: 0 };
      }
      await expect(encodeNativeOnlineRecording(malformed(), "lmu")).rejects.toMatchObject({ code: "unsupported_recording_format" });
    }
    const excessive = Buffer.concat([encodeMetaFrame(4), encodeSegmentContextFrame(),
      ...frames.flatMap(frame => [encodeFrameLength(frame.length), frame]), encodeSegmentContextEndFrame(),
      encodeFrameLength(frames[2]!.length), frames[2]!]);
    expect(await codec.isServiceCompatible(excessive, "lmu")).toBe(false);
  }, 60_000);
}
