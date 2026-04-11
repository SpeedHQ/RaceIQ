import { readFileSync } from "fs";

const binPath = "test/artifacts/laps/acc-2026-04-09T18-56-49-633Z.bin";
const data = readFileSync(binPath);

// Read header
const MAGIC = data.slice(0, 8).toString('ascii');
const version = data.readUInt32LE(8);
const physicsSize = data.readUInt32LE(12);
const graphicsSize = data.readUInt32LE(16);
const staticSize = data.readUInt32LE(20);

console.log(`Magic: ${MAGIC}`);
console.log(`Version: ${version}`);
console.log(`Physics: ${physicsSize}, Graphics: ${graphicsSize}, Static: ${staticSize}`);
console.log(`Total frame size: ${8 + physicsSize + graphicsSize + staticSize}`);
console.log(`File size: ${data.length}`);
console.log(`Expected frames: ${Math.floor((data.length - 24) / (8 + physicsSize + graphicsSize + staticSize))}`);

// Check first frame physics buffer for speed field
// According to ACC parser, speedKmh is at PHYSICS.speedKmh.offset
// Let's read raw values from first frame
const FRAME_HEADER = 8;
const HEADER_SIZE = 24;
const firstPhysicsStart = HEADER_SIZE + FRAME_HEADER;
const firstPhysicsEnd = firstPhysicsStart + physicsSize;
const firstPhysics = data.slice(firstPhysicsStart, firstPhysicsEnd);

console.log(`\nFirst physics buffer (first 200 bytes):`);
console.log(firstPhysics.slice(0, 200));

// Speed is stored at offset 344 in physics struct
const speedOffset = 344;
if (firstPhysics.length > speedOffset + 4) {
  const speed = firstPhysics.readFloatLE(speedOffset);
  console.log(`\nSpeed at offset ${speedOffset}: ${speed}`);
}

// Let's also check what's at a few key offsets
console.log(`\nFirst 10 floats from physics buffer:`);
for (let i = 0; i < 10; i++) {
  const val = firstPhysics.readFloatLE(i * 4);
  console.log(`  Offset ${i * 4}: ${val}`);
}
