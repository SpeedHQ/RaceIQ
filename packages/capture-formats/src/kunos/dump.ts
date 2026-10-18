import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const ACC_MAGIC = Buffer.from("ACCTEST\0", "ascii");
const HEADER_SIZE = 16; // magic (8) + version (4) + frameCount (4)
const FRAME_HEADER = 5; // type (1) + size (4)
const SUPPORTED_VERSIONS = new Set([2, 3]);

/** Detect the existing ACCTEST native dump container. */
export function hasKunosDumpMagic(data: Buffer): boolean {
  return data.length >= ACC_MAGIC.length && data.subarray(0, ACC_MAGIC.length).equals(ACC_MAGIC);
}

/** Decode assembled triplets from a Kunos recording buffer. */
export function readKunosFramesFromBuffer(data: Buffer, limit?: number): { physics: Buffer; graphics: Buffer; staticData: Buffer }[] {
  if (data.length < HEADER_SIZE || !hasKunosDumpMagic(data)) return [];
  const version = data.readUInt32LE(8);
  if (!SUPPORTED_VERSIONS.has(version)) {
    console.warn(`[ACC frame-reader] Unsupported recording version ${version}`);
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
  let lastStatic: Buffer = Buffer.alloc(0);
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

/**
 * Read assembled triplets from a Kunos recording (.bin or .bin.gz).
 * Supports legacy ACCTEST format versions 2 and 3.
 */
export function readKunosFrames(filePath: string, limit?: number): { physics: Buffer; graphics: Buffer; staticData: Buffer }[] {
  const raw = readFileSync(filePath);
  const data = filePath.endsWith(".gz") ? gunzipSync(raw) : raw;
  return readKunosFramesFromBuffer(data, limit);
}
