import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame, iterateSessionCaptureRecords } from "../../server/session-capture/framing";
import { iterateSessionCaptureFrames, iterateSessionCaptureRecordsFromSource, setCaptureFileFactoryForTest } from "../../server/session-capture/source-loader";
import { encodeKunosSparseFrame } from "../../server/session-capture/kunos-sparse";
import { packTriplet, ACC_PACKED_MAGIC } from "../../server/games/kunos/pack-triplet";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "../../server/games/lmu/source-frame";
import { encodeLmuSparseFrame } from "../../server/session-capture/lmu-sparse";

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
test("rejects sparse deltas backed by same-size cross-format checkpoints in both readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-cross-format-"));
  directories.push(directory);
  const lmu = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
  LMU_SOURCE_FRAME_MAGIC.copy(lmu);
  const packed = packTriplet(ACC_PACKED_MAGIC, 0, 0, Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE - 28), Buffer.alloc(0), Buffer.alloc(0));
  for (const wrongCheckpoint of [packed, lmu]) {
    const delta = wrongCheckpoint === packed
      ? encodeLmuSparseFrame(Buffer.from(lmu), Buffer.from(lmu), 4 + packed.length)
      : encodeKunosSparseFrame(packed, packed, 4 + lmu.length);
    const capture = Buffer.concat([encodeMetaFrame(), encodeFrameLength(wrongCheckpoint.length), wrongCheckpoint,
      encodeFrameLength(delta.length), delta]);
    const secondOffset = 12 + 4 + wrongCheckpoint.length;
    expect(() => [...iterateSessionCaptureRecords(capture, secondOffset)]).toThrow(/checkpoint/);
    const rawFile = join(directory, `bad-${wrongCheckpoint === packed ? "kunos" : "lmu"}.bin`);
    writeFileSync(rawFile, capture);
    await expect(async () => {
      for await (const _record of iterateSessionCaptureRecordsFromSource({ rawFile, source: null, gameId: "lmu", carOrdinal: -1, trackOrdinal: -1 })) {}
    }).toThrow(/checkpoint/);
  }
});
