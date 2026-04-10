import { readAccFrames } from "./server/games/acc/recorder";
import { readWString } from "./server/games/acc/utils";
import { STATIC } from "./server/games/acc/structs";
import { getAccCarByModel } from "./shared/acc-car-data";

const binPath = "test/artifacts/laps/acc-2026-04-09T18-56-49-633Z.bin";
const frames = readAccFrames(binPath);

// Find a frame where we know the car is moving (frame 5000+)
const movingFrame = frames[5000];

console.log("Scanning frame 5000 physics buffer for plausible speed values...\n");
console.log("Expected speed from offset 28: ", movingFrame.physics.readFloatLE(28), "km/h");

// Look for floats that are reasonable speeds (1-300)
const plausibleSpeeds: Array<{offset: number; speed: number}> = [];

for (let offset = 0; offset < movingFrame.physics.length - 4; offset += 4) {
  const val = movingFrame.physics.readFloatLE(offset);
  if (val > 1 && val < 300) {
    plausibleSpeeds.push({ offset, speed: val });
  }
}

console.log("Plausible speed values found at:");
plausibleSpeeds.slice(0, 20).forEach(p => {
  console.log(`  Offset ${p.offset}: ${p.speed.toFixed(2)} km/h`);
});
