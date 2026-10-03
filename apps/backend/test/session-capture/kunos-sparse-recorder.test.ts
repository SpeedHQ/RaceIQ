import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACC_PACKED_MAGIC, ACEVO_PACKED_MAGIC, packTriplet, unpackTriplet } from "@raceiq/backend-core/games/kunos/pack-triplet";
import { iterateSessionFrames, sessionFrameAt } from "@raceiq/backend-core/session-capture/framing";
import { SparseSessionRecorder } from "@raceiq/backend-core/session-capture/sparse-recorder";
import { iterateSessionCaptureFrames } from "@raceiq/backend-core/session-capture/source-loader";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

for (const [gameId, magic] of [["acc", ACC_PACKED_MAGIC], ["ac-evo", ACEVO_PACKED_MAGIC]] as const) {
  describe(`${gameId} sparse session`, () => {
    test("restores raw triplets at lap offsets, across changed static data and frame sizes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "raceiq-kunos-sparse-"));
      directories.push(dir);
      const path = join(dir, "capture.bin");
      const recorder = new SparseSessionRecorder(gameId);
      recorder.start(path);
      recorder.writeMetaFrame();
      const offsets: number[] = [];
      const originals: Buffer[] = [];
      const physics = Buffer.alloc(400);
      const graphics = Buffer.alloc(280);
      const staticData = Buffer.alloc(160);
      for (let index = 0; index < 270; index++) {
        physics.writeUInt32LE(index, 100);
        if (index % 10 === 0) graphics.writeUInt32LE(index, 120);
        if (index === 150) staticData[80] = 77;
        const frame = packTriplet(magic, 4, 8, physics, graphics, index === 200 ? staticData.subarray(0, 120) : staticData);
        offsets.push(recorder.getCurrentByteOffset());
        recorder.writeRecord(frame);
        originals.push(frame);
      }
      await recorder.stop();
      const bytes = readFileSync(path);
      expect(bytes.length).toBeLessThan(originals.reduce((sum, frame) => sum + frame.length, 0) / 3);
      expect([...iterateSessionFrames(bytes)]).toEqual(originals);
      for (const index of [0, 1, 127, 128, 149, 150, 199, 200, 201, 256, 269]) {
        const frame = sessionFrameAt(bytes, offsets[index]!);
        expect(frame).toEqual(originals[index]);
        expect(unpackTriplet(frame!)?.staticData.length).toBe(index === 200 ? 120 : 160);
      }
      const streamed: Buffer[] = [];
      for await (const record of iterateSessionCaptureFrames({ rawFile: path, source: null, gameId, carOrdinal: 4, trackOrdinal: 8 })) streamed.push(record.frame);
      expect(streamed).toEqual(originals);
    });
    test("uses raw checkpoint when every payload block changes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "raceiq-kunos-raw-fallback-"));
      directories.push(dir);
      const file = join(dir, "capture.bin");
      const recorder = new SparseSessionRecorder(gameId);
      recorder.start(file);
      recorder.writeMetaFrame();
      const source = (value: number) => packTriplet(
        magic, 4, 8, Buffer.alloc(400, value), Buffer.alloc(280, value), Buffer.alloc(160, value),
      );
      const first = source(0);
      const second = source(1);
      const third = Buffer.from(second);
      third[100] = 2;
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
  });
}
