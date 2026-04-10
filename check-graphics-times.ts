import { readAccFrames } from "./server/games/acc/recorder";
import { GRAPHICS } from "./server/games/acc/structs";

const binPath = "test/artifacts/laps/acc-2026-04-09T18-56-49-633Z.bin";
const frames = readAccFrames(binPath);

console.log("Scanning graphics buffer for lap times...\n");

// Check offsets for iCurrentTime, iLastTime, iBestTime
const offsets = {
  iCurrentTime: 140,
  iLastTime: 144,
  iBestTime: 148
};

let nonZeroCount = 0;
const samples = [0, 100, 1000, 5000, 10000, 15000, 15500];

for (const frameIdx of samples) {
  if (frameIdx >= frames.length) continue;
  const frame = frames[frameIdx];
  
  const iCurrent = frame.graphics.readInt32LE(offsets.iCurrentTime);
  const iLast = frame.graphics.readInt32LE(offsets.iLastTime);
  const iBest = frame.graphics.readInt32LE(offsets.iBestTime);
  
  console.log(`Frame ${frameIdx}:`);
  console.log(`  iCurrentTime: ${iCurrent} ms (${(iCurrent/1000).toFixed(2)}s)`);
  console.log(`  iLastTime: ${iLast} ms (${(iLast/1000).toFixed(2)}s)`);
  console.log(`  iBestTime: ${iBest} ms (${(iBest/1000).toFixed(2)}s)`);
  
  if (iCurrent > 0 || iLast > 0 || iBest > 0) nonZeroCount++;
}

console.log(`\nFrames with non-zero times: ${nonZeroCount}/${samples.length}`);
