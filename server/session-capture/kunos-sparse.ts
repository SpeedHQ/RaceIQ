// KNSD v1: [magic(4)][checkpoint back-distance(4)][frame length(4)]
// [changed 64-byte block bitmap][changed blocks]. A full packed triplet is checkpoint.
export const KUNOS_SPARSE_MAGIC = Buffer.from("KNSD", "ascii");
const BLOCK_BYTES = 64;
const MAX_FRAME_BYTES = 1024 * 1024;

export function isKunosSparseFrame(payload: Buffer): boolean {
  return payload.length >= 4 && payload.subarray(0, 4).equals(KUNOS_SPARSE_MAGIC);
}

export function encodeKunosSparseFrame(frame: Buffer, previous: Buffer, backDistance: number): Buffer {
  if (frame.length === 0 || frame.length > MAX_FRAME_BYTES || previous.length !== frame.length ||
      !Number.isInteger(backDistance) || backDistance <= 0 || backDistance > 0xffffffff) {
    throw new Error("Invalid Kunos sparse frame");
  }
  const blockCount = Math.ceil(frame.length / BLOCK_BYTES);
  const bitmap = Buffer.alloc(Math.ceil(blockCount / 8));
  const changed: Buffer[] = [];
  let payloadSize = 12 + bitmap.length;
  for (let block = 0; block < blockCount; block++) {
    const start = block * BLOCK_BYTES;
    const end = Math.min(start + BLOCK_BYTES, frame.length);
    if (frame.compare(previous, start, end, start, end) !== 0) {
      bitmap[block >> 3] |= 1 << (block & 7);
      changed.push(frame.subarray(start, end));
      payloadSize += end - start;
    }
  }
  const payload = Buffer.allocUnsafe(payloadSize);
  KUNOS_SPARSE_MAGIC.copy(payload, 0);
  payload.writeUInt32LE(backDistance, 4);
  payload.writeUInt32LE(frame.length, 8);
  bitmap.copy(payload, 12);
  let offset = 12 + bitmap.length;
  for (const part of changed) { part.copy(payload, offset); offset += part.length; }
  return payload;
}

export function decodeKunosSparseFrame(payload: Buffer, previous: Buffer): Buffer {
  if (!isKunosSparseFrame(payload) || payload.length < 12) throw new Error("Invalid Kunos sparse frame");
  const length = payload.readUInt32LE(8);
  if (length === 0 || length > MAX_FRAME_BYTES || previous.length !== length) throw new Error("Invalid Kunos sparse length");
  const blockCount = Math.ceil(length / BLOCK_BYTES);
  const bitmapLength = Math.ceil(blockCount / 8);
  if (payload.length < 12 + bitmapLength) throw new Error("Truncated Kunos sparse bitmap");
  const bitmap = payload.subarray(12, 12 + bitmapLength);
  const usedBits = blockCount & 7;
  if (usedBits && (bitmap[bitmapLength - 1]! & ~((1 << usedBits) - 1))) throw new Error("Invalid Kunos sparse bitmap");
  let expected = 12 + bitmapLength;
  for (let block = 0; block < blockCount; block++) {
    if (bitmap[block >> 3]! & (1 << (block & 7))) expected += Math.min(BLOCK_BYTES, length - block * BLOCK_BYTES);
  }
  if (expected !== payload.length) throw new Error("Invalid Kunos sparse payload length");
  const result = Buffer.from(previous);
  let offset = 12 + bitmapLength;
  for (let block = 0; block < blockCount; block++) {
    if (!(bitmap[block >> 3]! & (1 << (block & 7)))) continue;
    const start = block * BLOCK_BYTES;
    const bytes = Math.min(BLOCK_BYTES, length - start);
    payload.copy(result, start, offset, offset + bytes);
    offset += bytes;
  }
  return result;
}
