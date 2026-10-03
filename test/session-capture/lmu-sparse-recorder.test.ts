import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LMU_SOURCE_FRAME_HEADER_SIZE, LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/backend-core/games/lmu/source-frame";
import { advanceSessionFrames, iterateSessionFrameRecords, sessionFrameAt } from "@raceiq/backend-core/session-capture/framing";
import { SparseSessionRecorder } from "@raceiq/backend-core/session-capture/sparse-recorder";
import { iterateSessionCaptureFrames } from "@raceiq/backend-core/session-capture/source-loader";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("LMU sparse session recorder", () => {
  test("retains exact source frames, stored lap offsets, checkpoints, and streaming replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raceiq-sparse-record-"));
    directories.push(dir);
    const file = join(dir, "capture.bin");
    const recorder = new SparseSessionRecorder();
    recorder.start(file);
    recorder.writeMetaFrame();
    const expected: Buffer[] = [];
    const offsets: number[] = [];
    const frame = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
    LMU_SOURCE_FRAME_MAGIC.copy(frame);
    frame.writeUInt16LE(2, 8);
    for (let index = 0; index < 270; index++) {
      frame.writeUInt32LE(index, 20);
      frame.writeUInt32LE(index * 17, 128_468 + 28);
      if (index === 150) frame[204_000] = 87;
      const source = Buffer.from(frame);
      offsets.push(recorder.getCurrentByteOffset());
      recorder.writeRecord(source);
      expected.push(source);
    }
    await recorder.stop();
    const bytes = readFileSync(file);
    expect(bytes.length).toBeLessThan(expected.length * LMU_SOURCE_FRAME_V2_SIZE / 15);
    const records = [...iterateSessionFrameRecords(bytes)];
    expect(records.map((record) => record.offset)).toEqual(offsets);
    expect(records.map((record) => record.frame)).toEqual(expected);
    for (const index of [0, 1, 127, 128, 129, 149, 150, 255, 256, 269]) {
      expect(sessionFrameAt(bytes, offsets[index]!)).toEqual(expected[index]);
      expect([...iterateSessionFrameRecords(bytes, offsets[index])][0]?.frame).toEqual(expected[index]);
      if (index + 1 < offsets.length) expect(advanceSessionFrames(bytes, offsets[index]!, 1)).toBe(offsets[index + 1]);
    }
    const streamed: Buffer[] = [];
    for await (const record of iterateSessionCaptureFrames({ rawFile: file, source: null, gameId: "lmu", carOrdinal: -1, trackOrdinal: -1 })) {
      streamed.push(record.frame);
    }
    expect(streamed).toEqual(expected);
  });
  test("uses raw checkpoints when changed blocks cost more than full frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raceiq-sparse-raw-fallback-"));
    directories.push(dir);
    const file = join(dir, "capture.bin");
    const recorder = new SparseSessionRecorder();
    recorder.start(file);
    recorder.writeMetaFrame();
    const first = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
    LMU_SOURCE_FRAME_MAGIC.copy(first);
    first.writeUInt16LE(2, 8);
    const second = Buffer.from(first);
    second.fill(1, LMU_SOURCE_FRAME_HEADER_SIZE);
    const third = Buffer.from(second);
    third[1000] = 2;
    recorder.writeRecord(first);
    const secondOffset = recorder.getCurrentByteOffset();
    recorder.writeRecord(second);
    const thirdOffset = recorder.getCurrentByteOffset();
    recorder.writeRecord(third);
    await recorder.stop();
    const bytes = readFileSync(file);
    expect(bytes.readUInt32LE(secondOffset)).toBe(second.length);
    expect(bytes.readUInt32LE(thirdOffset)).toBeLessThan(third.length);
    expect(sessionFrameAt(bytes, secondOffset)).toEqual(second);
    expect(sessionFrameAt(bytes, thirdOffset)).toEqual(third);
  });
  test("resets checkpoints at segment boundaries and rejects broken back-references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raceiq-sparse-boundary-"));
    directories.push(dir);
    const recorder = new SparseSessionRecorder();
    recorder.start(join(dir, "capture.bin"));
    recorder.writeMetaFrame();
    const frame = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
    LMU_SOURCE_FRAME_MAGIC.copy(frame);
    frame.writeUInt16LE(2, 8);
    recorder.writeRecord(Buffer.from(frame));
    const deltaOffset = recorder.getCurrentByteOffset();
    frame[1000] = 24;
    recorder.writeRecord(Buffer.from(frame));
    recorder.writeSegmentBoundary();
    const nextOffset = recorder.getCurrentByteOffset();
    recorder.writeRecord(Buffer.from(frame));
    await recorder.stop();
    const bytes = readFileSync(recorder.path!);
    expect(bytes.readUInt32LE(nextOffset)).toBe(LMU_SOURCE_FRAME_V2_SIZE);
    expect(sessionFrameAt(bytes, nextOffset)).toEqual(frame);
    bytes.writeUInt32LE(1, deltaOffset + 8);
    expect(() => sessionFrameAt(bytes, deltaOffset)).toThrow(/checkpoint distance/);
  });
});
