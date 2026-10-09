import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { readLMUFramesFromBuffer } from "./dump-decoder";

export * from "./dump-decoder";

/** Read source frames from LMU dump-mode .bin or .bin.gz captures. */
export function readLMUFrames(filePath: string, limit?: number): Buffer[] {
  const raw = readFileSync(filePath);
  const bytes = filePath.endsWith(".gz")
    ? Buffer.from(gunzipSync(raw))
    : Buffer.from(raw);
  return readLMUFramesFromBuffer(bytes, limit);
}
