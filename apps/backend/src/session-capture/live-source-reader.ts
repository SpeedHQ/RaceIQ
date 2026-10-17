import { open, stat, type FileHandle } from "node:fs/promises";
import {
  META_FRAME_MAGIC, iterateSessionCaptureRecordsAsync, readFramePrefix,
  type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import { isGenericSparseFrame } from "@raceiq/capture-formats/session/generic-sparse";
import { isKunosSparseFrame } from "@raceiq/capture-formats/session/kunos-sparse";
import { isLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";

const MAX_CHECKPOINT_SCAN_BYTES = 8 * 1024 * 1024;
export const MAX_CHECKPOINT_FRAMES = 128;

async function readAt(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

/** Read a bounded prefix without lending descriptor ownership to a stream. End is exclusive. */
export async function* readSourceRange(file: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new RangeError("Invalid canonical source range");
  let offset = start;
  while (offset < end) {
    const bytes = await readAt(file, offset, Math.min(64 * 1024, end - offset));
    if (bytes.byteLength === 0) throw new Error("Canonical source prefix was truncated");
    offset += bytes.byteLength;
    yield bytes;
  }
}

/** Find full sparse checkpoint that can decode replayOffset without reading session prefix. */
export async function findReplayCheckpoint(file: FileHandle, replayOffset: number, durableEnd: number): Promise<number> {
  let frameOffset = replayOffset;
  let skippedMetadata = 0;
  while (frameOffset < durableEnd) {
    const prefixBytes = await readAt(file, frameOffset, 8);
    if (prefixBytes.length < 4) throw new Error("Truncated live source before durable watermark");
    if (prefixBytes.readUInt32LE(0) === META_FRAME_MAGIC) {
      if (prefixBytes.length < 8) throw new Error("Truncated live source metadata header");
      const metadataBytes = prefixBytes.readUInt32LE(4);
      if (metadataBytes > 16 * 1024 * 1024 || frameOffset + 8 + metadataBytes > durableEnd) throw new Error("Invalid live source metadata range");
      frameOffset += 8 + metadataBytes;
      skippedMetadata += 8 + metadataBytes;
      if (skippedMetadata > MAX_CHECKPOINT_SCAN_BYTES) throw new Error("Live source metadata exceeds bounded checkpoint scan");
      continue;
    }
    const probe = await readAt(file, frameOffset, 25);
    const prefix = readFramePrefix(probe, 0);
    if (!prefix || prefix.length < 4 || frameOffset + prefix.prefixBytes + prefix.length > durableEnd) throw new Error("Invalid live source record at replay watermark");
    const payload = probe.subarray(prefix.prefixBytes, Math.min(probe.length, prefix.prefixBytes + prefix.length));
    const generic = isGenericSparseFrame(payload);
    const kunos = isKunosSparseFrame(payload);
    const lmu = isLmuSparseFrame(payload);
    if (!generic && !kunos && !lmu) return replayOffset;
    if (payload.length < 9) throw new Error("Truncated sparse source checkpoint pointer");
    const distance = payload.readUInt32LE(generic ? 5 : 4);
    const checkpoint = frameOffset - distance;
    if (!distance || checkpoint < 0 || checkpoint >= frameOffset || checkpoint >= durableEnd) throw new Error("Invalid sparse source checkpoint distance");
    const previousPrefix = await readAt(file, checkpoint, 25);
    const decodedPrefix = readFramePrefix(previousPrefix, 0);
    if (!decodedPrefix || decodedPrefix.length < 4 || checkpoint + decodedPrefix.prefixBytes + decodedPrefix.length > frameOffset) throw new Error("Sparse source checkpoint is not a complete native frame");
    const previousPayload = previousPrefix.subarray(decodedPrefix.prefixBytes, Math.min(previousPrefix.length, decodedPrefix.prefixBytes + decodedPrefix.length));
    if (isGenericSparseFrame(previousPayload) || isKunosSparseFrame(previousPayload) || isLmuSparseFrame(previousPayload)) throw new Error("Sparse source checkpoint does not reference a full frame");
    return checkpoint;
  }
  return replayOffset;
}
/** Bounded canonical suffix reader. Keeps one fd identity and uses shared sparse-checkpoint seeking. */
export class LiveCanonicalSourceReader {
  private file: FileHandle | null = null;

  constructor(private readonly path: string, private readonly identity: { device: string; inode: string }) {}

  async readBatch(startOffset: number, endOffset: number, maxBytes: number, maxRecords: number): Promise<{ records: SessionCaptureRecord[]; nextOffset: number }> {
    if (![startOffset, endOffset, maxBytes, maxRecords].every(Number.isSafeInteger) || startOffset < 0 ||
        endOffset < startOffset || maxBytes < 1 || maxRecords < 1) throw new RangeError("Invalid live canonical read range");
    if (startOffset === endOffset) return { records: [], nextOffset: endOffset };
    if (!this.file) {
      this.file = await open(this.path, "r");
    }
    const [opened, named] = await Promise.all([this.file.stat({ bigint: true }), stat(this.path, { bigint: true })]);
    if (!this.identity.device || !this.identity.inode || opened.dev.toString() !== this.identity.device || opened.ino.toString() !== this.identity.inode ||
        named.dev.toString() !== this.identity.device || named.ino.toString() !== this.identity.inode) throw new Error("Live canonical source identity changed");
    if (opened.size < BigInt(endOffset)) throw new Error("Live canonical source prefix is not written");
    const checkpoint = await findReplayCheckpoint(this.file, startOffset, endOffset);
    const records: SessionCaptureRecord[] = [];
    let bytes = 0;
    let nextOffset = startOffset;
    const stream = readSourceRange(this.file, checkpoint, endOffset);
    const iterator = iterateSessionCaptureRecordsAsync(stream, { strict: true })[Symbol.asyncIterator]();
    let scannedFrames = 0;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const record = { ...next.value, offset: next.value.offset + checkpoint, endOffset: next.value.endOffset + checkpoint };
        if (record.endOffset <= startOffset) {
          if (record.kind === "frame" && ++scannedFrames > MAX_CHECKPOINT_FRAMES) throw new Error("Sparse source checkpoint exceeds bounded replay frame scan");
          continue;
        }
        if (record.offset < startOffset) throw new Error("Canonical replay cursor is not on a record boundary");
        const cost = (record.kind === "frame" ? record.frame.byteLength : record.kind === "parser-bootstrap" ? record.payload.byteLength : 16) + 64;
        if (records.length && (records.length >= maxRecords || bytes + cost > maxBytes)) break;
        if (cost > maxBytes) throw new Error("Canonical source record exceeds bounded catch-up batch");
        records.push(record);
        bytes += cost;
        nextOffset = record.endOffset;
        if (records.length >= maxRecords || bytes >= maxBytes) break;
      }
    } finally { await iterator.return?.(0); }
    if (records.length === 0) nextOffset = endOffset;
    return { records, nextOffset };
  }

  async close(): Promise<void> {
    await this.file?.close();
    this.file = null;
  }
}
