import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { readIRacingFramesFromBuffer } from "./dump-decoder";

export * from "./dump-decoder";

/**
 * Read raw iRacing source frames from a dump-mode .bin or .bin.gz recording.
 * A zero frame count is treated as an interrupted capture and scanned to the
 * last complete record.
 */
export function readIRacingFrames(filePath: string, limit?: number): Buffer[] {
  const raw = readFileSync(filePath);
  return readIRacingFramesFromBuffer(filePath.endsWith(".gz") ? gunzipSync(raw) : raw, limit);
}
