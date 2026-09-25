import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { advanceSessionFrames, encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame, iterateSessionCaptureRecords, sessionFrameAt } from "../../server/session-capture/framing";
import { indexCaptureFrames, iterateSessionCaptureFrames, iterateSessionCaptureRecordsFromSource, setCaptureFileFactoryForTest } from "../../server/session-capture/source-loader";
import { encodeAccBroadcastCaptureRecord } from "../../server/games/acc/broadcast-capture";

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

for (const compressed of [false, true]) {
  test(`streams ${compressed ? "gzip" : "plain"} segment records without whole-file reads`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-source-stream-"));
    directories.push(directory);
    const frame = Buffer.alloc(128 * 1024, 7);
    const capture = Buffer.concat([
      encodeMetaFrame(2), encodeFrameLength(frame.length), frame,
      encodeSegmentBoundaryFrame(), encodeSegmentContextFrame(),
      encodeFrameLength(2), Buffer.from([8, 9]), encodeSegmentContextEndFrame(),
    ]);
    const rawFile = join(directory, compressed ? "segments.bin.gz" : "segments.bin");
    writeFileSync(rawFile, compressed ? gzipSync(capture) : capture);
    setCaptureFileFactoryForTest((path) => {
      const file = Bun.file(path);
      return {
        size: file.size, lastModified: file.lastModified,
        slice: (start, end) => file.slice(start, end),
        stream: () => file.stream(),
        arrayBuffer: () => { throw new Error("whole-capture read"); },
      };
    });
    try {
      const actual = [];
      for await (const record of iterateSessionCaptureRecordsFromSource({
        rawFile, source: null, gameId: "f1-2025", carOrdinal: 0, trackOrdinal: 0,
      })) actual.push(record);
      expect(actual.map(({ kind, offset }) => ({ kind, offset }))).toEqual(
        [...iterateSessionCaptureRecords(capture)].map(({ kind, offset }) => ({ kind, offset })),
      );
      expect(actual.filter((record) => record.kind === "frame").map((record) => record.frame)).toEqual([frame, Buffer.from([8, 9])]);
    } finally {
      setCaptureFileFactoryForTest(null);
    }
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

for (const compressed of [false, true]) {
  test(`skips interleaved metadata in ${compressed ? "gzip" : "plain"} frame windows and retains prior frames at truncated tail`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-metadata-stream-"));
    directories.push(directory);
    const zero = encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 1_000, events: [] });
    const future = Buffer.from(zero);
    future.writeUInt32LE(2, 12);
    const malformed = Buffer.from(zero);
    malformed.writeUInt32LE(1, 24);
    const first = Buffer.from([1, 2]);
    const second = Buffer.from([3, 4]);
    const firstOffset = 12;
    const secondOffset = firstOffset + zero.length + 4 + first.length;
    const complete = Buffer.concat([
      encodeMetaFrame(2), zero, encodeFrameLength(first.length), first,
      future, malformed, encodeFrameLength(second.length), second,
    ]);
    const bytes = Buffer.concat([complete, zero.subarray(0, zero.length - 1)]);
    const rawFile = join(directory, compressed ? "capture.bin.gz" : "capture.bin");
    writeFileSync(rawFile, compressed ? gzipSync(bytes) : bytes);
    const records = [];
    for await (const record of iterateSessionCaptureFrames({ rawFile, source: null, gameId: "acc", carOrdinal: 0, trackOrdinal: 0 })) records.push(record);
    expect(records.map((record) => record.prefixOffset)).toEqual([firstOffset, secondOffset]);
    expect(records.map((record) => record.frame)).toEqual([first, second]);
    expect(sessionFrameAt(bytes, secondOffset)).toEqual(second);
    expect(advanceSessionFrames(bytes, firstOffset, 1)).toBe(secondOffset);
    expect(advanceSessionFrames(bytes, firstOffset, 2)).toBe(complete.length);
    const indexed = indexCaptureFrames(bytes);
    expect(indexed.records.map((record) => record.frameIndex)).toEqual([0, 1]);
    expect(indexed.byOffset.get(secondOffset)?.offset).toBe(secondOffset + future.length + malformed.length);
    expect([...iterateSessionCaptureRecords(bytes)].map((record) => record.kind)).toEqual([
      "acc-broadcast", "frame", "metadata", "acc-broadcast-malformed", "frame",
    ]);
  });
}
