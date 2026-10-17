import { Readable } from "node:stream";
import { openCaptureArchive } from "@raceiq/capture-splitting";
import type { PublishedManifest } from "@raceiq/capture-splitting";
import { afterEach, expect, test } from "bun:test";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { isLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { runSplitWorker, splitCapturePromise } from "@raceiq/capture-splitting";
import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";
import { prepareLapWindowsForSplit } from "../../src/session-capture/split-windows";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "raceiq-capture-split-"));
  directories.push(path);
  return path;
}

function encodeRecord(frame: Buffer, timestamp?: number): Buffer {
  return Buffer.concat([encodeFrameLength(frame.length, timestamp), frame]);
}

async function readRecords(path: string) {
  const records: SessionCaptureRecord[] = [];
  for await (const record of iterateSessionCaptureRecordsAsync(createReadStream(path), { strict: true })) records.push(record);
  return records;
}

async function readChunkRecords(manifest: PublishedManifest, outputDirectory: string, chunk: PublishedManifest["chunks"][number]) {
  const stream = manifest.version === 4
    ? Readable.from([await (await openCaptureArchive(join(outputDirectory, manifest.archiveFile), manifest)).readEntryBuffer(
      "entryName" in chunk ? chunk.entryName : "",
      chunk.byteLength + 1024,
    )])
    : createReadStream(join(outputDirectory, "path" in chunk ? chunk.path : ""));
  const records: SessionCaptureRecord[] = [];
  for await (const record of iterateSessionCaptureRecordsAsync(stream, { strict: true })) records.push(record);
  return records;
}

test("splits exact detector windows from plain and gzip sources with timestamps and auxiliary frames", async () => {
  for (const compressed of [false, true]) {
    const root = directory();
    const sourcePath = join(root, compressed ? "source.bin.gz" : "source.bin");
    const outputDirectory = join(root, "staged");
    const sourceFrames = [
      { frame: Buffer.from([1, 2]), timestamp: undefined },
      { frame: Buffer.from([3, 4, 5]), timestamp: 10 },
      { frame: Buffer.from([6]), timestamp: 20 },
      { frame: Buffer.from([7, 8]), timestamp: undefined },
      { frame: Buffer.from([9]), timestamp: 30 },
    ];
    let offset = encodeMetaFrame(sourceFrames.length).length;
    const sourceOffsets: number[] = [];
    const encodedFrames = sourceFrames.map(({ frame, timestamp }) => {
      sourceOffsets.push(offset);
      const record = encodeRecord(frame, timestamp);
      offset += record.length;
      return record;
    });
    const sourceBytes = Buffer.concat([encodeMetaFrame(sourceFrames.length), ...encodedFrames]);
    writeFileSync(sourcePath, compressed ? gzipSync(sourceBytes) : sourceBytes);

    const manifest = await splitCapturePromise({
      sourcePath,
      outputDirectory,
      gameId: "fm-2023",
      sourceRevision: "source-rev-1",
      lapWindows: [
        { lapId: "lap-1", lapNumber: 0, startByteOffset: sourceOffsets[1]!, frameCount: 2 },
        { lapId: "lap-2", lapNumber: 2, startByteOffset: sourceOffsets[3]!, frameCount: 1 },
      ],
    });

    expect(manifest.sourceRecordCount).toBe(sourceFrames.length);
    expect(manifest.chunks.find((chunk) => chunk.lapId === "lap-1")?.lapNumber).toBe(0);
    expect(manifest.chunks.reduce((count, chunk) => count + chunk.recordCount, 0)).toBe(sourceFrames.length);
    expect(manifest.chunks.filter(({ kind }) => kind === "lap").map(({ lapId, recordCount }) => [lapId, recordCount])).toEqual([
      ["lap-1", 2],
      ["lap-2", 1],
    ]);
    for (const chunk of manifest.chunks) {
      const outputRecords = await readChunkRecords(manifest, outputDirectory, chunk);
      expect(outputRecords.filter((record) => record.kind === "frame").slice(0, chunk.recordCount).map((record) => record.kind === "frame" ? [record.frame, record.frameTimeMs] : null)).toEqual(
        sourceFrames.slice(chunk.sourceStart, chunk.sourceEnd).map(({ frame, timestamp }) => [frame, timestamp]),
      );
      if (chunk.trailingContextFrameCount === 1) {
        const context = outputRecords.at(-1);
        expect(context?.kind === "frame" ? context.frame : null).toEqual(sourceFrames[chunk.sourceEnd]!.frame);
      }
    }
  }
});

