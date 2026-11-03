import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

export const AMS2_DUMP_MAGIC = Buffer.from("AMS2DMP1", "ascii");
export const AMS2_DUMP_HEADER_SIZE = 16;
export const AMS2_MAX_MEMORY_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = AMS2_MAX_MEMORY_BYTES + 24;

export function hasAMS2DumpMagic(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(AMS2_DUMP_MAGIC);
}

function validateHeader(bytes: Buffer): number {
  if (bytes.length < 16 || !hasAMS2DumpMagic(bytes) || bytes.readUInt32LE(8) !== 1) {
    throw new Error("Invalid AMS2 dump header or version");
  }
  return bytes.readUInt32LE(12);
}

function frameSize(bytes: Buffer): number {
  const size = bytes.readUInt32LE(0);
  if (size < 24 || size > MAX_FRAME_BYTES) throw new Error("Invalid AMS2 dump frame length");
  return size;
}

/** Raw dump framing is distinct from production sparse session captures. */
export function* readAMS2DumpFramesFromBuffer(bytes: Buffer): Generator<Buffer> {
  const declared = validateHeader(bytes);
  let count = 0;
  let offset = 16;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error("Truncated AMS2 dump length");
    const size = frameSize(bytes.subarray(offset));
    offset += 4;
    if (offset + size > bytes.length) throw new Error("Truncated AMS2 dump frame");
    yield bytes.subarray(offset, offset + size);
    offset += size;
    count++;
  }
  if (declared !== 0 && declared !== count) throw new Error("AMS2 dump frame count mismatch");
}

/** Streaming .bin/.bin.gz reader; keeps only a bounded input chunk and source frame. */
export async function* readAMS2DumpFrames(filePath: string): AsyncGenerator<Buffer> {
  const input = createReadStream(filePath);
  const stream = filePath.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  // Forward filesystem errors through the gzip stream as well.
  if (stream !== input) input.on("error", (error) => stream.destroy(error));
  let pending = Buffer.alloc(0);
  let declared: number | null = null;
  let count = 0;
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (declared === null) {
        if (pending.length < 16) continue;
        declared = validateHeader(pending);
        pending = pending.subarray(16);
      }
      while (pending.length >= 4) {
        const size = frameSize(pending);
        if (pending.length < size + 4) break;
        yield Buffer.from(pending.subarray(4, size + 4));
        pending = pending.subarray(size + 4);
        count++;
      }
    }
    if (declared === null || pending.length) throw new Error("Truncated AMS2 dump");
    if (declared !== 0 && count !== declared) throw new Error("AMS2 dump frame count mismatch");
  } finally {
    stream.destroy();
    input.destroy();
  }
}
