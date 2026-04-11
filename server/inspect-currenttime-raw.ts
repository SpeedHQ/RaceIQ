import { readFileSync } from "fs";
import { resolve } from "path";

const binPath = resolve(process.cwd(), "test/artifacts/laps/acc-2026-04-10T02-59-28-972Z.bin");
const data = readFileSync(binPath);
const V2_HEADER_SIZE = 16;
const V2_FRAME_HEADER = 5;

let offset = V2_HEADER_SIZE;
let graphicsCount = 0;

// Sample at known lap transition points
while (offset + V2_FRAME_HEADER <= data.length) {
  const frameType = data.readUInt8(offset);
  const bufferSize = data.readUInt32LE(offset + 1);
  if (frameType > 2 || bufferSize > 500000) break;
  if (offset + V2_FRAME_HEADER + bufferSize > data.length) break;
  const buf = data.slice(offset + V2_FRAME_HEADER, offset + V2_FRAME_HEADER + bufferSize);
  
  if (frameType === 1 && [500, 1000, 6900, 6933, 7000, 8000].includes(graphicsCount)) {
    // Read offset 140 as both int32 and float32
    const asInt = buf.readInt32LE(140);
    const asFloat = buf.readFloatLE(140);
    const asUInt = buf.readUInt32LE(140);
    const completedLaps = buf.readInt32LE(132);
    console.log(`frame=${graphicsCount} completedLaps=${completedLaps} | offset140: int=${asInt} uint=${asUInt} float=${asFloat.toFixed(3)} | /1000=${(asInt/1000).toFixed(3)}s`);
  }
  
  if (frameType === 1) graphicsCount++;
  offset += V2_FRAME_HEADER + bufferSize;
}