test("a lap artifact begins with full sparse checkpoint even when source window begins with a delta", async () => {
  const root = directory();
  const sourcePath = join(root, "sparse.bin");
  const outputDirectory = join(root, "staged");
  const header = encodeMetaFrame(2);
  const first = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
  LMU_SOURCE_FRAME_MAGIC.copy(first);
  const second = Buffer.from(first);
  second[second.length - 1] = 1;
  const sourceEncoder = new SparseCaptureEncoder("lmu");
  const firstEncoded = sourceEncoder.encode(first, header.length);
  const firstRecord = encodeRecord(firstEncoded);
  const secondOffset = header.length + firstRecord.length;
  const secondEncoded = sourceEncoder.encode(second, secondOffset);
  expect(isLmuSparseFrame(secondEncoded)).toBe(true);
  writeFileSync(sourcePath, Buffer.concat([header, firstRecord, encodeRecord(secondEncoded, 42)]));

  const manifest = await splitCapturePromise({
    sourcePath,
    outputDirectory,
    gameId: "lmu",
    sourceRevision: "source-rev-2",
    lapWindows: [{ lapId: "lap-2", lapNumber: 2, startByteOffset: secondOffset, frameCount: 1 }],
  });
  const lapChunk = manifest.chunks.find(({ lapId }) => lapId === "lap-2");
  expect(lapChunk).toBeDefined();
  const records = await readChunkRecords(manifest, outputDirectory, lapChunk!);
  const lapFrames = records.filter((record) => record.kind === "frame");
  expect(lapFrames).toHaveLength(1);
  expect(lapFrames[0]?.kind === "frame" ? lapFrames[0].frame : null).toEqual(second);
  expect(lapFrames[0]?.kind === "frame" ? isLmuSparseFrame(lapFrames[0].frame) : true).toBe(false);
  expect(lapFrames[0]?.kind === "frame" ? lapFrames[0].frameTimeMs : undefined).toBe(42);
});
test("duplicates one trailing context frame without transferring ownership", async () => {
  const root = directory();
  const sourcePath = join(root, "context.bin");
  const outputDirectory = join(root, "staged");
  const sourceFrames = [
    { frame: Buffer.from([1, 2]), timestamp: undefined },
    { frame: Buffer.from([3, 4]), timestamp: 42 },
  ];
  let offset = encodeMetaFrame(sourceFrames.length).length;
  const sourceOffsets: number[] = [];
  const sourceRecords = sourceFrames.map(({ frame, timestamp }) => {
    sourceOffsets.push(offset);
    const encoded = encodeRecord(frame, timestamp);
    offset += encoded.length;
    return encoded;
  });
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(sourceFrames.length), ...sourceRecords]));

  const manifest = await splitCapturePromise({
    sourcePath,
    outputDirectory,
    gameId: "fm-2023",
    sourceRevision: "context-rev",
    lapWindows: [
      { lapId: "lap-1", lapNumber: 1, startByteOffset: sourceOffsets[0]!, frameCount: 1 },
      { lapId: "lap-2", lapNumber: 2, startByteOffset: sourceOffsets[1]!, frameCount: 1 },
    ],
  });
  const firstChunk = manifest.chunks.find(({ lapId }) => lapId === "lap-1")!;
  const secondChunk = manifest.chunks.find(({ lapId }) => lapId === "lap-2")!;
  const firstFrames = (await readChunkRecords(manifest, outputDirectory, firstChunk))
    .filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
  const secondFrames = (await readChunkRecords(manifest, outputDirectory, secondChunk))
    .filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");

  expect(firstChunk.ownedFrameCount).toBe(1);
  expect(firstChunk.trailingContextFrameCount).toBe(1);
  expect(firstChunk.recordCount).toBe(1);
  expect(firstFrames.map(({ frame, frameTimeMs }) => [frame, frameTimeMs])).toEqual([
    [sourceFrames[0]!.frame, undefined],
    [sourceFrames[1]!.frame, 42],
  ]);
  expect(firstChunk.ownedFrameByteOffset).toBe(firstFrames[0]!.offset);
  expect(secondChunk.ownedFrameCount).toBe(1);
  expect(secondChunk.recordCount).toBe(1);
  expect(secondFrames.map(({ frame, frameTimeMs }) => [frame, frameTimeMs])).toEqual([[sourceFrames[1]!.frame, 42]]);
});

