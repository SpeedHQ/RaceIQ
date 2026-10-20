import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { decodeF1CaptureFrame, encodeF1CaptureFrame } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeParserBootstrapFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextFrame,
  encodeSegmentContextEndFrame,
  encodeSparseCaptureFormatFrame,
  type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import { getServerGame } from "../games/registry";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "./source-loader";

type LapIndex = { lapId: number; rawByteOffset: number | null; rawFrameCount: number | null };
export type F1MotionLapRewrite = { lapId: number; expectedRawByteOffset: number; expectedRawFrameCount: number; rawByteOffset: number; rawFrameCount: number };

/** A channel-only rewrite: every record, timestamp, marker and lap frame count survives. */
export async function rewriteF1MotionCapture(
  source: SessionCaptureSource,
  indexes: readonly LapIndex[],
  outputPath: string,
  gzip: boolean,
): Promise<{ changed: boolean; lapIndexes: F1MotionLapRewrite[] }> {
  if (source.gameId !== "f1-2025") throw new Error("F1 compaction requires an F1 2025 capture");
  const game = getServerGame(source.gameId);
  const encoder = new SparseCaptureEncoder(source.gameId, true);
  const starts = new Map<number, LapIndex[]>();
  const lapIndexes: F1MotionLapRewrite[] = [];
  const endOrdinals: number[] = [];
  for (const index of indexes) {
    if (index.rawByteOffset === null) continue;
    if (!Number.isSafeInteger(index.rawByteOffset) || index.rawByteOffset < 0 || !Number.isSafeInteger(index.rawFrameCount) || index.rawFrameCount! <= 0)
      throw new Error(`Invalid lap index ${index.lapId}`);
    const entries = starts.get(index.rawByteOffset) ?? [];
    entries.push(index);
    starts.set(index.rawByteOffset, entries);
  }
  const rawPath = `${outputPath}.raw.tmp`;
  const compressedPath = `${outputPath}.tmp`;
  let fd: number | null = null;
  let rawCreated = false;
  let compressedCreated = false;
  let published = false;
  let offset = 0;
  let frames = 0;
  let changed = false;
  const write = (bytes: Buffer, position?: number) => {
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd!, bytes, written, bytes.length - written, position === undefined ? null : position + written);
      if (!count) throw new Error("Capture write made no progress");
      written += count;
    }
    if (position === undefined) offset += bytes.length;
  };
  const normalize = (record: SessionCaptureRecord): Buffer | null => {
    if (record.kind === "frame") return decodeF1CaptureFrame(encodeF1CaptureFrame(record.frame));
    if (record.kind !== "parser-bootstrap") return null;
    if (record.gameId !== source.gameId || !game.restoreParserCheckpoint || !game.captureParserCheckpoint) throw new Error("Unsupported F1 parser bootstrap");
    const state = game.restoreParserCheckpoint(game.createParserState(), record.payload);
    const payload = game.captureParserCheckpoint(state);
    if (!payload) throw new Error("F1 parser checkpoint could not be encoded");
    return Buffer.from(payload);
  };
  // Already-reduced captures must not require a decompressed staging copy:
  // low disk space must not prevent marking them complete or later retention.
  const inspectedStarts = new Map<number, number>();
  let inspectedFrames = 0;
  for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
    if (starts.has(record.offset)) inspectedStarts.set(record.offset, inspectedFrames);
    if (record.kind === "frame") {
      if (!normalize(record)!.equals(record.frame)) {
        changed = true;
        break;
      }
      inspectedFrames++;
    } else if (record.kind === "parser-bootstrap" && !normalize(record)!.equals(record.payload)) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    for (const [start, entries] of starts) {
      const ordinal = inspectedStarts.get(start);
      if (ordinal === undefined || entries.some((entry) => ordinal + entry.rawFrameCount! > inspectedFrames)) throw new Error("Lap window is outside the capture");
    }
    return { changed: false, lapIndexes: [] };
  }
  try {
    fd = openSync(rawPath, "wx");
    rawCreated = true;
    write(encodeMetaFrame());
    write(encodeSparseCaptureFormatFrame());
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
      for (const index of starts.get(record.offset) ?? []) {
        lapIndexes.push({ lapId: index.lapId, expectedRawByteOffset: index.rawByteOffset!, expectedRawFrameCount: index.rawFrameCount!, rawByteOffset: offset, rawFrameCount: index.rawFrameCount! });
        endOrdinals.push(frames + index.rawFrameCount!);
      }
      starts.delete(record.offset);
      if (record.kind === "frame") {
        // The encoder applies the audited projection; replay validation checks it below.
        const encoded = encoder.encode(record.frame, offset);
        write(encodeFrameLength(encoded.length, record.frameTimeMs));
        write(encoded);
        frames++;
      } else {
        encoder.reset();
        if (record.kind === "parser-bootstrap") {
          const payload = normalize(record)!;
          write(encodeParserBootstrapFrame(record.gameId, payload));
        } else if (record.kind === "segment-boundary") write(encodeSegmentBoundaryFrame());
        else if (record.kind === "segment-context") write(encodeSegmentContextFrame());
        else write(encodeSegmentContextEndFrame());
      }
    }
    if (starts.size || endOrdinals.some((end) => end > frames)) throw new Error("Lap window is outside the capture");
    write(encodeMetaFrame(frames), 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (gzip) {
      const compressed = await open(compressedPath, "wx");
      compressedCreated = true;
      try {
        await pipeline(createReadStream(rawPath), createGzip(), createWriteStream(compressedPath, { fd: compressed.fd, autoClose: false }));
        await compressed.sync();
      } finally {
        await compressed.close();
      }
      await link(compressedPath, outputPath);
      published = true;
      await rm(compressedPath);
      compressedCreated = false;
    } else {
      await link(rawPath, outputPath);
      published = true;
    }
    const directory = await open(dirname(outputPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }

    // Compare native bytes after the explicit projection AND actual emitted telemetry.
    // Neither sampled outputs nor a mock parser can validate a destructive migration.
    const output = iterateSessionCaptureRecordsFromSource({ ...source, rawFile: outputPath, artifact: undefined, captureFormatVersion: 1 }, { strict: true });
    let beforeState = game.createParserState();
    let afterState = game.createParserState();
    let verifiedFrames = 0;
    const expectedStarts = new Map(lapIndexes.map((index) => [index.expectedRawByteOffset, index.rawByteOffset]));
    try {
      for await (const before of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
        const next = await output.next();
        if (next.done || next.value.kind !== before.kind) throw new Error("Compaction changed record ordering");
        const after = next.value;
        const start = expectedStarts.get(before.offset);
        if (start !== undefined && start !== after.offset) throw new Error("Compaction lap offset validation failed");
        if (before.kind === "frame" && after.kind === "frame") {
          if (before.frameTimeMs !== after.frameTimeMs || !normalize(before)!.equals(after.frame)) throw new Error("Compaction changed retained source bytes or timestamps");
          const beforePacket = game.tryParse(before.frame, beforeState);
          const afterPacket = game.tryParse(after.frame, afterState);
          if (JSON.stringify(beforePacket) !== JSON.stringify(afterPacket)) throw new Error("Compaction changed emitted telemetry");
          verifiedFrames++;
        } else if (before.kind === "parser-bootstrap" && after.kind === "parser-bootstrap") {
          if (after.gameId !== before.gameId || !normalize(before)!.equals(after.payload)) throw new Error("Compaction changed retained checkpoint state");
          beforeState = game.restoreParserCheckpoint!(beforeState, before.payload);
          afterState = game.restoreParserCheckpoint!(afterState, after.payload);
        } else if (before.kind === "segment-boundary") {
          beforeState = game.createParserState();
          afterState = game.createParserState();
        }
      }
      if (!(await output.next()).done || verifiedFrames !== frames) throw new Error("Compaction changed record count");
    } finally {
      await output.return(undefined);
    }
    return { changed: true, lapIndexes };
  } catch (error) {
    if (published) await rm(outputPath, { force: true });
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
    if (rawCreated) await rm(rawPath, { force: true });
    if (compressedCreated) await rm(compressedPath, { force: true });
  }
}
