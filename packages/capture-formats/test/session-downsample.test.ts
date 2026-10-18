import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame, IRacingSourceFrameEncoder } from "../src/iracing/source-frame";
import { ACC_PACKED_MAGIC, packTriplet } from "../src/kunos/pack-triplet";
import { inspectDownsampleRecording, DownsampleRecordingError, rewriteDownsampleRecording, validateDownsampleRecording } from "../src/session/downsample";
import { decompressIfGzipSync, encodeFrameLength, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame, iterateSessionCaptureRecords } from "../src/session/framing";

test("retains each F1 telemetry family state at an interior lap endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-f1-lap-endpoint-"));
  try {
    const frames: Buffer[] = [];
    for (let tick = 0; tick < 12; tick++) {
      for (const packetId of [0, 6, 13]) {
        const frame = Buffer.alloc(29);
        frame.writeUInt16LE(2025, 0);
        frame[6] = packetId;
        frame.writeBigUInt64LE(1n, 7);
        frame.writeFloatLE(tick * 0.011, 15);
        frame.writeUInt32LE(tick * 3 + packetId, 19);
        frames.push(frame);
      }
    }
    const lapIndexes = [{ lapId: 1, rawByteOffset: 0, rawFrameCount: 32 }];
    const source = { gameId: "f1-2025" as const, records: records(frames), createTelemetryParser: parser, lapIndexes };
    const inspection = await inspectDownsampleRecording(source);
    expect(inspection.laps[0]?.f1EndpointTelemetry.map(({ first, last }) => [first.ordinal, last.ordinal])).toEqual([
      [0, 30],
      [1, 31],
      [2, 29],
    ]);
    const outputPath = join(root, "f1-lap-endpoint.bin");
    await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
    const outputFrames = [...iterateSessionCaptureRecords(decompressIfGzipSync(readFileSync(outputPath)))]
      .filter((record) => record.kind === "frame")
      .map((record) => record.frame);
    for (const packetId of [0, 6, 13]) {
      const expectedValue = packetId === 13 ? 40 : 30 + packetId;
      const endpointPacket = outputFrames.find((frame) => frame[6] === packetId && frame.readUInt32LE(19) === expectedValue);
      expect(endpointPacket).toBeDefined();
      expect(endpointPacket?.readUInt32LE(19)).toBe(expectedValue);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains latest F1 family update immediately before indexed lap start", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-f1-prelap-"));
  try {
    const frame = (packetId: number, time: number, marker: number) => {
      const value = Buffer.alloc(29);
      value.writeUInt16LE(2025, 0);
      value[6] = packetId;
      value.writeBigUInt64LE(1n, 7);
      value.writeFloatLE(time, 15);
      value.writeUInt32LE(marker, 19);
      return value;
    };
    const frames = [
      frame(6, 0, 100),
      frame(6, 0.01, 200),
      frame(2, 0.011, 201),
      frame(6, 0.02, 300),
      frame(2, 0.021, 301),
      frame(6, 0.03, 400),
      frame(2, 0.031, 401),
    ];
    const lapOffset = frames.slice(0, 2).reduce((offset, value) => offset + encodeFrameLength(value.length).length + value.length, 0);
    const source = {
      gameId: "f1-2025" as const,
      records: records(frames),
      createTelemetryParser: parser,
      lapIndexes: [{ lapId: 1, rawByteOffset: lapOffset, rawFrameCount: 5 }],
    };
    const inspection = await inspectDownsampleRecording(source);
    expect(inspection.laps[0]?.f1EndpointTelemetry.map(({ first, last }) => [first.ordinal, last.ordinal])).toEqual([[1, 5]]);
    const outputPath = join(root, "f1-prelap.bin");
    await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
    const outputFrames = [...iterateSessionCaptureRecords(decompressIfGzipSync(readFileSync(outputPath)))]
      .filter((record) => record.kind === "frame")
      .map((record) => record.frame);
    expect(outputFrames.some((value) => value[6] === 6 && value.readUInt32LE(19) === 200)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("does not seed an indexed F1 lap with telemetry from preceding session UID", async () => {
  const frame = (uid: bigint, packetId: number, time: number) => {
    const value = Buffer.alloc(29);
    value.writeUInt16LE(2025, 0);
    value[6] = packetId;
    value.writeBigUInt64LE(uid, 7);
    value.writeFloatLE(time, 15);
    return value;
  };
  const frames = [frame(1n, 6, 0), frame(2n, 6, 0.01), frame(2n, 2, 0.02)];
  const lapOffset = frames[0]!.length + encodeFrameLength(frames[0]!.length).length;
  const source = {
    gameId: "f1-2025" as const,
    records: records(frames),
    createTelemetryParser: parser,
    lapIndexes: [{ lapId: 1, rawByteOffset: lapOffset, rawFrameCount: 2 }],
  };
  const inspection = await inspectDownsampleRecording(source);
  expect(inspection.laps[0]?.f1EndpointTelemetry.map(({ first, last }) => [first.ordinal, last.ordinal])).toEqual([[1, 1]]);
});
test("retains delayed finish at interior indexed lap endpoint without successor index", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-delayed-interior-"));
  try {
    const frames = Array.from({ length: 30 }, (_, index) => fmFrame(index * 10));
    const source = {
      gameId: "fm-2023" as const,
      records: records(frames),
      createTelemetryParser: parser,
      lapIndexes: [{ lapId: 1, rawByteOffset: 0, rawFrameCount: 9 }],
      appendsDelayedFinishFrame: true,
    };
    const inspection = await inspectDownsampleRecording(source);
    const outputPath = join(root, "finish-interior.bin");
    await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
    const output = [...iterateSessionCaptureRecords(readFileSync(outputPath))]
      .filter((record) => record.kind === "frame")
      .map((record) => record.frame.readUInt32LE(4));
    expect(output).toEqual([0, 20, 40, 60, 80, 90, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 290]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("segment boundary ends context and restores 50 Hz throttling", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-context-reset-"));
  try {
    const source = {
      gameId: "fm-2023" as const,
      records: async function* () {
        yield { kind: "segment-context" as const, offset: 0, endOffset: 16 };
        yield { kind: "frame" as const, offset: 16, endOffset: 356, frame: fmFrame(0) };
        yield { kind: "segment-boundary" as const, offset: 356, endOffset: 372 };
        let offset = 372;
        for (let index = 0; index < 100; index++) {
          const frame = fmFrame(index * 10);
          const endOffset = offset + encodeFrameLength(frame.length).length + frame.length;
          yield { kind: "frame" as const, offset, endOffset, frame };
          offset = endOffset;
        }
      },
      createTelemetryParser: parser,
      lapIndexes: [],
    };
    const inspection = await inspectDownsampleRecording(source);
    const outputPath = join(root, "context-reset.bin");
    const result = await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
    const output = [...iterateSessionCaptureRecords(readFileSync(outputPath))]
      .filter((record) => record.kind === "frame")
      .map((record) => record.frame.readUInt32LE(4));
    expect(output).toEqual([0, 0, ...Array.from({ length: 49 }, (_, index) => (index + 1) * 20), 990]);
    expect(result.frameCount).toBe(output.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function fmFrame(tick: number): Buffer {
  const frame = Buffer.alloc(324);
  frame.writeUInt32LE(tick, 4);
  return frame;
}
function records(frames: Buffer[], times?: Array<number | undefined>) {
  return async function* () {
    let offset = 0;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const endOffset = offset + encodeFrameLength(frame.length).length + frame.length;
      yield times?.[i] === undefined ? { kind: "frame" as const, offset, endOffset, frame } : { kind: "frame" as const, offset, endOffset, frame, frameTimeMs: times[i]! };
      offset = endOffset;
    }
  };
}
const parser = () => ({ parse: () => true, reset: () => {} });

test("rejects checkpoint-initialized recordings without interpreting frames with missing parser state", async () => {
  const bootstrap = encodeParserBootstrapFrame("f1-2025", Buffer.from("checkpoint"));
  const source = {
    gameId: "f1-2025" as const,
    records: async function* () {
      yield* iterateSessionCaptureRecords(bootstrap);
    },
    createTelemetryParser: parser,
    lapIndexes: [],
  };
  await expect(inspectDownsampleRecording(source)).rejects.toMatchObject({
    reason: "unsupported-format",
  });
});

test("rewrites 100 Hz FM streams to each configured ceiling and validates plain/gzip output", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-"));
  try {
    const frames = Array.from({ length: 1000 }, (_, index) => fmFrame(index * 10));
    const source = { gameId: "fm-2023" as const, records: records(frames), createTelemetryParser: parser, lapIndexes: [] };
    const inspection = await inspectDownsampleRecording(source);
    for (const [targetHz, minimum] of [
      [50, 500],
      [60, 600],
      [70, 700],
      [80, 800],
      [90, 900],
      [100, 1000],
    ] as const) {
      const gzip = targetHz === 50,
        outputPath = join(root, `rate-${targetHz}.bin${gzip ? ".gz" : ""}`);
      const result = await rewriteDownsampleRecording(source, inspection, { targetHz, outputPath, gzip });
      expect(result.sourceFrameCount).toBe(1000);
      expect(result.frameCount).toBeGreaterThanOrEqual(minimum);
      expect(result.frameCount).toBeLessThanOrEqual(minimum + 2);
      const bytes = readFileSync(outputPath),
        expanded = decompressIfGzipSync(bytes);
      expect(expanded.readUInt32LE(8)).toBe(result.frameCount);
      const emitted = [...iterateSessionCaptureRecords(expanded)].filter((record) => record.kind === "frame");
      const first = emitted[0];
      const last = emitted.at(-1);
      expect(first?.kind === "frame" ? first.frame.readUInt32LE(4) : undefined).toBe(0);
      expect(last?.kind === "frame" ? last.frame.readUInt32LE(4) : undefined).toBe(9990);
      const output = {
        ...source,
        records: async function* () {
          yield* iterateSessionCaptureRecords(expanded);
        },
      };
      await validateDownsampleRecording(output, result);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("throttles F1 telemetry families independently while preserving ancillary packets and UID streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-f1-"));
  try {
    const frames: Buffer[] = [];
    for (let tick = 0; tick < 1000; tick++)
      for (const packetId of [0, 6, 13, 1]) {
        const frame = Buffer.alloc(29);
        frame.writeUInt16LE(2025, 0);
        frame[6] = packetId;
        frame.writeBigUInt64LE(tick < 500 ? 1n : 2n, 7);
        frame.writeFloatLE((tick < 500 ? tick : tick - 500) / 100, 15);
        frame.writeUInt32LE(tick, 19);
        frames.push(frame);
      }
    const source = { gameId: "f1-2025" as const, records: records(frames), createTelemetryParser: parser, lapIndexes: [] };
    const inspection = await inspectDownsampleRecording(source),
      outputPath = join(root, "f1.bin");
    const result = await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
    const expanded = decompressIfGzipSync(readFileSync(outputPath));
    const output = {
      ...source,
      records: async function* () {
        yield* iterateSessionCaptureRecords(expanded);
      },
    };
    await validateDownsampleRecording(output, result);
    const counts = new Map<number, number>();
    const perSession = new Map<string, number>();
    for (const record of iterateSessionCaptureRecords(expanded)) {
      if (record.kind !== "frame") continue;
      const packetId = record.frame[6]!;
      const uid = record.frame.readBigUInt64LE(7).toString();
      counts.set(packetId, (counts.get(packetId) ?? 0) + 1);
      const key = `${uid}:${packetId}`;
      perSession.set(key, (perSession.get(key) ?? 0) + 1);
    }
    for (const packetId of [0, 6, 13]) {
      expect(counts.get(packetId)).toBeGreaterThanOrEqual(500);
      expect(counts.get(packetId)).toBeLessThan(1000);
      expect(perSession.get(`1:${packetId}`)).toBeGreaterThanOrEqual(250);
      expect(perSession.get(`2:${packetId}`)).toBeGreaterThanOrEqual(250);
    }
    expect(counts.get(1)).toBe(1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("refuses an occupied rewrite target without changing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-conflict-"));
  try {
    const outputPath = join(root, "occupied.bin"),
      existing = Buffer.from("preserve");
    writeFileSync(outputPath, existing);
    const frames = [fmFrame(0), fmFrame(10)];
    const source = { gameId: "fm-2023" as const, records: records(frames), createTelemetryParser: parser, lapIndexes: [] };
    const inspection = await inspectDownsampleRecording(source);
    await expect(rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false })).rejects.toThrow("already exists");
    expect(readFileSync(outputPath)).toEqual(existing);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("refuses occupied gzip target and temp paths without deleting conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-gzip-conflict-"));
  try {
    const source = { gameId: "fm-2023" as const, records: records([fmFrame(0), fmFrame(10)]), createTelemetryParser: parser, lapIndexes: [] };
    const inspection = await inspectDownsampleRecording(source);
    for (const suffix of ["", ".tmp", ".raw.tmp"]) {
      const outputPath = join(root, `occupied-${suffix || "target"}.bin.gz`);
      const conflictPath = `${outputPath}${suffix}`;
      const existing = Buffer.from(`preserve-${suffix}`);
      writeFileSync(conflictPath, existing);
      await expect(rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: true })).rejects.toThrow("already exists");
      expect(readFileSync(conflictPath)).toEqual(existing);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("removes its partial output when source iteration fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-failure-"));
  try {
    const frames = [fmFrame(0), fmFrame(10)];
    let pass = 0;
    const source = {
      gameId: "fm-2023" as const,
      records: async function* () {
        pass++;
        yield { kind: "frame" as const, offset: 0, endOffset: 328, frame: frames[0]! };
        if (pass === 2) throw new Error("injected source read failure");
        yield { kind: "frame" as const, offset: 328, endOffset: 656, frame: frames[1]! };
      },
      createTelemetryParser: parser,
      lapIndexes: [],
    };
    const inspection = await inspectDownsampleRecording(source);
    const outputPath = join(root, "failure.bin");
    await expect(rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false })).rejects.toThrow("injected source read failure");
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(`${outputPath}.tmp`)).toBe(false);
    expect(existsSync(`${outputPath}.raw.tmp`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("keeps iRacing change carried only by dropped source delta", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-iracing-"));
  try {
    const encoder = new IRacingSourceFrameEncoder();
    const base = {
      schemaVersion: 2 as const,
      session: {
        sessionId: 1,
        subSessionId: 1,
        sessionNum: 1,
        driverCarIdx: 0,
        trackId: 1,
        trackName: "test",
        trackLengthM: 1,
        carId: 1,
        carName: "test",
        carClassId: 1,
        carClassName: "test",
        engineIdleRpm: 1,
        engineRedlineRpm: 2,
        engineCylinderCount: 4,
      },
    };
    const frames = [
      encoder.encode({ ...base, values: { SessionTick: 0, Changed: 0 } }),
      encoder.encode({ ...base, values: { SessionTick: 1, Changed: 77 } }),
      encoder.encode({ ...base, values: { SessionTick: 2, Changed: 77 } }),
      encoder.encode({ ...base, values: { SessionTick: 3, Changed: 77 } }),
    ];
    const source = { gameId: "iracing" as const, records: records(frames, [0, 10, 20, 30]), createTelemetryParser: parser, lapIndexes: [] };
    const inspection = await inspectDownsampleRecording(source),
      outputPath = join(root, "iracing.bin");
    const result = await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
    const bytes = readFileSync(outputPath),
      output = {
        ...source,
        records: async function* () {
          yield* iterateSessionCaptureRecords(decompressIfGzipSync(bytes));
        },
      };
    await validateDownsampleRecording(output, result);
    const decoder = createIRacingSourceDecoderState(),
      retained: number[] = [];
    for await (const record of output.records())
      if (record.kind === "frame") {
        const frame = decodeIRacingSourceFrame(record.frame, decoder);
        expect(frame).not.toBeNull();
        retained.push(frame!.values.Changed as number);
      }
    expect(retained).toContain(77);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rewrites overlapping lap windows with selected all-frame counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-downsample-laps-"));
  try {
    const frames = Array.from({ length: 10 }, (_, index) => fmFrame(index * 10));
    const lapIndexes = [
      { lapId: 1, rawByteOffset: 0, rawFrameCount: 10 },
      { lapId: 2, rawByteOffset: 0, rawFrameCount: 5 },
      { lapId: 3, rawByteOffset: 2 * (encodeFrameLength(324).length + 324), rawFrameCount: 6 },
    ];
    const source = { gameId: "fm-2023" as const, records: records(frames), createTelemetryParser: parser, lapIndexes };
    const inspection = await inspectDownsampleRecording(source),
      outputPath = join(root, "laps.bin");
    const result = await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
    expect(result.lapIndexes.map(({ lapId, rawFrameCount }) => [lapId, rawFrameCount])).toEqual([
      [1, 7],
      [2, 3],
      [3, 4],
    ]);
    const bytes = readFileSync(outputPath),
      output = {
        ...source,
        lapIndexes: result.lapIndexes.map(({ lapId, rawByteOffset, rawFrameCount }) => ({ lapId, rawByteOffset, rawFrameCount })),
        records: async function* () {
          yield* iterateSessionCaptureRecords(decompressIfGzipSync(bytes));
        },
      };
    await validateDownsampleRecording(output, result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
describe("inspectDownsampleRecording", () => {
  test("maps overlapping half-open lap windows by all-frame ordinal", async () => {
    const frames = [0, 1, 2, 3].map(fmFrame);
    const result = await inspectDownsampleRecording({
      gameId: "fm-2023",
      records: records(frames),
      createTelemetryParser: parser,
      lapIndexes: [
        { lapId: 1, rawByteOffset: 0, rawFrameCount: 3 },
        { lapId: 2, rawByteOffset: 0, rawFrameCount: 2 },
        { lapId: 3, rawByteOffset: encodeFrameLength(324).length + 324, rawFrameCount: 3 },
        { lapId: 4, rawByteOffset: null, rawFrameCount: 0 },
      ],
    });
    expect(result.laps.map((lap) => [lap.lapId, lap.startOrdinal, lap.endOrdinal, lap.expectedRawByteOffset, lap.expectedRawFrameCount])).toEqual([
      [1, 0, 3, 0, 3],
      [2, 0, 2, 0, 2],
      [3, 1, 4, 328, 3],
    ]);
  });
  test("measures observed telemetry frequency from recorded sample timestamps", async () => {
    const result = await inspectDownsampleRecording({
      gameId: "fm-2023",
      records: records([fmFrame(0), fmFrame(20), fmFrame(40)], [0, 20, 40]),
      createTelemetryParser: parser,
      lapIndexes: [],
    });
    expect(result.streams[0]?.sampleRateHz).toBe(50);
  });
  test("measures the first 1000 stream samples and ignores later pauses", async () => {
    const frames = Array.from({ length: 1001 }, (_, index) => fmFrame(index));
    const times = Array.from({ length: 1001 }, (_, index) => index < 1000 ? index * 20 : 100_000);
    const result = await inspectDownsampleRecording({
      gameId: "fm-2023",
      records: records(frames, times),
      createTelemetryParser: parser,
      lapIndexes: [],
    });
    expect(result.streams[0]?.sampleRateHz).toBe(50);
  });
  test("unwraps FM rollover and uses recorder time only for complete streams", async () => {
    const rollover = await inspectDownsampleRecording({
      gameId: "fm-2023",
      records: records([fmFrame(0xfffffff0), fmFrame(20)]),
      createTelemetryParser: parser,
      lapIndexes: [],
    });
    expect(rollover.streams[0]?.clock).toBe("fm-timestamp");
    expect(rollover.streams[0]!.lastTelemetry.timeMs).toBeGreaterThan(0xffffffff);

    const recorderClock = await inspectDownsampleRecording({
      gameId: "fm-2023",
      records: records([fmFrame(10), fmFrame(20)], [500, 600]),
      createTelemetryParser: parser,
      lapIndexes: [],
    });
    expect(recorderClock.streams[0]).toMatchObject({
      clock: "recorder",
      firstTelemetry: { timeMs: 500 },
      lastTelemetry: { timeMs: 600 },
    });
  });

  test("rejects indexed windows past end and native telemetry without timestamps", async () => {
    const frames = [fmFrame(1), fmFrame(2)];
    await expect(
      inspectDownsampleRecording({
        gameId: "fm-2023",
        records: records(frames),
        createTelemetryParser: parser,
        lapIndexes: [{ lapId: 1, rawByteOffset: 0, rawFrameCount: 3 }],
      }),
    ).rejects.toBeInstanceOf(DownsampleRecordingError);
    const accFrame = packTriplet(ACC_PACKED_MAGIC, 1, 1, Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1));
    await expect(
      inspectDownsampleRecording({
        gameId: "acc",
        records: records([accFrame]),
        createTelemetryParser: parser,
        lapIndexes: [],
      }),
    ).rejects.toMatchObject({ reason: "unreliable-time" });
    await expect(
      inspectDownsampleRecording({
        gameId: "acc",
        records: records([fmFrame(1)]),
        createTelemetryParser: parser,
        lapIndexes: [],
      }),
    ).rejects.toMatchObject({ reason: "unsupported-format" });
  });

  test("validates nested iRacing source frames during streaming", async () => {
    const encoder = new IRacingSourceFrameEncoder();
    const base = {
      schemaVersion: 2 as const,
      session: {
        sessionId: 1,
        subSessionId: 1,
        sessionNum: 1,
        driverCarIdx: 0,
        trackId: 1,
        trackName: "test",
        trackLengthM: 1,
        carId: 1,
        carName: "test",
        carClassId: 1,
        carClassName: "test",
        engineIdleRpm: 1,
        engineRedlineRpm: 2,
        engineCylinderCount: 4,
      },
      values: { SessionTick: 1 },
    };
    const session = encoder.encode(base);
    const next = encoder.encode({ ...base, values: { SessionTick: 2 } });
    const valid = await inspectDownsampleRecording({
      gameId: "iracing",
      records: records([session, next], [0, 1]),
      createTelemetryParser: parser,
      lapIndexes: [],
    });
    expect(valid.frameCount).toBe(2);
    await expect(
      inspectDownsampleRecording({
        gameId: "iracing",
        records: records([Buffer.from("bad")]),
        createTelemetryParser: parser,
        lapIndexes: [],
      }),
    ).rejects.toMatchObject({ reason: "unsupported-format" });
  });
  test("excludes context packets from lap telemetry endpoints", async () => {
    const pre = fmFrame(0);
    const context = fmFrame(10);
    const post = fmFrame(20);
    const stream = async function* () {
      yield { kind: "frame" as const, offset: 0, endOffset: 328, frame: pre };
      yield { kind: "segment-context" as const, offset: 328, endOffset: 344 };
      yield { kind: "frame" as const, offset: 344, endOffset: 672, frame: context };
      yield { kind: "segment-context-end" as const, offset: 672, endOffset: 688 };
      yield { kind: "frame" as const, offset: 688, endOffset: 1016, frame: post };
    };
    await expect(
      inspectDownsampleRecording({
        gameId: "fm-2023",
        records: stream,
        createTelemetryParser: parser,
        lapIndexes: [{ lapId: 1, rawByteOffset: 344, rawFrameCount: 1 }],
      }),
    ).rejects.toMatchObject({ reason: "unsupported-format" });
    const valid = await inspectDownsampleRecording({
      gameId: "fm-2023",
      records: stream,
      createTelemetryParser: parser,
      lapIndexes: [{ lapId: 2, rawByteOffset: 344, rawFrameCount: 2 }],
    });
    expect(valid.laps[0]?.firstTelemetry.ordinal).toBe(2);
    expect(valid.laps[0]?.lastTelemetry.ordinal).toBe(2);
  });

  test("parses iRacing context without resetting nested source deltas", async () => {
    const encoder = new IRacingSourceFrameEncoder();
    const base = {
      schemaVersion: 2 as const,
      session: {
        sessionId: 1,
        subSessionId: 1,
        sessionNum: 1,
        driverCarIdx: 0,
        trackId: 1,
        trackName: "test",
        trackLengthM: 1,
        carId: 1,
        carName: "test",
        carClassId: 1,
        carClassName: "test",
        engineIdleRpm: 1,
        engineRedlineRpm: 2,
        engineCylinderCount: 4,
      },
      values: { SessionTick: 1 },
    };
    const frames = [encoder.encode(base), encoder.encode({ ...base, values: { SessionTick: 2 } }), encoder.encode({ ...base, values: { SessionTick: 3 } })];
    let parses = 0;
    const stream = async function* () {
      yield { kind: "frame" as const, offset: 0, endOffset: 200, frame: frames[0]!, frameTimeMs: 0 };
      yield { kind: "segment-context" as const, offset: 200, endOffset: 216 };
      yield { kind: "frame" as const, offset: 216, endOffset: 400, frame: frames[1]!, frameTimeMs: 1 };
      yield { kind: "segment-context-end" as const, offset: 400, endOffset: 416 };
      yield { kind: "frame" as const, offset: 416, endOffset: 600, frame: frames[2]!, frameTimeMs: 2 };
    };
    const result = await inspectDownsampleRecording({
      gameId: "iracing",
      records: stream,
      createTelemetryParser: () => ({
        parse: () => {
          parses++;
          return true;
        },
        reset: () => {},
      }),
      lapIndexes: [],
    });
    expect(parses).toBe(3);
    expect(result.contextRanges).toEqual([{ startOrdinal: 1, endOrdinal: 2 }]);
    expect(result.frameCount).toBe(3);
  });

  test("uses complete recorder timestamps when F1 simulator time is nonfinite", async () => {
    const packet = (tick: number) => {
      const frame = Buffer.alloc(29);
      frame.writeUInt16LE(2025, 0);
      frame[6] = 0;
      frame.writeFloatLE(Number.NaN, 15);
      frame.writeUInt32LE(tick, 19);
      return frame;
    };
    const result = await inspectDownsampleRecording({
      gameId: "f1-2025",
      records: records([packet(1), packet(2)], [100, 200]),
      createTelemetryParser: parser,
      lapIndexes: [],
    });
    expect(result.streams[0]).toMatchObject({ clock: "recorder", firstTelemetry: { timeMs: 100 } });
    await expect(
      inspectDownsampleRecording({
        gameId: "f1-2025",
        records: records([packet(1)]),
        createTelemetryParser: parser,
        lapIndexes: [],
      }),
    ).rejects.toMatchObject({ reason: "unreliable-time" });
  });

  test("resets segment parsing state", async () => {
    const data = [fmFrame(1)];
    const stream = async function* () {
      yield { kind: "frame" as const, offset: 0, endOffset: 340, frame: data[0]! };
      yield { kind: "segment-boundary" as const, offset: 340, endOffset: 356 };
      yield { kind: "frame" as const, offset: 356, endOffset: 696, frame: fmFrame(2) };
    };
    const result = await inspectDownsampleRecording({ gameId: "fm-2023", records: stream, createTelemetryParser: parser, lapIndexes: [] });
    expect(result.segmentCount).toBe(2);
  });
});
