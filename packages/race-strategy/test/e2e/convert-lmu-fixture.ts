import { copyFile, readFile, writeFile } from "node:fs/promises";
import { containsSparseCaptureFrames, decompressIfGzipSync } from "@raceiq/capture-formats/session/framing";
import { readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error("Expected source and target recording paths");
const raw = decompressIfGzipSync(await readFile(source));
if (containsSparseCaptureFrames(raw)) await writeFile(target, raw);
else {
  const converted = await convertSeedFramesToSparse("lmu", readLMUFramesFromBuffer(raw));
  try { await copyFile(converted.path, target); }
  finally { converted.cleanup(); }
}
