import { LMU_MAX_SOURCE_FRAME_SIZE } from "./source-frame";

export const LMU_DUMP_MAGIC = Buffer.from("LMUQDMP\0", "ascii");
export const LMU_DUMP_VERSION = 1;
export const LMU_DUMP_HEADER_SIZE = 16;
export const LMU_DUMP_FRAME_HEADER_SIZE = 5;
export const LMU_DUMP_SOURCE_FRAME_TYPE = 0;

export function hasLMUDumpMagic(bytes: Buffer): boolean {
  return bytes.length >= LMU_DUMP_MAGIC.length
    && bytes.subarray(0, LMU_DUMP_MAGIC.length).equals(LMU_DUMP_MAGIC);
}

/** Decode source frames from LMU dump-mode bytes. */
export function readLMUFramesFromBuffer(bytes: Buffer, limit?: number): Buffer[] {
  if (
    bytes.length < LMU_DUMP_HEADER_SIZE ||
    !hasLMUDumpMagic(bytes) ||
    bytes.readUInt32LE(8) !== LMU_DUMP_VERSION
  ) {
    return [];
  }

  const declaredFrameCount = bytes.readUInt32LE(12);
  const maximumFrames = declaredFrameCount === 0 ? Number.MAX_SAFE_INTEGER : declaredFrameCount;
  const frames: Buffer[] = [];
  let offset = LMU_DUMP_HEADER_SIZE;
  while (
    frames.length < maximumFrames &&
    offset + LMU_DUMP_FRAME_HEADER_SIZE <= bytes.length
  ) {
    const frameType = bytes.readUInt8(offset);
    const frameSize = bytes.readUInt32LE(offset + 1);
    offset += LMU_DUMP_FRAME_HEADER_SIZE;
    if (
      frameType !== LMU_DUMP_SOURCE_FRAME_TYPE ||
      frameSize === 0 ||
      frameSize > LMU_MAX_SOURCE_FRAME_SIZE ||
      offset + frameSize > bytes.length
    ) {
      break;
    }
    frames.push(Buffer.from(bytes.subarray(offset, offset + frameSize)));
    offset += frameSize;
    if (limit !== undefined && frames.length >= limit) break;
  }
  return frames;
}
