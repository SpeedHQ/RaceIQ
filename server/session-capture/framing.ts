import { gzip, gzipSync, gunzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";

/** Magic length value that marks a session-capture meta frame. */
export const META_FRAME_MAGIC = 0xffffffff;
const META_FRAME_PAYLOAD_BYTES = 4;
export const META_FRAME_BYTES = 8 + META_FRAME_PAYLOAD_BYTES;
export class InvalidSessionFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionFrameError";
  }
}

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

/** Encode recorder byte-identical 12-byte metadata frame. */
export function encodeMetaFrame(totalFrames = 0): Buffer {
  const header = Buffer.allocUnsafe(META_FRAME_BYTES);
  header.writeUInt32LE(META_FRAME_MAGIC, 0);
  header.writeUInt32LE(META_FRAME_PAYLOAD_BYTES, 4);
  header.writeUInt32LE(totalFrames, 8);
  return header;
}

export function encodeFrameLength(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(length, 0);
  return prefix;
}

/** Offset after an optional declared-length meta frame. */
export function readFrameStreamStart(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.readUInt32LE(0) !== META_FRAME_MAGIC) return 0;
  if (view.length < 8) {
    throw new InvalidSessionFrameError("Truncated recorder metadata header at byte 0");
  }
  const payloadLength = view.readUInt32LE(4);
  if (payloadLength !== META_FRAME_PAYLOAD_BYTES) {
    throw new InvalidSessionFrameError(`Invalid recorder metadata payload length ${payloadLength} at byte 0`);
  }
  if (view.length < 8 + payloadLength) {
    throw new InvalidSessionFrameError("Truncated recorder metadata payload at byte 0");
  }
  return 8 + payloadLength;
}

interface SessionFrameRecord {
  /** Byte offset of the record length prefix in the backing byte stream. */
  offset: number;
  frame: Buffer;
}
interface SessionFrameIterationOptions {
  skipMetaFrames?: boolean;
  allowEmptyFrames?: boolean;
  strict?: boolean;
}

/**
 * Iterate complete length-prefixed records, stopping at a truncated tail.
 * Options retain reprocessor behavior; normal imports use strict framing.
 */
export function* iterateSessionFrameRecords(bytes: Buffer, offset?: number, options?: SessionFrameIterationOptions): Generator<SessionFrameRecord> {
  offset ??= readFrameStreamStart(bytes);
  while (offset + 4 <= bytes.length) {
    const frameOffset = offset;
    const length = bytes.readUInt32LE(offset);
    if (options?.skipMetaFrames && length === META_FRAME_MAGIC) {
      if (offset + 8 > bytes.length) {
        if (options.strict) throw new InvalidSessionFrameError(`Truncated meta frame at byte ${offset}`);
        break;
      }
      const payloadLength = bytes.readUInt32LE(offset + 4);
      if (options.strict && payloadLength !== META_FRAME_PAYLOAD_BYTES) {
        throw new InvalidSessionFrameError(`Invalid meta payload length ${payloadLength} at byte ${offset}`);
      }
      if (offset + 8 + payloadLength > bytes.length) {
        if (options.strict) throw new InvalidSessionFrameError(`Truncated meta payload at byte ${offset}`);
        break;
      }
      offset += 8 + payloadLength;
      continue;
    }
    offset += 4;
    if (!options?.allowEmptyFrames && length === 0) {
      if (options?.strict) throw new InvalidSessionFrameError(`Empty frame at byte ${frameOffset}`);
      break;
    }
    if (offset + length > bytes.length) {
      if (options?.strict) throw new InvalidSessionFrameError(`Truncated frame payload at byte ${frameOffset}`);
      break;
    }
    yield {
      offset: frameOffset,
      frame: bytes.subarray(offset, offset + length),
    };
    offset += length;
  }
  if (options?.strict && offset !== bytes.length) {
    throw new InvalidSessionFrameError(`Truncated frame length at byte ${offset}`);
  }
}

/** Iterate strict length-prefixed telemetry frames. Truncated or empty records are invalid. */
export function* iterateSessionFrames(bytes: Buffer, offset?: number): Generator<Buffer> {
  const validateDeclaredCount = offset === undefined;
  offset ??= readFrameStreamStart(bytes);
  const declaredFrameCount = validateDeclaredCount && offset === META_FRAME_BYTES
    ? bytes.readUInt32LE(8)
    : 0;
  let actualFrameCount = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      throw new InvalidSessionFrameError(`Truncated frame length at byte ${offset}`);
    }
    const length = bytes.readUInt32LE(offset);
    if (length === 0) {
      throw new InvalidSessionFrameError(`Empty frame at byte ${offset}`);
    }
    if (offset + 4 + length > bytes.length) {
      throw new InvalidSessionFrameError(`Truncated frame payload at byte ${offset}`);
    }
    actualFrameCount++;
    yield bytes.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  if (declaredFrameCount !== 0 && actualFrameCount !== declaredFrameCount) {
    throw new InvalidSessionFrameError(
      `Recorder metadata declares ${declaredFrameCount} frames, but capture contains ${actualFrameCount}`,
    );
  }
}

/** Count complete records, validating framing and any nonzero leading declaration. */
export function countSessionFrames(bytes: Buffer, offset?: number): number {
  let count = 0;
  for (const _frame of iterateSessionFrames(bytes, offset)) count++;
  return count;
}

export function sessionFrameAt(bytes: Buffer, offset: number): Buffer | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const length = bytes.readUInt32LE(offset);
  if (length <= 0 || offset + 4 + length > bytes.length) return null;
  return bytes.subarray(offset + 4, offset + 4 + length);
}

export function advanceSessionFrames(bytes: Buffer, offset: number, count: number): number {
  let at = offset;
  for (let i = 0; i < count; i++) {
    const frame = sessionFrameAt(bytes, at);
    if (!frame) break;
    at += 4 + frame.length;
  }
  return at;
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function gzipBufferSync(bytes: Buffer): Buffer {
  return gzipSync(bytes);
}

export async function gzipBuffer(bytes: Buffer): Promise<Buffer> {
  return gzipAsync(bytes);
}

export function gunzipBufferSync(bytes: Buffer): Buffer {
  return gunzipSync(bytes);
}

export async function gunzipBuffer(bytes: Buffer): Promise<Buffer> {
  return gunzipAsync(bytes);
}

export function decompressIfGzipSync(bytes: Buffer): Buffer {
  return isGzip(bytes) ? gunzipBufferSync(bytes) : bytes;
}