test("writes versioned game parser checkpoint before first lap frame", async () => {
  const root = directory();
  const sourcePath = join(root, "checkpoint.bin");
  const outputDirectory = join(root, "staged");
  const frame = Buffer.from([7, 8, 9]);
  const header = encodeMetaFrame(1);
  writeFileSync(sourcePath, Buffer.concat([header, encodeRecord(frame)]));
  const checkpoint = Uint8Array.of(4, 5, 6);

  const manifest = await splitCapturePromise({
    sourcePath,
    outputDirectory,
    gameId: "ac-evo",
    sourceRevision: "checkpoint-rev",
    lapWindows: [{
      lapId: "lap-1",
      lapNumber: 1,
      startByteOffset: header.length,
      frameCount: 1,
      parserCheckpoint: checkpoint,
    }],
  });
  const chunk = manifest.chunks.find(({ lapId }) => lapId === "lap-1")!;
  const records = await readChunkRecords(manifest, outputDirectory, chunk);

  expect(records[0]?.kind).toBe("parser-bootstrap");
  if (records[0]?.kind === "parser-bootstrap") {
    expect(records[0].gameId).toBe("ac-evo");
    expect(records[0].formatVersion).toBe(1);
    expect(records[0].payload).toEqual(Buffer.from(checkpoint));
  }
  expect(chunk.parserBootstrapHash).toMatch(/^[0-9a-f]{64}$/);
  expect(records.find((record) => record.kind === "frame")?.offset).toBe(chunk.ownedFrameByteOffset);
});

test("does not claim context frames outside the next detector-owned window", async () => {
  const root = directory();
  const sourcePath = join(root, "unowned-context.bin");
  const outputDirectory = join(root, "staged");
  const sourceFrames = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
  let offset = encodeMetaFrame(sourceFrames.length).length;
  const sourceOffsets: number[] = [];
  const sourceRecords = sourceFrames.map((frame) => {
    sourceOffsets.push(offset);
    const encoded = encodeRecord(frame);
    offset += encoded.length;
    return encoded;
  });
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(sourceFrames.length), ...sourceRecords]));

  const manifest = await splitCapturePromise({
    sourcePath,
    outputDirectory,
    gameId: "fm-2023",
    sourceRevision: "unowned-context-rev",
    lapWindows: [
      { lapId: "lap-1", lapNumber: 1, startByteOffset: sourceOffsets[0]!, frameCount: 1 },
      { lapId: "lap-2", lapNumber: 2, startByteOffset: sourceOffsets[2]!, frameCount: 1 },
    ],
  });
  const firstChunk = manifest.chunks.find(({ lapId }) => lapId === "lap-1")!;
  const firstFrames = (await readChunkRecords(manifest, outputDirectory, firstChunk))
    .filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");

  expect(firstChunk.trailingContextFrameCount).toBe(0);
  expect(firstChunk.ownedFrameCount).toBe(1);
  expect(firstFrames.map(({ frame }) => frame)).toEqual([sourceFrames[0]]);
});

test("duplicates delayed-finish context from auxiliary source tail", async () => {
  const root = directory();
  const sourcePath = join(root, "delayed-tail.bin");
  const outputDirectory = join(root, "staged");
  const frames = [Buffer.from([1]), Buffer.from([2])];
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(2), ...frames.map((frame) => encodeRecord(frame))]));
  const manifest = await splitCapturePromise({
    sourcePath, outputDirectory, gameId: "fm-2023", sourceRevision: "tail-rev",
    lapWindows: [{ lapId: "lap-1", lapNumber: 1, startByteOffset: encodeMetaFrame(2).length, frameCount: 1, trailingContextFrameCount: 1 }],
  });
  const chunk = manifest.chunks.find(({ lapId }) => lapId === "lap-1")!;
  const decoded = (await readChunkRecords(manifest, outputDirectory, chunk))
    .filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
  expect(chunk.ownedFrameCount).toBe(1);
  expect(chunk.trailingContextFrameCount).toBe(1);
  expect(decoded.map(({ frame }) => frame)).toEqual(frames);
});

