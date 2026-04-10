import { readFileSync } from "fs";

const binPath = "test/artifacts/laps/acc-2026-04-09T18-56-49-633Z.bin";
const data = readFileSync(binPath);

const physicsSize = data.readUInt32LE(12);
const graphicsSize = data.readUInt32LE(16);
const staticSize = data.readUInt32LE(20);
const frameSize = 8 + physicsSize + graphicsSize + staticSize;
const HEADER_SIZE = 24;
const speedOffset = 28;

console.log(`Checking speeds at frame indices (speedKmh at offset ${speedOffset} in physics buffer):\n`);

const checkFrames = [0, 1, 10, 100, 1000, 5000, 10000, 15000, 15500];

for (const frameIdx of checkFrames) {
  const frameOffset = HEADER_SIZE + frameIdx * frameSize;
  if (frameOffset + frameSize > data.length) {
    console.log(`Frame ${frameIdx}: out of range`);
    continue;
  }
  
  const physicsStart = frameOffset + 8; // skip timestamp
  const speed = data.readFloatLE(physicsStart + speedOffset);
  console.log(`Frame ${frameIdx}: speed = ${speed.toFixed(2)} km/h`);
}
