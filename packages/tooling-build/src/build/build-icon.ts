import sharp from "sharp";

// Run `bun packages/tooling-build/src/build/build-icon.ts` after editing the official logo artwork.
// Render every Windows/DPI size from the 1024px source, never a smaller frame.
const source = new URL("../../../../assets/raceiq-icon.png", import.meta.url);
const output = new URL("../../../../assets/raceiq.ico", import.meta.url);
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const frames: Buffer[] = [];
const artwork = await Bun.file(source).arrayBuffer();

for (const size of sizes) {
  const pixels = await sharp(artwork).resize(size, size).ensureAlpha().raw().toBuffer();
  const maskStride = Math.ceil(size / 32) * 4;
  const frame = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  frame.writeUInt32LE(40, 0);
  frame.writeInt32LE(size, 4);
  frame.writeInt32LE(size * 2, 8); // ICO DIB height includes the AND mask.
  frame.writeUInt16LE(1, 12);
  frame.writeUInt16LE(32, 14);
  frame.writeUInt32LE(size * size * 4, 20);

  // Windows DIB rows are bottom-up BGRA; transparent pixels also set AND bits.
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = 40 + (row * size + x) * 4;
      frame[dst] = pixels[src + 2]!;
      frame[dst + 1] = pixels[src + 1]!;
      frame[dst + 2] = pixels[src]!;
      frame[dst + 3] = pixels[src + 3]!;
      if (pixels[src + 3] === 0) {
        const mask = 40 + size * size * 4 + row * maskStride + (x >> 3);
        frame[mask] = frame[mask]! | (0x80 >> (x & 7));
      }
    }
  }
  frames.push(frame);
}

const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  directory[entry] = size === 256 ? 0 : size;
  directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frames[index]!.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frames[index]!.length;
}
await Bun.write(output, Buffer.concat([directory, ...frames]));
console.log(`Generated raceiq.ico: ${sizes.join(", ")}px`);