test("prepares parser checkpoints from continuous source state before each owned window", async () => {
  const root = directory();
  const sourcePath = join(root, "window-checkpoints.bin");
  const frames = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
  let offset = encodeMetaFrame(frames.length).length;
  const frameOffsets: number[] = [];
  const records = frames.map((frame) => {
    frameOffsets.push(offset);
    const record = encodeRecord(frame);
    offset += record.length;
    return record;
  });
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(frames.length), ...records, encodeSparseCaptureFormatFrame()]));
  const source = { rawFile: sourcePath, source: null, gameId: "f1-2025" as const, carId: "", trackId: "" };
  const isState = (value: unknown): value is { sum: number } =>
    typeof value === "object" && value !== null && "sum" in value && typeof value.sum === "number";
  const game = {
    id: "f1-2025",
    appendsDelayedFinishFrame: true,
    createParserState: () => ({ sum: 0 }),
    captureParserCheckpoint(state) {
      if (!isState(state)) throw new Error("missing fake parser state");
      return new TextEncoder().encode(String(state.sum));
    },
    restoreParserCheckpoint(_state, payload) {
      return { sum: Number(new TextDecoder().decode(payload)) };
    },
    tryParse(frame, state) {
      if (!isState(state)) throw new Error("missing fake parser state");
      state.sum += frame[0] ?? 0;
      return null;
    },
  } satisfies Pick<ServerGameAdapter, "id" | "appendsDelayedFinishFrame" | "createParserState" |
    "captureParserCheckpoint" | "restoreParserCheckpoint" | "tryParse">;

  const windows = await prepareLapWindowsForSplit(source, [
    { lapId: "lap-1", lapNumber: 1, startByteOffset: frameOffsets[1]!, frameCount: 2 },
    { lapId: "lap-2", lapNumber: 2, startByteOffset: frameOffsets[2]!, frameCount: 1 },
  ], game);

  expect(windows.map(({ frameCount }) => frameCount)).toEqual([1, 1]);
  expect(windows.map(({ trailingContextFrameCount }) => trailingContextFrameCount)).toEqual([1, 1]);
  expect(windows.map(({ parserCheckpoint }) => new TextDecoder().decode(parserCheckpoint))).toEqual(["1", "3"]);
});

test("normalizes shared detector frames for stateless ACC windows", async () => {
  const root = directory();
  const sourcePath = join(root, "acc-overlap.bin");
  const frames = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
  let offset = encodeMetaFrame(frames.length).length;
  const frameOffsets: number[] = [];
  const records = frames.map((frame) => {
    frameOffsets.push(offset);
    const record = encodeRecord(frame);
    offset += record.length;
    return record;
  });
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(frames.length), ...records, encodeSparseCaptureFormatFrame()]));
  const game = {
    id: "acc",
    appendsDelayedFinishFrame: true,
    createParserState: () => null,
    tryParse: () => null,
  } satisfies Pick<ServerGameAdapter, "id" | "appendsDelayedFinishFrame" | "createParserState" | "tryParse">;

  const windows = await prepareLapWindowsForSplit(
    { rawFile: sourcePath, source: null, gameId: "acc", carId: "", trackId: "" },
    [
      { lapId: "lap-1", lapNumber: 1, startByteOffset: frameOffsets[0]!, frameCount: 2 },
      { lapId: "lap-2", lapNumber: 2, startByteOffset: frameOffsets[1]!, frameCount: 2 },
    ],
    game,
  );

  expect(windows.map(({ frameCount }) => frameCount)).toEqual([1, 2]);
  expect(windows.map(({ trailingContextFrameCount }) => trailingContextFrameCount)).toEqual([1, 1]);
});

