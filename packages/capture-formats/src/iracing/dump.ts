import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { IRACING_MAX_SOURCE_FRAME_SIZE } from "./source-frame";

export const IRACING_DUMP_MAGIC = Buffer.from("IRIQDMP\0", "ascii");
export const IRACING_DUMP_VERSION = 2;
export const IRACING_DUMP_HEADER_SIZE = 16;
export const IRACING_DUMP_FRAME_HEADER_SIZE = 5;
export const IRACING_DUMP_SOURCE_FRAME_TYPE = 0;

/**
 * Read raw iRacing source frames from a dump-mode .bin or .bin.gz recording.
 * A zero frame count is treated as an interrupted capture and scanned to the
 * last complete record.
 */
export function readIRacingFrames(filePath: string, limit?: number): Buffer[] {
  const raw = readFileSync(filePath);
  return readIRacingFramesFromBuffer(filePath.endsWith(".gz") ? gunzipSync(raw) : raw, limit);
}

export function readIRacingFramesFromBuffer(data: Buffer, limit?: number): Buffer[] {
  if (
    data.length < IRACING_DUMP_HEADER_SIZE ||
    !data.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)
  ) {
    return [];
  }
  if (data.readUInt32LE(8) !== IRACING_DUMP_VERSION) return [];

  const declaredFrameCount = data.readUInt32LE(12);
  const maxFrames = declaredFrameCount === 0
    ? Number.MAX_SAFE_INTEGER
    : declaredFrameCount;
  const frames: Buffer[] = [];
  let offset = IRACING_DUMP_HEADER_SIZE;

  while (
    frames.length < maxFrames &&
    offset + IRACING_DUMP_FRAME_HEADER_SIZE <= data.length
  ) {
    const frameType = data.readUInt8(offset);
    const frameSize = data.readUInt32LE(offset + 1);
    offset += IRACING_DUMP_FRAME_HEADER_SIZE;
    if (
      frameType !== IRACING_DUMP_SOURCE_FRAME_TYPE ||
      frameSize === 0 ||
      frameSize > IRACING_MAX_SOURCE_FRAME_SIZE ||
      offset + frameSize > data.length
    ) {
      break;
    }
    frames.push(Buffer.from(data.subarray(offset, offset + frameSize)));
    offset += frameSize;
    if (limit !== undefined && frames.length >= limit) break;
  }

  return frames;
}
