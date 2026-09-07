import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeFrameLength, encodeMetaFrame } from "../../server/session-capture/framing";
import { iterateSessionCaptureFrames } from "../../server/session-capture/source-loader";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const compressed of [false, true]) {
  test(`streams ${compressed ? "gzip" : "plain"} capture frames with decompressed offsets`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-source-stream-"));
    directories.push(directory);
    const first = Buffer.from([1, 2, 3]);
    const second = Buffer.from([4, 5]);
    const capture = Buffer.concat([
      encodeMetaFrame(2),
      encodeFrameLength(first.length),
      first,
      encodeFrameLength(second.length),
      second,
    ]);
    const rawFile = join(directory, compressed ? "capture.bin.gz" : "capture.bin");
    writeFileSync(rawFile, compressed ? gzipSync(capture) : capture);

    const records = [];
    for await (const record of iterateSessionCaptureFrames({
      rawFile,
      source: null,
      gameId: "f1-2025",
      carOrdinal: 0,
      trackOrdinal: 0,
    })) {
      records.push({ offset: record.offset, frame: [...record.frame] });
    }

    expect(records).toEqual([
      { offset: 12, frame: [1, 2, 3] },
      { offset: 19, frame: [4, 5] },
    ]);
  });
}

for (const malformed of [
  { name: "metadata", bytes: Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x01]) },
  { name: "frame", bytes: Buffer.from([0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0]) },
]) {
  test(`rejects oversized ${malformed.name} records before buffering their payload`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-source-stream-"));
    directories.push(directory);
    const rawFile = join(directory, "malformed.bin");
    writeFileSync(rawFile, malformed.bytes);

    const consume = async () => {
      for await (const _record of iterateSessionCaptureFrames({
        rawFile,
        source: null,
        gameId: "f1-2025",
        carOrdinal: 0,
        trackOrdinal: 0,
      })) {
        // No valid records expected.
      }
    };

    await expect(consume()).rejects.toThrow(/record length .* exceeds 16 MiB limit/);
  });
}
