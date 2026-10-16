import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename, join } from "node:path";
import { createGunzip } from "node:zlib";
import { Effect, Schema } from "effect";
import {
  encodeMetaFrame, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame, encodeSparseCaptureFormatFrame,
  encodeSegmentContextEndFrame, encodeSegmentContextFrame, iterateSessionCaptureRecordsAsync,
  type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { MAX_CAPTURE_MANIFEST_BYTES, ChunkSchema, ManifestSchema, PublishedManifestSchema, type Chunk, type PublishedManifest, type GameId, type LapWindow, type Progress } from "./contract";
import { openCaptureArchive } from "./archive";
import { encodeStreamingFrame, matchesNativeRecord } from "./streaming";
const STATEFUL_GAME_IDS = new Set<GameId>(["ac-evo", "f1-2025", "iracing"]);
const MAX_AUXILIARY_MEMBER_BYTES = 64 * 1024 * 1024;


export class SplitFailure extends Error {
  readonly _tag = "SplitFailure";
  readonly code: "IO" | "FORMAT" | "VERIFY" | "GAME" | "SOURCE_REVISION" | "PROTOCOL" | "UNKNOWN";
  constructor(code: "IO" | "FORMAT" | "VERIFY" | "GAME" | "SOURCE_REVISION" | "PROTOCOL" | "UNKNOWN", message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
export interface SplitOptions {
  readonly sourcePath: string;
  readonly outputDirectory: string;
  readonly gameId: GameId;
  readonly sourceRevision: string;
  readonly lapWindows: readonly LapWindow[];
  readonly onProgress?: (progress: Progress) => void;
}

const parseError = (e: unknown) => {
  const ioCode = e instanceof Error && "code" in e && typeof e.code === "string" && e.code.startsWith("E");
  return new SplitFailure(
    ioCode ? "IO" : "FORMAT",
    e instanceof Error ? e.message : String(e),
    { cause: e },
  );
};
const markerBytes = (record: SessionCaptureRecord): Buffer | null => {
  switch (record.kind) {
    case "segment-boundary": return encodeSegmentBoundaryFrame();
    case "segment-context": return encodeSegmentContextFrame();
    case "segment-context-end": return encodeSegmentContextEndFrame();
    case "parser-bootstrap": return encodeParserBootstrapFrame(record.gameId, record.payload);
    default: return null;
  }
};
const source = async function* (path: string, compressed: boolean, signal: AbortSignal, consumed?: { bytes: number }): AsyncGenerator<Uint8Array> {
  const input = createReadStream(path);
  const stream = compressed ? input.pipe(createGunzip()) : input;
  const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error("Split interrupted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw signal.reason;
      if (consumed) consumed.bytes += chunk.byteLength;
      yield chunk as Buffer;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    input.destroy();
    if (compressed) stream.destroy();
  }
};

/** Split decoded capture records in one streaming pass. */
export const splitCapture = (options: SplitOptions): Effect.Effect<PublishedManifest, SplitFailure> => Effect.tryPromise({
  try: async (signal) => {
    const fileInfo = await stat(options.sourcePath);
    const probe = await open(options.sourcePath, "r");
    const magic = Buffer.alloc(2);
    try { const { bytesRead } = await probe.read(magic, 0, 2, 0); if (bytesRead < 2) throw new SplitFailure("FORMAT", "capture is too short"); }
    finally { await probe.close(); }
    const compressed = magic[0] === 0x1f && magic[1] === 0x8b;
    await mkdir(options.outputDirectory, { recursive: true });
    const windows = options.lapWindows;
    const lapIds = new Set<string>();
    let prior = -1;
    for (const window of windows) {
      if (!window.lapId || lapIds.has(window.lapId) || !Number.isSafeInteger(window.startByteOffset) || window.startByteOffset <= prior ||
        !Number.isSafeInteger(window.frameCount) || window.frameCount < 1 || !Number.isSafeInteger(window.lapNumber) || window.lapNumber < 0) {
        throw new SplitFailure("FORMAT", "lap windows must have unique identities, ordered offsets, and valid frame counts");
      }
      if (STATEFUL_GAME_IDS.has(options.gameId) && window.parserCheckpoint === undefined) {
        throw new SplitFailure("GAME", `parser checkpoint required for ${options.gameId} lap ${window.lapId}`);
      }
      if (window.parserCheckpoint !== undefined &&
          (!STATEFUL_GAME_IDS.has(options.gameId) || !(window.parserCheckpoint instanceof Uint8Array) || window.parserCheckpoint.byteLength === 0)) {
        throw new SplitFailure("GAME", `invalid parser checkpoint for ${options.gameId} lap ${window.lapId}`);
      }
      const trailingContextFrameCount = window.trailingContextFrameCount ?? 0;
      if (!Number.isSafeInteger(trailingContextFrameCount) || trailingContextFrameCount < 0 || trailingContextFrameCount > 1) {
        throw new SplitFailure("FORMAT", "at most one trailing context frame is supported");
      }
      lapIds.add(window.lapId); prior = window.startByteOffset;
    }
    const chunks: Chunk[] = [];
    const lapChunk = new Map<string, number>();
    let windowIndex = 0, remaining = 0, windowEnd = -1, ordinal = 0, frameCount = 0, outputBytes = 0, decompressedBytes = 0;
    let completedLapArtifacts = 0;
    let activeKey: string | null = null;
    let activeHandle: FileHandle | null = null;
    let activeChunkIndex = -1, activeCount = 0, activeLength = 0;
    let activeFirstTimestamp: number | undefined, activeLastTimestamp: number | undefined;
    let pendingTrailingLap: LapWindow | null = null;
    const encoder = new SparseCaptureEncoder(options.gameId);
    const pendingWrites: Buffer[] = [];
    let pendingWriteBytes = 0;
    const flushWrites = async (): Promise<void> => {
      if (!activeHandle) throw new SplitFailure("IO", "No active capture file");
      while (pendingWrites.length > 0) {
        signal.throwIfAborted();
        const { bytesWritten } = await activeHandle.writev(pendingWrites);
        if (bytesWritten === 0) throw new SplitFailure("IO", "Capture writer made no write progress");
        let consumed = 0;
        let remaining = bytesWritten;
        while (consumed < pendingWrites.length && remaining >= pendingWrites[consumed]!.length) {
          remaining -= pendingWrites[consumed]!.length;
          consumed++;
        }
        if (consumed > 0) {
          pendingWrites.copyWithin(0, consumed);
          pendingWrites.length -= consumed;
        }
        if (remaining > 0) pendingWrites[0] = pendingWrites[0]!.subarray(remaining);
      }
      pendingWriteBytes = 0;
    };
    const writeCaptureBytes = async (bytes: Buffer): Promise<void> => {
      signal.throwIfAborted();
      if (!activeHandle) throw new SplitFailure("IO", "No active capture file");
      if (bytes.length === 0) return;
      pendingWrites.push(bytes);
      pendingWriteBytes += bytes.length;
      // Bound retained source buffers without copying payloads or issuing one write per prefix.
      if (pendingWrites.length >= 128 || pendingWriteBytes >= 1024 * 1024) await flushWrites();
    };
    const closeGroup = async () => {
      if (!activeHandle) return;
      const handle = activeHandle;
      try {
        await flushWrites();
        await handle.sync();
      } finally {
        activeHandle = null;
        await handle.close();
      }
      const chunk = chunks[activeChunkIndex]!;
      chunks[activeChunkIndex] = Schema.decodeSync(ChunkSchema)({
        ...chunk,
        byteLength: chunk.byteLength + activeLength,
        recordCount: chunk.recordCount + activeCount,
        sourceEnd: ordinal,
        sourceByteEnd: decompressedBytes,
        ...(chunk.recordCount === 0 && activeFirstTimestamp !== undefined ? { firstTimestamp: activeFirstTimestamp } : {}),
        lastTimestamp: activeLastTimestamp,
      });
      if (chunk.kind === "lap") completedLapArtifacts++;
      activeKey = null; activeCount = activeLength = 0;
    };
    const beginGroup = async (lap: LapWindow | null, offset: number, timestamp?: number) => {
      const key = lap ? `lap:${lap.lapId}` : "aux";
      if (activeKey === key && (lap !== null || activeLength < MAX_AUXILIARY_MEMBER_BYTES)) return;
      await closeGroup();
      let index = lap ? lapChunk.get(lap.lapId) : undefined;
      const isNewChunk = index === undefined;
      if (isNewChunk) {
        const name = `${String(chunks.length).padStart(6, "0")}-${lap ? `lap-${lap.lapNumber}` : "aux"}.bin`;
        index = chunks.length;
        const parserBootstrapHash = lap?.parserCheckpoint
          ? createHash("sha256").update(lap.parserCheckpoint).digest("hex")
          : undefined;
        chunks.push({
          id: name,
          kind: lap ? "lap" : "auxiliary",
          ...(lap ? {
            lapId: lap.lapId, lapNumber: lap.lapNumber, ownedFrameCount: lap.frameCount,
            trailingContextFrameCount: 0, ...(parserBootstrapHash ? { parserBootstrapHash } : {}),
          } : {}),
          path: name, byteLength: 0, firstOrdinal: ordinal, recordCount: 0, sourceStart: ordinal,
          sourceEnd: ordinal, sourceByteStart: offset, sourceByteEnd: offset,
          ...(timestamp === undefined ? {} : { firstTimestamp: timestamp }),
        });
        if (lap) lapChunk.set(lap.lapId, index);
      }
      activeChunkIndex = index!; activeKey = key;
      activeFirstTimestamp = timestamp; activeLastTimestamp = timestamp;
      if (!isNewChunk) throw new SplitFailure("FORMAT", "A completed lap file cannot be reopened");
      activeHandle = await open(join(options.outputDirectory, chunks[index!]!.path), "wx");
      const header = Buffer.concat([encodeMetaFrame(0), encodeSparseCaptureFormatFrame()]);
      try { await writeCaptureBytes(header); }
      catch (error) { throw new SplitFailure("IO", error instanceof Error ? error.message : String(error), { cause: error }); }
      activeLength += header.length; outputBytes += header.length;
      if (lap?.parserCheckpoint) {
        const bootstrap = encodeParserBootstrapFrame(options.gameId, lap.parserCheckpoint);
        try { await writeCaptureBytes(bootstrap); }
        catch (error) { throw new SplitFailure("IO", error instanceof Error ? error.message : String(error), { cause: error }); }
        activeLength += bootstrap.length; outputBytes += bootstrap.length;
      }
      if (lap) encoder.requestCheckpoint(); else encoder.reset();
    };
    try {
      for await (const record of iterateSessionCaptureRecordsAsync(source(options.sourcePath, compressed, signal), { strict: true })) {
        if (signal.aborted) throw signal.reason;
        if (remaining && record.kind !== "frame") {
          throw new SplitFailure("FORMAT", "lap window crosses a parser or segment boundary");
        }
        const nextWindow = windows[windowIndex + 1];
        if (remaining && record.kind === "frame" && nextWindow && record.offset >= nextWindow.startByteOffset) {
          const currentWindow = windows[windowIndex]!;
          if (record.offset !== nextWindow.startByteOffset || remaining !== 1 || currentWindow.frameCount < 2) {
            throw new SplitFailure("FORMAT", "lap windows overlap beyond one shared frame");
          }
          const chunkIndex = lapChunk.get(currentWindow.lapId)!;
          chunks[chunkIndex] = { ...chunks[chunkIndex]!, ownedFrameCount: currentWindow.frameCount - 1 };
          remaining = 0;
          windowEnd = record.offset;
          pendingTrailingLap = currentWindow;
          windowIndex++;
        }
        if (pendingTrailingLap) {
          const trailingLap = pendingTrailingLap;
          pendingTrailingLap = null;
          const isNextWindowStart = windowIndex < windows.length && record.offset === windows[windowIndex]!.startByteOffset;
          const isAuxiliaryContext = trailingLap.trailingContextFrameCount === 1;
          if (record.kind === "frame" && activeChunkIndex === lapChunk.get(trailingLap.lapId) &&
              (isNextWindowStart || isAuxiliaryContext)) {
            const chunkIndex = lapChunk.get(trailingLap.lapId)!;
            const chunk = chunks[chunkIndex]!;
            const recordOffset = chunk.byteLength + activeLength;
            const [prefix, encoded] = encodeStreamingFrame(encoder, record.frame, recordOffset, record.frameTimeMs);
            try { await writeCaptureBytes(prefix); await writeCaptureBytes(encoded); }
            catch (error) { throw new SplitFailure("IO", error instanceof Error ? error.message : String(error), { cause: error }); }
            activeLength += prefix.length + encoded.length;
            outputBytes += prefix.length + encoded.length;
            activeLastTimestamp = record.frameTimeMs;
            chunks[chunkIndex] = { ...chunk, trailingContextFrameCount: 1 };
          }
        }
        if (record.kind === "segment-boundary" || record.kind === "segment-context-end" || record.kind === "parser-bootstrap") encoder.reset();
        let lap: LapWindow | null = null;
        if (record.kind === "frame") {
          if (!remaining && windowIndex < windows.length && record.offset > windows[windowIndex]!.startByteOffset) {
            throw new SplitFailure("FORMAT", "lap window start is not aligned to a source frame");
          }
          if (!remaining && windowIndex < windows.length && record.offset === windows[windowIndex]!.startByteOffset) {
            if (record.offset < windowEnd) throw new SplitFailure("FORMAT", "lap windows overlap");
            remaining = windows[windowIndex]!.frameCount;
          }
          if (remaining) lap = windows[windowIndex]!;
        }
        await beginGroup(lap, record.offset, record.kind === "frame" ? record.frameTimeMs : undefined);
        let data: Buffer | null;
        if (record.kind === "frame") {
          const recordOffset = chunks[activeChunkIndex]!.byteLength + activeLength;
          const chunk = chunks[activeChunkIndex]!;
          if (lap && chunk.ownedFrameByteOffset === undefined) {
            chunks[activeChunkIndex] = { ...chunk, ownedFrameByteOffset: recordOffset };
          }
          const [prefix, encoded] = encodeStreamingFrame(encoder, record.frame, recordOffset, record.frameTimeMs);
          try { await writeCaptureBytes(prefix); await writeCaptureBytes(encoded); }
          catch (error) { throw new SplitFailure("IO", error instanceof Error ? error.message : String(error), { cause: error }); }
          data = null;
          activeLength += prefix.length + encoded.length; outputBytes += prefix.length + encoded.length;
        } else data = markerBytes(record);
        if (data) {
          try { await writeCaptureBytes(data); }
          catch (error) { throw new SplitFailure("IO", error instanceof Error ? error.message : String(error), { cause: error }); }
          activeLength += data.length; outputBytes += data.length;
        }
        activeCount++;
        if (record.kind === "frame") {
          activeLastTimestamp = record.frameTimeMs;
          ordinal++;
          frameCount++;
          if (remaining && --remaining === 0) {
            windowEnd = record.endOffset;
            pendingTrailingLap = lap;
            windowIndex++;
          }
        } else ordinal++;
        decompressedBytes = record.endOffset;
        options.onProgress?.({
          phase: "write", records: ordinal, frames: frameCount, bytes: outputBytes,
          completedLapArtifacts, totalLapArtifacts: windows.length,
        });
      }
      await closeGroup();
      if (windowIndex !== windows.length || remaining) throw new SplitFailure("FORMAT", "lap window extends past source");
      const manifest = Schema.decodeSync(ManifestSchema)({
        version: 3, gameId: options.gameId, sourceRevision: options.sourceRevision,
        sourceByteLength: fileInfo.size, sourceRecordCount: ordinal, chunks,
      });
      const manifestJSON = JSON.stringify(manifest);
      if (Buffer.byteLength(manifestJSON) > MAX_CAPTURE_MANIFEST_BYTES) throw new SplitFailure("VERIFY", "Capture manifest exceeds 16 MiB limit");
      await Effect.runPromise(verifyManifest(
        options.sourcePath, options.outputDirectory, manifest,
        { sourceRevision: options.sourceRevision, gameId: options.gameId },
        (records, frames, bytes) => options.onProgress?.({
          phase: "verify", records, frames, bytes, completedLapArtifacts, totalLapArtifacts: windows.length,
        }),
      ), { signal });
      signal.throwIfAborted();
      const manifestHandle = await open(join(options.outputDirectory, "manifest.json"), "wx");
      try {
        await manifestHandle.writeFile(manifestJSON);
        await manifestHandle.sync();
      } finally { await manifestHandle.close(); }
      return manifest;
    } catch (error) {
      // beginGroup assigns the handle through a closure; control-flow narrowing misses that write.
      const failedHandle = activeHandle as FileHandle | null;
      await failedHandle?.close();
      throw error instanceof SplitFailure ? error : parseError(error);
    }
  },
  catch: (e) => e instanceof SplitFailure ? e : new SplitFailure("IO", e instanceof Error ? e.message : String(e), { cause: e }),
});

export const verifyManifest = (
  sourcePath: string,
  outputDirectory: string,
  input: unknown,
  expected?: { sourceRevision?: string; gameId?: GameId },
  onProgress?: (records: number, frames: number, bytes: number) => void,
): Effect.Effect<PublishedManifest, SplitFailure> => Schema.decodeUnknownEffect(PublishedManifestSchema)(input).pipe(
  Effect.mapError((error) => new SplitFailure("VERIFY", "invalid manifest", { cause: error })),
  Effect.flatMap((manifest) => Effect.tryPromise({
    try: async (signal) => {
    if (expected?.sourceRevision !== undefined && manifest.sourceRevision !== expected.sourceRevision) {
      throw new SplitFailure("VERIFY", "source revision mismatch");
    }
    if (expected?.gameId !== undefined && manifest.gameId !== expected.gameId) {
      throw new SplitFailure("VERIFY", "game id mismatch");
    }
    const sourceInfo = await stat(sourcePath);
    if (sourceInfo.size !== manifest.sourceByteLength) throw new SplitFailure("VERIFY", "source byte length mismatch");
    const probe = await open(sourcePath, "r");
    const magic = Buffer.alloc(2);
    try {
      const { bytesRead } = await probe.read(magic, 0, 2, 0);
      if (bytesRead < 2) throw new SplitFailure("VERIFY", "source is too short");
    } finally { await probe.close(); }
    const consumed = { bytes: 0 };
    const records = iterateSessionCaptureRecordsAsync(source(sourcePath, magic[0] === 0x1f && magic[1] === 0x8b, signal, consumed), { strict: true });
    const iterator = records[Symbol.asyncIterator]();
    try {
      let sourceLookahead = await iterator.next();
      let verifiedRecords = 0, verifiedFrames = 0;
      const pendingSourceRecords: SessionCaptureRecord[] = [];
      const readSourceRecord = async (): Promise<SessionCaptureRecord | null> => {
        signal.throwIfAborted();
        if (pendingSourceRecords.length > 0) return pendingSourceRecords.shift()!;
        if (sourceLookahead.done) return null;
        const value = sourceLookahead.value;
        sourceLookahead = await iterator.next();
        signal.throwIfAborted();
        verifiedRecords++;
        if (value.kind === "frame") verifiedFrames++;
        onProgress?.(verifiedRecords, verifiedFrames, value.endOffset);
        return value;
      };
      let expectedOrdinal = 0;
      const seenLapIds = new Set<string>();
      const archive = manifest.version === 4 ? await openCaptureArchive(join(outputDirectory, manifest.archiveFile), manifest) : null;
      for (const chunk of [...manifest.chunks].sort((a, b) => a.firstOrdinal - b.firstOrdinal)) {
        const chunkPath = "entryName" in chunk ? chunk.entryName : chunk.path;
        if ((manifest.version === 3 && basename(chunkPath) !== chunkPath) || chunk.recordCount < 1 ||
          chunk.sourceEnd - chunk.sourceStart !== chunk.recordCount || chunk.sourceStart !== chunk.firstOrdinal ||
          chunk.sourceByteEnd <= chunk.sourceByteStart) {
          throw new SplitFailure("VERIFY", `invalid chunk range: ${chunkPath}`);
        }
        if (chunk.kind === "lap") {
          if (!chunk.lapId || chunk.lapNumber === undefined || seenLapIds.has(chunk.lapId) ||
              chunk.ownedFrameByteOffset === undefined || chunk.ownedFrameCount === undefined ||
              (STATEFUL_GAME_IDS.has(manifest.gameId) !== (chunk.parserBootstrapHash !== undefined)) ||
              (chunk.parserBootstrapHash !== undefined && !/^[0-9a-f]{64}$/.test(chunk.parserBootstrapHash)) ||
              ![0, 1].includes(chunk.trailingContextFrameCount ?? 0)) {
            throw new SplitFailure("VERIFY", `invalid or duplicate lap chunk: ${chunkPath}`);
          }
          seenLapIds.add(chunk.lapId);
        } else if (chunk.lapId !== undefined || chunk.lapNumber !== undefined ||
          chunk.ownedFrameByteOffset !== undefined || chunk.ownedFrameCount !== undefined ||
          chunk.parserBootstrapHash !== undefined || chunk.trailingContextFrameCount !== undefined) {
          throw new SplitFailure("VERIFY", `auxiliary chunk has lap metadata: ${chunkPath}`);
        }
        if (chunk.firstOrdinal !== expectedOrdinal) throw new SplitFailure("VERIFY", `ordinal gap or overlap at ${expectedOrdinal}`);
        const outputPath = manifest.version === 4 ? join(outputDirectory, manifest.archiveFile) : join(outputDirectory, chunkPath);
        const outputStream = archive ? Readable.from(archive.readEntry(chunkPath)) : createReadStream(outputPath);
        const outputIterator = iterateSessionCaptureRecordsAsync(outputStream, { strict: true })[Symbol.asyncIterator]();
        try {
          let outputNext = await outputIterator.next();
          if (chunk.parserBootstrapHash !== undefined) {
            if (outputNext.done || outputNext.value.kind !== "parser-bootstrap" ||
                outputNext.value.gameId !== manifest.gameId ||
                createHash("sha256").update(outputNext.value.payload).digest("hex") !== chunk.parserBootstrapHash) {
              throw new SplitFailure("VERIFY", `parser bootstrap mismatch: ${chunkPath}`);
            }
            outputNext = await outputIterator.next();
          }
          let chunkRecordCount = 0;
          let chunkFrameCount = 0;
          let firstFrameOffset: number | undefined;
          while (true) {
            const original = await readSourceRecord();
            if (!original) break;
            if (original.offset >= chunk.sourceByteEnd) {
              pendingSourceRecords.unshift(original);
              break;
            }
            if (original.offset < chunk.sourceByteStart || outputNext.done ||
                !matchesNativeRecord(outputNext.value, original)) {
              throw new SplitFailure("VERIFY", `record or timestamp mismatch at ordinal ${expectedOrdinal}`);
            }
            if (original.kind === "frame") {
              chunkFrameCount++;
              firstFrameOffset ??= outputNext.value.offset;
            }
            chunkRecordCount++;
            expectedOrdinal++;
            outputNext = await outputIterator.next();
          }
          if (chunkRecordCount !== chunk.recordCount || expectedOrdinal !== chunk.sourceEnd) {
            throw new SplitFailure("VERIFY", `record count mismatch: ${chunkPath}`);
          }
          if (chunk.kind === "lap" &&
              (chunkFrameCount !== chunk.ownedFrameCount || firstFrameOffset !== chunk.ownedFrameByteOffset)) {
            throw new SplitFailure("VERIFY", `owned frame window mismatch: ${chunkPath}`);
          }
          for (let index = 0; index < (chunk.trailingContextFrameCount ?? 0); index++) {
            const original = await readSourceRecord();
            if (!original || original.kind !== "frame" || original.offset !== chunk.sourceByteEnd ||
                outputNext.done || outputNext.value.kind !== "frame" ||
                !matchesNativeRecord(outputNext.value, original)) {
              throw new SplitFailure("VERIFY", `trailing context mismatch: ${chunkPath}`);
            }
            pendingSourceRecords.unshift(original);
            outputNext = await outputIterator.next();
          }
          if (!outputNext.done) throw new SplitFailure("VERIFY", `unexpected output record: ${chunkPath}`);
        } finally {
          await outputIterator.return?.(0);
        }
        if (manifest.version === 3 && (await stat(outputPath)).size !== chunk.byteLength) {
          throw new SplitFailure("VERIFY", `byte length mismatch: ${chunkPath}`);
        }
      }
      if (expectedOrdinal !== manifest.sourceRecordCount || pendingSourceRecords.length !== 0 || !sourceLookahead.done) {
        throw new SplitFailure("VERIFY", "source record count mismatch");
      }
      if (!sourceLookahead.done || sourceLookahead.value !== consumed.bytes) {
        throw new SplitFailure("VERIFY", "source bytes were not completely consumed");
      }
    } finally {
      await iterator.return?.(0);
    }
    return manifest;
  },
  catch: (e) => e instanceof SplitFailure ? e : new SplitFailure("VERIFY", e instanceof Error ? e.message : String(e), { cause: e }),
    })),
);

export const splitCapturePromise = (options: SplitOptions): Promise<PublishedManifest> => Effect.runPromise(splitCapture(options));
export { runSplitWorker } from "./client";
export { prepareSplitWindows, type DetectedLapWindow, type SplitPreparationCodec, type SplitPreparationInput } from "./prepare";
export * from "./contract";
export * from "./archive";
export * from "./streaming";
export * from "./streaming-state";
export * from "./streaming-host";
export * from "./protocol";
export * from "./live-worker";
