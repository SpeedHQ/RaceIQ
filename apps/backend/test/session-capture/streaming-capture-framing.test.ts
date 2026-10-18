import { expect, test } from "bun:test";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeParserBootstrapFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
  iterateSessionCaptureRecords,
  iterateSessionCaptureRecordsAsync,
  type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";

async function* splitAtSmallBoundaries(bytes: Buffer): AsyncGenerator<Uint8Array> {
  const chunkSizes = [1, 2, 3, 7, 1024];
  for (let offset = 0, chunk = 0; offset < bytes.length; chunk++) {
    const size = Math.min(chunkSizes[chunk % chunkSizes.length]!, bytes.length - offset);
    yield bytes.subarray(offset, offset + size);
    offset += size;
  }
}

function lmuFrame(changedByte: number): Buffer {
  const frame = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
  LMU_SOURCE_FRAME_MAGIC.copy(frame);
  frame[frame.length - 1] = changedByte;
  return frame;
}

function encodeRecord(frame: Buffer, timestamp?: number): Buffer {
  return Buffer.concat([encodeFrameLength(frame.length, timestamp), frame]);
}

test("streaming capture decoder preserves offsets, timestamps, markers and sparse source frames", async () => {
  const header = encodeMetaFrame(4);
  const sparse = new SparseCaptureEncoder("lmu");
  const first = lmuFrame(0);
  const firstOffset = header.length;
  const firstEncoded = sparse.encode(first, firstOffset);
  const firstRecord = encodeRecord(firstEncoded, 10);
  const secondOffset = firstOffset + firstRecord.length;
  const second = lmuFrame(1);
  const secondEncoded = sparse.encode(second, secondOffset);
  expect(secondEncoded.length).toBeLessThan(second.length);
  const secondRecord = encodeRecord(secondEncoded, 20);
  const boundary = encodeSegmentBoundaryFrame();
  const thirdOffset = secondOffset + secondRecord.length + boundary.length;
  sparse.reset();
  const third = lmuFrame(2);
  const thirdRecord = encodeRecord(sparse.encode(third, thirdOffset));
  const bootstrap = encodeParserBootstrapFrame("ac-evo", Buffer.from([1, 2, 3]));
  const fourthOffset = thirdOffset + thirdRecord.length + encodeSegmentContextFrame().length +
    encodeSegmentContextEndFrame().length + bootstrap.length;
  sparse.requestCheckpoint();
  const fourth = lmuFrame(3);
  const fourthEncoded = sparse.encode(fourth, fourthOffset);
  const fourthRecord = encodeRecord(fourthEncoded, 40);
  const bytes = Buffer.concat([
    header,
    firstRecord,
    secondRecord,
    boundary,
    thirdRecord,
    encodeSegmentContextFrame(),
    encodeSegmentContextEndFrame(),
    bootstrap,
    fourthRecord,
  ]);

  const records: SessionCaptureRecord[] = [];
  for await (const record of iterateSessionCaptureRecordsAsync(splitAtSmallBoundaries(bytes))) records.push(record);

  expect(records.map((record) => record.kind)).toEqual([
    "frame",
    "frame",
    "segment-boundary",
    "frame",
    "segment-context",
    "segment-context-end",
    "parser-bootstrap",
    "frame",
  ]);
  const frames = records.filter((record) => record.kind === "frame");
  expect(frames.map((record) => record.offset)).toEqual([firstOffset, secondOffset, thirdOffset, fourthOffset]);
  expect(frames.map((record) => record.endOffset - record.offset)).toEqual([
    firstRecord.length, secondRecord.length, thirdRecord.length, fourthRecord.length,
  ]);
  expect(frames.map((record) => record.kind === "frame" ? record.frame : null)).toEqual([first, second, third, fourth]);
  expect(records.filter((record) => record.kind !== "frame").every((record) => record.endOffset > record.offset)).toBe(true);
  expect(frames.map((record) => record.kind === "frame" ? record.frameTimeMs : undefined)).toEqual([10, 20, undefined, 40]);
  expect(records.find((record) => record.kind === "parser-bootstrap")).toEqual({
    kind: "parser-bootstrap",
    offset: fourthOffset - bootstrap.length,
    endOffset: fourthOffset,
    gameId: "ac-evo",
    formatVersion: 1,
    payload: Buffer.from([1, 2, 3]),
  });
  expect([...iterateSessionCaptureRecords(bytes)].find((record) => record.kind === "parser-bootstrap")?.kind).toBe("parser-bootstrap");
});

