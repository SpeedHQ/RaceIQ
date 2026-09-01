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