test("worker stages and verifies a parser-bootstrap lap artifact", async () => {
  const root = directory();
  const sourcePath = join(root, "worker-source.bin");
  const outputDirectory = join(root, "worker-staged");
  const header = encodeMetaFrame(1);
  writeFileSync(sourcePath, Buffer.concat([header, encodeRecord(Buffer.from([4, 5, 6]))]));
  const progress: number[] = [];

  const manifest = await runSplitWorker({
    jobId: "worker-job",
    attemptId: "1",
    sourceRevision: "worker-rev",
    operation: "split",
    gameId: "ac-evo",
    source: { path: sourcePath, revision: "worker-rev" },
    outputDirectory,
    lapWindows: [{
      lapId: "lap-1",
      lapNumber: 1,
      startByteOffset: header.length,
      frameCount: 1,
      parserCheckpoint: Uint8Array.of(4, 5, 6),
    }],
  }, ({ sequence }) => progress.push(sequence));
  const chunk = manifest.chunks.find(({ lapId }) => lapId === "lap-1")!;
  const records = await readChunkRecords(manifest, outputDirectory, chunk);

  expect(progress.length).toBeGreaterThan(0);
  expect(chunk.parserBootstrapHash).toMatch(/^[0-9a-f]{64}$/);
  expect(records[0]?.kind).toBe("parser-bootstrap");
  expect(records.find((record) => record.kind === "frame")?.offset).toBe(chunk.ownedFrameByteOffset);
});

test("rejects detector overlap larger than one shared frame", async () => {
  const root = directory();
  const sourcePath = join(root, "large-overlap.bin");
  const frames = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
  let offset = encodeMetaFrame(frames.length).length;
  const frameOffsets: number[] = [];
  const records = frames.map((frame) => {
    frameOffsets.push(offset);
    const record = encodeRecord(frame);
    offset += record.length;
    return record;
  });
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(frames.length), ...records, encodeSparseCaptureFormatFrame()]));
  const game = {
    id: "acc",
    appendsDelayedFinishFrame: false,
    createParserState: () => null,
    tryParse: () => null,
  } satisfies Pick<ServerGameAdapter, "id" | "appendsDelayedFinishFrame" | "createParserState" | "tryParse">;

  await expect(prepareLapWindowsForSplit(
    { rawFile: sourcePath, source: null, gameId: "acc", carId: "", trackId: "" },
    [
      { lapId: "lap-1", lapNumber: 1, startByteOffset: frameOffsets[0]!, frameCount: 3 },
      { lapId: "lap-2", lapNumber: 2, startByteOffset: frameOffsets[1]!, frameCount: 2 },
    ],
    game,
  )).rejects.toThrow("overlap beyond one shared frame");
});

