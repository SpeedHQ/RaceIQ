import { gzip, gzipSync, gunzip, gunzipSync } from "zlib";
import { promisify } from "util";

/** Magic length value that marks a session-capture meta frame. */
export const META_FRAME_MAGIC = 0xffffffff;
export const META_FRAME_PAYLOAD_BYTES = 4;
export const META_FRAME_BYTES = 8 + META_FRAME_PAYLOAD_BYTES;

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
  if (bytes.length < 8) return 0;
  const view = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.readUInt32LE(0) !== META_FRAME_MAGIC) return 0;
  return 8 + view.readUInt32LE(4);
}

/** Legacy importer behavior: recorder magic always reserves the fixed 12-byte header. */
export function readRecorderFrameStreamStart(bytes: Buffer): number {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === META_FRAME_MAGIC
    ? META_FRAME_BYTES
    : 0;
}

/** Iterate complete length-prefixed telemetry frames, stopping at truncated tail. */
export function* iterateSessionFrames(
  bytes: Buffer,
  offset = readRecorderFrameStreamStart(bytes),
): Generator<Buffer> {
  while (offset + 4 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    offset += 4;
    if (length <= 0 || offset + length > bytes.length) break;
    yield bytes.subarray(offset, offset + length);
    offset += length;
  }
}
export function sessionFrameAt(bytes: Buffer, offset: number): Buffer | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const length = bytes.readUInt32LE(offset);
  if (length <= 0 || offset + 4 + length > bytes.length) return null;
  return bytes.subarray(offset + 4, offset + 4 + length);
}

export function advanceSessionFrames(
  bytes: Buffer,
  offset: number,
  count: number,
): number {
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
  return Buffer.from(gzipSync(bytes));
}

export async function gzipBuffer(bytes: Buffer): Promise<Buffer> {
  return Buffer.from(await gzipAsync(bytes));
}

export function gunzipBufferSync(bytes: Buffer): Buffer {
  return Buffer.from(gunzipSync(bytes));
}

export async function gunzipBuffer(bytes: Buffer): Promise<Buffer> {
  return Buffer.from(await gunzipAsync(bytes));
}

export function decompressIfGzipSync(bytes: Buffer): Buffer {
  return isGzip(bytes) ? gunzipBufferSync(bytes) : bytes;
}

export async function decompressIfGzip(bytes: Buffer): Promise<Buffer> {
  return isGzip(bytes) ? gunzipBuffer(bytes) : bytes;
}
