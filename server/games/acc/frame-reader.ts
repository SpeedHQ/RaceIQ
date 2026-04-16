import { readFileSync } from "fs";
import { gunzipSync } from "zlib";

const V2_MAGIC = Buffer.from("ACCTEST\0", "ascii");
const V2_HEADER_SIZE = 16; // magic (8) + version (4) + frameCount (4)
const V2_FRAME_HEADER = 5; // type (1) + size (4)

/**
 * Read assembled triplets from a V2 ACC recording (.bin or .bin.gz).
 * @param limit Maximum number of triplets to return (default: all)
 */
export function readAccFrames(filePath: string, limit?: number): { physics: Buffer; graphics: Buffer; staticData: Buffer }[] {
  const raw = readFileSync(filePath);
  const data: Buffer = filePath.endsWith(".gz") ? Buffer.from(gunzipSync(raw)) : Buffer.from(raw);

  if (data.length < 8 || !data.subarray(0, 8).equals(V2_MAGIC)) return [];

  // If frameCount=0 (killed process) and no limit requested, scan to count.
  // If a limit is provided, skip the scan and just iterate until satisfied.
  let frameCount = data.readUInt32LE(12);
  if (frameCount === 0 && limit === undefined && data.length > V2_HEADER_SIZE + 100) {
    let scanOffset = V2_HEADER_SIZE;
    while (scanOffset + V2_FRAME_HEADER <= data.length) {
      const frameType = data.readUInt8(scanOffset);
      if (frameType > 2) break;
      const bufferSize = data.readUInt32LE(scanOffset + 1);
      if (bufferSize > 500000) break;
      if (scanOffset + V2_FRAME_HEADER + bufferSize > data.length) break;
      frameCount++;
      scanOffset += V2_FRAME_HEADER + bufferSize;
    }
  }
  // When a limit is set and frameCount=0, use a large sentinel so the loop
  // runs until the limit is hit or data is exhausted.
  const maxFrameIdx = frameCount === 0 ? Number.MAX_SAFE_INTEGER : frameCount;

  const frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[] = [];
  let lastPhysics = Buffer.alloc(0);
  let lastGraphics = Buffer.alloc(0);
  let lastStatic = Buffer.alloc(0);
  let offset = V2_HEADER_SIZE;
  let frameIdx = 0;

  while (frameIdx < maxFrameIdx && offset + V2_FRAME_HEADER <= data.length) {
    const frameType = data.readUInt8(offset);
    const bufferSize = data.readUInt32LE(offset + 1);
    offset += V2_FRAME_HEADER;
    if (offset + bufferSize > data.length) break;

    const bufferData = Buffer.from(data.subarray(offset, offset + bufferSize));
    offset += bufferSize;

    switch (frameType) {
      case 0: lastPhysics = bufferData; break;
      case 1: lastGraphics = bufferData; break;
      case 2: lastStatic = bufferData; break;
      default: frameIdx++; continue;
    }

    if (frameType === 2 && lastPhysics.length > 0 && lastGraphics.length > 0) {
      frames.push({ physics: lastPhysics, graphics: lastGraphics, staticData: lastStatic });
      if (limit !== undefined && frames.length >= limit) break;
    }

    frameIdx++;
  }

  return frames;
}
