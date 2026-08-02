import { readFileSync } from "fs";
import { gunzipSync } from "zlib";

const ACC_MAGIC = Buffer.from("ACCTEST\0", "ascii");
const HEADER_SIZE = 16; // magic (8) + version (4) + frameCount (4)
const FRAME_HEADER = 5; // type (1) + size (4)
const SUPPORTED_VERSIONS = new Set([2, 3]);

/**
 * Read assembled triplets from a Kunos recording (.bin or .bin.gz).
 * Supports legacy ACCTEST format versions 2 and 3. Frames are self-describing,
 * so the only difference is the size of the captured graphics buffer:
 *   v2 → 1320 bytes (legacy, isValidLap and tail fields absent)
 *   v3 → 1588 bytes (full ACC SDK v1.8.12 struct)
 * Parser must length-guard reads of tail-of-struct fields.
 * @param limit Maximum number of triplets to return (default: all)
 */
export function readKunosFrames(filePath: string, limit?: number): { physics: Buffer; graphics: Buffer; staticData: Buffer }[] {
  const raw = readFileSync(filePath);
  const data = filePath.endsWith(".gz") ? gunzipSync(raw) : raw;

  if (data.length < HEADER_SIZE || !data.subarray(0, 8).equals(ACC_MAGIC)) return [];
  const version = data.readUInt32LE(8);
  if (!SUPPORTED_VERSIONS.has(version)) {
    console.warn(`[ACC frame-reader] Unsupported recording version ${version} in ${filePath}`);
    return [];
  }

  // A zero count means the recorder process ended before patching the header.
  // Frame lengths already make EOF authoritative, so avoid a redundant full-file
  // scan and read until EOF in that case.
  const frameCount = data.readUInt32LE(12);
  const maxFrameIdx = frameCount === 0 ? Number.MAX_SAFE_INTEGER : frameCount;

  // The writer emits [physics, graphics, static?] per poll, where static
  // frames are deduplicated (only written when the bytes change). A triplet is
  // therefore flushed when the NEXT poll's physics frame arrives (or at EOF),
  // carrying the last-seen static forward across polls that skipped it.
  const frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[] = [];
  let pendingPhysics: Buffer | null = null;
  let pendingGraphics: Buffer | null = null;
  let lastStatic = Buffer.alloc(0);
  let offset = HEADER_SIZE;
  let frameIdx = 0;

  const flush = (): void => {
    if (pendingPhysics && pendingGraphics && lastStatic.length > 0) {
      frames.push({ physics: pendingPhysics, graphics: pendingGraphics, staticData: lastStatic });
    }
    pendingPhysics = null;
    pendingGraphics = null;
  };

  while (frameIdx < maxFrameIdx && offset + FRAME_HEADER <= data.length) {
    const frameType = data.readUInt8(offset);
    const bufferSize = data.readUInt32LE(offset + 1);
    offset += FRAME_HEADER;
    if (offset + bufferSize > data.length) break;

    // Frames are immutable parser inputs. Slices avoid duplicating every frame
    // while retaining the decompressed backing buffer for the result lifetime.
    const bufferData = data.subarray(offset, offset + bufferSize);
    offset += bufferSize;

    switch (frameType) {
      case 0: flush(); pendingPhysics = bufferData; break; // new poll begins
      case 1: pendingGraphics = bufferData; break;
      case 2: lastStatic = bufferData; break;
      default: frameIdx++; continue;
    }

    if (limit !== undefined && frames.length >= limit) return frames;
    frameIdx++;
  }

  flush(); // final poll has no trailing physics frame to trigger it
  return frames;
}
