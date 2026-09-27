import { readSourceFrameHeader, SOURCE_FRAME_HEADER_SIZE, SOURCE_FRAME_MAGIC } from "../games/iracing/source-frame-codec";

// RQSD v1: [magic 4][version 1][checkpoint distance 4][source length 4]
// [32-byte block bitmap][changed blocks]. Checkpoints are unmodified source frames.
export const GENERIC_SPARSE_MAGIC = Buffer.from("RQSD", "ascii");
const BLOCK_BYTES = 32;
const HEADER_BYTES = 13;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function isGenericSparseFrame(payload: Buffer): boolean {
  return payload.length >= 4 && payload.subarray(0, 4).equals(GENERIC_SPARSE_MAGIC);
}

/** Stable packet identity; dynamic timestamps, counters and values are not identity. */
export function genericFrameIdentity(frame: Buffer): string | null {
  if (frame.length >= SOURCE_FRAME_HEADER_SIZE && frame.readUInt32LE(0) === SOURCE_FRAME_MAGIC) {
    const header = readSourceFrameHeader(frame);
    return header && header.payloadLength + SOURCE_FRAME_HEADER_SIZE === frame.length
      ? `iracing:${header.schemaVersion}:${header.frameType}:${frame.length}` : null;
  }
  if (frame.length >= 29 && frame.readUInt16LE(0) === 2025) {
    return `f1:${frame.subarray(0, 7).toString("hex")}:${frame.subarray(7, 15).toString("hex")}:${frame.length}`;
  }
  return frame.length >= 324 && frame.length <= 400 ? `fm:${frame.length}` : null;
}

export function encodeGenericSparseFrame(frame: Buffer, previous: Buffer, backDistance: number): Buffer {
  if (!genericFrameIdentity(frame) || genericFrameIdentity(frame) !== genericFrameIdentity(previous) ||
      frame.length === 0 || frame.length > MAX_FRAME_BYTES || previous.length !== frame.length ||
      !Number.isInteger(backDistance) || backDistance <= 0 || backDistance > 0xffffffff) {
    throw new Error("Invalid generic sparse frame");
  }
  const blocks = Math.ceil(frame.length / BLOCK_BYTES);
  const bitmap = Buffer.alloc(Math.ceil(blocks / 8));
  let size = HEADER_BYTES + bitmap.length;
  for (let block = 0; block < blocks; block++) {
    const start = block * BLOCK_BYTES;
    const end = Math.min(start + BLOCK_BYTES, frame.length);
    if (frame.compare(previous, start, end, start, end) !== 0) {
      bitmap[block >> 3] |= 1 << (block & 7);
      size += end - start;
    }
  }
  const payload = Buffer.allocUnsafe(size);
  GENERIC_SPARSE_MAGIC.copy(payload);
  payload[4] = 1;
  payload.writeUInt32LE(backDistance, 5);
  payload.writeUInt32LE(frame.length, 9);
  bitmap.copy(payload, HEADER_BYTES);
  let at = HEADER_BYTES + bitmap.length;
  for (let block = 0; block < blocks; block++) {
    if (!(bitmap[block >> 3]! & (1 << (block & 7)))) continue;
    const start = block * BLOCK_BYTES;
    const end = Math.min(start + BLOCK_BYTES, frame.length);
    frame.copy(payload, at, start, end);
    at += end - start;
  }
  return payload;
}

export function decodeGenericSparseFrame(payload: Buffer, previous: Buffer): Buffer {
  if (!isGenericSparseFrame(payload) || payload.length < HEADER_BYTES || payload[4] !== 1) {
    throw new Error("Invalid generic sparse version or header");
  }
  const length = payload.readUInt32LE(9);
  if (length === 0 || length > MAX_FRAME_BYTES || previous.length !== length || !genericFrameIdentity(previous)) {
    throw new Error("Invalid generic sparse length or checkpoint");
  }
  const blocks = Math.ceil(length / BLOCK_BYTES);
  const bitmapLength = Math.ceil(blocks / 8);
  if (payload.length < HEADER_BYTES + bitmapLength) throw new Error("Truncated generic sparse bitmap");
  const bitmap = payload.subarray(HEADER_BYTES, HEADER_BYTES + bitmapLength);
  const usedBits = blocks & 7;
  if (usedBits && (bitmap[bitmapLength - 1]! & ~((1 << usedBits) - 1))) {
    throw new Error("Invalid generic sparse bitmap tail");
  }
  let expected = HEADER_BYTES + bitmapLength;
  for (let block = 0; block < blocks; block++) {
    if (bitmap[block >> 3]! & (1 << (block & 7))) expected += Math.min(BLOCK_BYTES, length - block * BLOCK_BYTES);
  }
  if (expected !== payload.length) throw new Error("Invalid generic sparse payload length");
  const frame = Buffer.from(previous);
  let at = HEADER_BYTES + bitmapLength;
  for (let block = 0; block < blocks; block++) {
    if (!(bitmap[block >> 3]! & (1 << (block & 7)))) continue;
    const start = block * BLOCK_BYTES;
    const bytes = Math.min(BLOCK_BYTES, length - start);
    payload.copy(frame, start, at, at + bytes);
    at += bytes;
  }
  if (genericFrameIdentity(frame) !== genericFrameIdentity(previous)) throw new Error("Generic sparse identity mismatch");
  return frame;
}
