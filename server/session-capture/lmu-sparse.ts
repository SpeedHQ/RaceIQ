import { LMU_SOURCE_FRAME_HEADER_SIZE, LMU_SOURCE_FRAME_V2_SIZE } from "../games/lmu/source-frame";

export const LMU_SPARSE_MAGIC = Buffer.from("LMSD", "ascii");
const SHARED_MEMORY_BYTES = 324_820;
const BLOCK_BYTES = 64;
const BITMAP_BYTES = Math.ceil(SHARED_MEMORY_BYTES / BLOCK_BYTES / 8);
const PREFIX_BYTES = 8 + LMU_SOURCE_FRAME_HEADER_SIZE + BITMAP_BYTES;

export function isLmuSparseFrame(payload: Buffer): boolean {
  return payload.length >= 4 && payload.subarray(0, 4).equals(LMU_SPARSE_MAGIC);
}

export function encodeLmuSparseFrame(frame: Buffer, previous: Buffer, backDistance: number): Buffer {
  if (frame.length !== LMU_SOURCE_FRAME_V2_SIZE || previous.length !== frame.length) throw new Error("Invalid LMU v2 frame size");
  if (!Number.isInteger(backDistance) || backDistance < 0 || backDistance > 0xffffffff) throw new Error("Invalid LMU sparse back-distance");
  const bitmap = Buffer.alloc(BITMAP_BYTES);
  const changed: Buffer[] = [];
  for (let block = 0; block * BLOCK_BYTES < SHARED_MEMORY_BYTES; block++) {
    const start = LMU_SOURCE_FRAME_HEADER_SIZE + block * BLOCK_BYTES;
    const end = Math.min(LMU_SOURCE_FRAME_V2_SIZE, start + BLOCK_BYTES);
    if (frame.compare(previous, start, end, start, end) !== 0) {
      bitmap[block >> 3] |= 1 << (block & 7);
      changed.push(frame.subarray(start, end));
    }
  }
  const payload = Buffer.allocUnsafe(PREFIX_BYTES + changed.reduce((sum, part) => sum + part.length, 0));
  LMU_SPARSE_MAGIC.copy(payload, 0);
  payload.writeUInt32LE(backDistance, 4);
  frame.copy(payload, 8, 0, LMU_SOURCE_FRAME_HEADER_SIZE);
  bitmap.copy(payload, 8 + LMU_SOURCE_FRAME_HEADER_SIZE);
  let offset = PREFIX_BYTES;
  for (const part of changed) { part.copy(payload, offset); offset += part.length; }
  return payload;
}

export function decodeLmuSparseFrame(payload: Buffer, previous: Buffer): Buffer {
  if (!isLmuSparseFrame(payload) || payload.length < PREFIX_BYTES || previous.length !== LMU_SOURCE_FRAME_V2_SIZE) throw new Error("Invalid LMU sparse frame");
  const bitmapOffset = 8 + LMU_SOURCE_FRAME_HEADER_SIZE;
  const bitmap = payload.subarray(bitmapOffset, bitmapOffset + BITMAP_BYTES);
  const blockCount = Math.ceil(SHARED_MEMORY_BYTES / BLOCK_BYTES);
  const usedBits = blockCount & 7;
  if (usedBits && (bitmap[BITMAP_BYTES - 1] & ~((1 << usedBits) - 1)) !== 0) throw new Error("Invalid LMU sparse bitmap");
  let expected = PREFIX_BYTES;
  for (let block = 0; block < blockCount; block++) if (bitmap[block >> 3] & (1 << (block & 7))) expected += Math.min(BLOCK_BYTES, SHARED_MEMORY_BYTES - block * BLOCK_BYTES);
  if (payload.length !== expected) throw new Error("Invalid LMU sparse payload length");
  const frame = Buffer.from(previous);
  payload.copy(frame, 0, 8, 8 + LMU_SOURCE_FRAME_HEADER_SIZE);
  let offset = PREFIX_BYTES;
  for (let block = 0; block < blockCount; block++) {
    if (!(bitmap[block >> 3] & (1 << (block & 7)))) continue;
    const start = LMU_SOURCE_FRAME_HEADER_SIZE + block * BLOCK_BYTES;
    const length = Math.min(BLOCK_BYTES, SHARED_MEMORY_BYTES - block * BLOCK_BYTES);
    payload.copy(frame, start, offset, offset + length);
    offset += length;
  }
  return frame;
}