test("streaming capture decoder rejects truncated records in strict mode", async () => {
  const frame = lmuFrame(0);
  const bytes = Buffer.concat([encodeMetaFrame(), encodeFrameLength(frame.length), frame.subarray(0, 8)]);
  const collect = async () => {
    const records: SessionCaptureRecord[] = [];
    for await (const record of iterateSessionCaptureRecordsAsync(splitAtSmallBoundaries(bytes), { strict: true })) records.push(record);
    return records;
  };

  await expect(collect()).rejects.toThrow("Truncated session capture record");
});
test("streaming framing rejects every truncated prefix, timestamp, payload and metadata position", async () => {
  const frame = lmuFrame(1);
  const sparse = new SparseCaptureEncoder("lmu");
  const checkpoint = encodeRecord(sparse.encode(lmuFrame(0), 8));
  const deltaOffset = 8 + checkpoint.length;
  const delta = encodeRecord(sparse.encode(frame, deltaOffset), 10);
  const cases = [
    encodeRecord(Buffer.from([1, 2, 3])),
    encodeRecord(Buffer.from([1, 2, 3]), 10),
    delta,
    encodeSegmentBoundaryFrame(),
    encodeParserBootstrapFrame("ac-evo", Buffer.from([1, 2, 3])),
  ];
  for (const encoded of cases) {
    for (let end = 1; end < encoded.length; end++) {
      const partial = Buffer.concat([encodeMetaFrame(), encoded.subarray(0, end)]);
      await expect((async () => {
        for await (const _record of iterateSessionCaptureRecordsAsync(splitAtSmallBoundaries(partial), { strict: true })) {}
      })()).rejects.toThrow("Truncated session capture record");
    }
  }
});

test("strict framing rejects every incomplete initial metadata header", async () => {
  const header = encodeMetaFrame();
  for (let end = 1; end < header.length; end++) {
    const partial = header.subarray(0, end);
    expect(() => [...iterateSessionCaptureRecords(partial, undefined, { strict: true })]).toThrow("Truncated session capture record");
    await expect((async () => {
      for await (const _record of iterateSessionCaptureRecordsAsync(splitAtSmallBoundaries(partial), { strict: true })) {}
    })()).rejects.toThrow("Truncated session capture record");
  }
});

test("a bootstrap without a recorder header is preserved by both decoders", async () => {
  const bootstrap = encodeParserBootstrapFrame("ac-evo", Buffer.from([1, 2, 3]));
  const sync = [...iterateSessionCaptureRecords(bootstrap)];
  const streamed: SessionCaptureRecord[] = [];
  for await (const record of iterateSessionCaptureRecordsAsync(splitAtSmallBoundaries(bootstrap))) streamed.push(record);
  expect(streamed).toEqual(sync);
  expect(sync).toEqual([{
    kind: "parser-bootstrap", gameId: "ac-evo", formatVersion: 1,
    offset: 0, endOffset: bootstrap.length, payload: Buffer.from([1, 2, 3]),
  }]);
});

test("strict framing preserves encoded empty payloads and timestamp zero", async () => {
  const bytes = Buffer.concat([
    encodeMetaFrame(3), encodeFrameLength(0), encodeFrameLength(0, 0), encodeRecord(Buffer.from([1])),
  ]);
  const streamed: SessionCaptureRecord[] = [];
  for await (const record of iterateSessionCaptureRecordsAsync(splitAtSmallBoundaries(bytes), { strict: true })) streamed.push(record);
  expect(streamed).toEqual([...iterateSessionCaptureRecords(bytes)]);
  expect(streamed.filter((record) => record.kind === "frame").map(({ frame, frameTimeMs }) => [frame, frameTimeMs]))
    .toEqual([[Buffer.alloc(0), undefined], [Buffer.alloc(0), 0], [Buffer.from([1]), undefined]]);
});
