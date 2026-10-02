/**
 * Packs ACC / AC Evo shared-memory triplets into a single buffer for session .bin storage.
 * Allows reprocessSession to re-parse these games uniformly alongside UDP games.
 *
 * Format: [magic(4 LE)] [carOrdinal(4 LE)] [trackOrdinal(4 LE)]
 *         [physLen(4 LE)] [physics] [graphLen(4 LE)] [graphics] [staticLen(4 LE)] [static]
 */

export const ACC_PACKED_MAGIC  = 0x50434341; // "ACCP" as uint32 LE
export const ACEVO_PACKED_MAGIC = 0x50454341; // "ACEP" as uint32 LE

export function packTriplet(
  magic: number,
  carOrdinal: number,
  trackOrdinal: number,
  physics: Buffer,
  graphics: Buffer,
  staticData: Buffer,
): Buffer {
  const total = 4 + 4 + 4 + 4 + physics.length + 4 + graphics.length + 4 + staticData.length;
  const buf = Buffer.allocUnsafe(total);
  let off = 0;
  buf.writeUInt32LE(magic, off); off += 4;
  buf.writeInt32LE(carOrdinal, off); off += 4;
  buf.writeInt32LE(trackOrdinal, off); off += 4;
  buf.writeUInt32LE(physics.length, off); off += 4;
  physics.copy(buf, off); off += physics.length;
  buf.writeUInt32LE(graphics.length, off); off += 4;
  graphics.copy(buf, off); off += graphics.length;
  buf.writeUInt32LE(staticData.length, off); off += 4;
  staticData.copy(buf, off);
  return buf;
}

export function unpackTriplet(buf: Buffer): {
  carOrdinal: number;
  trackOrdinal: number;
  physics: Buffer;
  graphics: Buffer;
  staticData: Buffer;
} | null {
  if (buf.length < 16) return null;
  let off = 4; // skip magic
  const carOrdinal = buf.readInt32LE(off); off += 4;
  const trackOrdinal = buf.readInt32LE(off); off += 4;
  const physLen = buf.readUInt32LE(off); off += 4;
  if (off + physLen + 8 > buf.length) return null;
  const physics = buf.subarray(off, off + physLen); off += physLen;
  const graphLen = buf.readUInt32LE(off); off += 4;
  if (off + graphLen + 4 > buf.length) return null;
  const graphics = buf.subarray(off, off + graphLen); off += graphLen;
  const staticLen = buf.readUInt32LE(off); off += 4;
  if (off + staticLen > buf.length) return null;
  const staticData = buf.subarray(off, off + staticLen);
  return { carOrdinal, trackOrdinal, physics, graphics, staticData };
}