test("direct plain and gzip invocation normalizes a shared sparse boundary exactly once", async () => {
  for (const compressed of [false, true]) {
    const root = directory();
    const sourcePath = join(root, compressed ? "shared.bin.gz" : "shared.bin");
    const outputDirectory = join(root, "bundle");
    const frames = Array.from({ length: 3 }, (_, i) => {
      const frame = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
      LMU_SOURCE_FRAME_MAGIC.copy(frame);
      frame[frame.length - 1] = i;
      return frame;
    });
    const encoder = new SparseCaptureEncoder("lmu");
    let offset = encodeMetaFrame(3).length;
    const offsets: number[] = [];
    const records = frames.map((frame, index) => {
      offsets.push(offset);
      const encoded = encodeRecord(encoder.encode(frame, offset), index === 1 ? 0 : undefined);
      offset += encoded.length;
      return encoded;
    });
    const bytes = Buffer.concat([encodeMetaFrame(3), ...records]);
    writeFileSync(sourcePath, compressed ? gzipSync(bytes) : bytes);
    const manifest = await splitCapturePromise({
      sourcePath, outputDirectory, gameId: "lmu", sourceRevision: "direct-shared",
      lapWindows: [
        { lapId: "first", lapNumber: 1, startByteOffset: offsets[0]!, frameCount: 2 },
        { lapId: "second", lapNumber: 2, startByteOffset: offsets[1]!, frameCount: 2 },
      ],
    });
    const [first, second] = manifest.chunks;
    expect(first!.ownedFrameCount).toBe(1);
    expect(first!.trailingContextFrameCount).toBe(1);
    expect(second!.ownedFrameCount).toBe(2);
    expect(manifest.sourceRecordCount).toBe(3);
    const firstFrames = (await readChunkRecords(manifest, outputDirectory, first!)).filter((record) => record.kind === "frame");
    const secondFrames = (await readChunkRecords(manifest, outputDirectory, second!)).filter((record) => record.kind === "frame");
    expect(firstFrames.map(({ frame, frameTimeMs }) => [frame, frameTimeMs])).toEqual([[frames[0], undefined], [frames[1], 0]]);
    expect(secondFrames.map(({ frame, frameTimeMs }) => [frame, frameTimeMs])).toEqual([[frames[1], 0], [frames[2], undefined]]);
  }
});
test("split preserves delayed completion through context wrappers but not across reset or EOF", async () => {
  for (const suffix of ["completion", "reset", "eof"] as const) {
    const root = directory();
    const sourcePath = join(root, "source.bin");
    const outputDirectory = join(root, "staged");
    const owned = Buffer.from([21, 22]), completion = Buffer.from([31, 32]), next = Buffer.from([41, 42]);
    const ownedOffset = encodeMetaFrame(2).length + encodeSparseCaptureFormatFrame().length;
    const ownedBytes = encodeRecord(owned);
    const completionBytes = encodeRecord(completion);
    const source = Buffer.concat([
      encodeMetaFrame(2), encodeSparseCaptureFormatFrame(), ownedBytes,
      ...(suffix === "completion" ? [encodeSegmentContextFrame(), completionBytes, encodeSegmentContextEndFrame()] :
        suffix === "reset" ? [encodeSegmentContextFrame(), encodeSegmentContextEndFrame(), encodeSegmentBoundaryFrame(), encodeRecord(next)] :
          [encodeSegmentContextFrame(), encodeSegmentContextEndFrame()]),
    ]);
    writeFileSync(sourcePath, source);
    const manifest = await splitCapturePromise({
      sourcePath, outputDirectory, gameId: "fm-2023", sourceRevision: suffix,
      lapWindows: [{ lapId: "lap", lapNumber: 1, startByteOffset: ownedOffset, frameCount: 1, trailingContextFrameCount: 1 }],
    });
    const chunk = manifest.chunks.find(({ lapId }) => lapId === "lap")!;
    const records = await readChunkRecords(manifest, outputDirectory, chunk);
    const frames = records.filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
    expect(frames.map(({ frame }) => frame)).toEqual(suffix === "completion" ? [owned, completion] : [owned]);
    expect(chunk.trailingContextFrameCount).toBe(suffix === "completion" ? 1 : 0);
  }
});
test("wrapped sparse completion remains duplicate while context-end resets auxiliary encoder", async () => {
  const root = directory();
  const sourcePath = join(root, "wrapped-lmu.bin");
  const outputDirectory = join(root, "staged");
  const makeFrame = (lastByte: number) => {
    const frame = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
    LMU_SOURCE_FRAME_MAGIC.copy(frame);
    frame[frame.length - 1] = lastByte;
    return frame;
  };
  const owned = makeFrame(1), completion = makeFrame(2), following = makeFrame(3);
  const encoder = new SparseCaptureEncoder("lmu");
  const records: Buffer[] = [encodeMetaFrame(3), encodeSparseCaptureFormatFrame()];
  let offset = records.reduce((sum, part) => sum + part.length, 0);
  const ownedOffset = offset;
  const appendFrame = (frame: Buffer) => {
    const encoded = encodeRecord(encoder.encode(frame, offset));
    records.push(encoded);
    offset += encoded.length;
  };
  appendFrame(owned);
  records.push(encodeSegmentContextFrame());
  offset += 16;
  appendFrame(completion);
  records.push(encodeSegmentContextEndFrame());
  offset += 16;
  encoder.reset();
  appendFrame(following);
  writeFileSync(sourcePath, Buffer.concat(records));

  const manifest = await splitCapturePromise({
    sourcePath, outputDirectory, gameId: "lmu", sourceRevision: "wrapped-sparse",
    lapWindows: [{ lapId: "lap", lapNumber: 1, startByteOffset: ownedOffset, frameCount: 1, trailingContextFrameCount: 1 }],
  });
  const lap = manifest.chunks.find(({ lapId }) => lapId === "lap")!;
  const auxiliary = manifest.chunks.filter(({ kind }) => kind === "auxiliary");
  const lapFrames = (await readChunkRecords(manifest, outputDirectory, lap))
    .filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
  const auxiliaryFrames = (await Promise.all(auxiliary.map((chunk) => readChunkRecords(manifest, outputDirectory, chunk))))
    .flat().filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
  expect(lapFrames.map(({ frame }) => frame)).toEqual([owned, completion]);
  expect(auxiliaryFrames.map(({ frame }) => frame)).toEqual([completion, following]);
  expect((await readRecords(sourcePath)).filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame")
    .map(({ frame }) => frame)).toEqual([owned, completion, following]);
});

