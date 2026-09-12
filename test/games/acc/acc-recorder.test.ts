import { describe, test, expect } from "bun:test";
import { gunzipSync } from "node:zlib";
import { KunosRecorder } from "../../../server/games/kunos/recorder";
import { readKunosFrames } from "../../../server/games/kunos/frame-reader";
import { parseAccBuffers } from "../../../server/games/acc/parser";
import { PHYSICS, GRAPHICS, STATIC } from "../../../server/games/acc/structs";
import { unpackTriplet } from "../../../server/games/kunos/pack-triplet";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { getServerGame } from "../../../server/games/registry";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

initGameAdapters();
initServerGameAdapters();

const ACC_CAPTURE_FIXTURE = "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz";
const AC_EVO_CAPTURE_FIXTURE = "test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";

describe("readKunosFrames", () => {
  test("emits one triplet per [physics, graphics, static] group", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new KunosRecorder();
      const filePath = recorder.start(dir);

      const physics = Buffer.alloc(PHYSICS.SIZE, 0x01);
      const graphics = Buffer.alloc(GRAPHICS.SIZE, 0x02);
      const staticData = Buffer.alloc(STATIC.SIZE, 0x03);

      // DumpToBinProcessor writes [physics, graphics, static] per 100Hz poll.
      // Three polls → three triplets on replay.
      for (let i = 0; i < 3; i++) {
        recorder.writePhysics(physics);
        recorder.writeGraphics(graphics);
        recorder.writeStatic(staticData);
      }
      await recorder.stop();

      const frames = readKunosFrames(filePath);
      expect(frames).toHaveLength(3);
      expect(frames[0].physics).toEqual(physics);
      expect(frames[0].graphics).toEqual(graphics);
      expect(frames[0].staticData).toEqual(staticData);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("matches recorder output metadata with parsed fixture lap output", async () => {
    const fixture = gunzipSync(readFileSync(ACC_CAPTURE_FIXTURE));
    const serverGame = getServerGame("acc");
    let offset = 8 + fixture.readUInt32LE(4);
    const fixturePackets = [];
    const fixtureTriplets = [];
    while (fixturePackets.length < 3) {
      const frameLength = fixture.readUInt32LE(offset);
      offset += 4;
      const frame = fixture.subarray(offset, offset + frameLength);
      offset += frameLength;
      const triplet = unpackTriplet(frame);
      if (!triplet) continue;
      const packet = serverGame.tryParse(frame, null);
      if (!packet) continue;
      fixtureTriplets.push(triplet);
      fixturePackets.push(packet);
    }

    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new KunosRecorder();
      const filePath = recorder.start(dir);
      for (const triplet of fixtureTriplets) {
        recorder.writePhysics(triplet.physics);
        recorder.writeGraphics(triplet.graphics);
        recorder.writeStatic(triplet.staticData);
      }
      await recorder.stop();

      const raw = readFileSync(filePath);
      const declaredFrameCount = raw.readUInt32LE(12);
      const frames = readKunosFrames(filePath);
      const recordedPackets = frames.map((frame) => parseAccBuffers(frame.physics, frame.graphics, frame.staticData));

      expect(declaredFrameCount).toBe(7);
      expect(recorder.frameCount).toBe(declaredFrameCount);
      expect(frames).toHaveLength(fixturePackets.length);
      expect(recordedPackets).toHaveLength(fixturePackets.length);
      for (let i = 0; i < fixturePackets.length; i++) {
        expect(recordedPackets[i]).not.toBeNull();
        expect(recordedPackets[i]!.CurrentLap).toBeCloseTo(fixturePackets[i]!.CurrentLap, 3);
        expect(recordedPackets[i]!.LastLap).toBeCloseTo(fixturePackets[i]!.LastLap, 3);
        expect(recordedPackets[i]!.LapNumber).toBe(fixturePackets[i]!.LapNumber);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("matches Kunos recorder output with AC Evo fixture frames", async () => {
    const fixtureFrames = readKunosFrames(AC_EVO_CAPTURE_FIXTURE, 3);
    const dir = mkdtempSync(join(os.tmpdir(), "ac-evo-test-"));
    try {
      const recorder = new KunosRecorder();
      const filePath = recorder.start(dir, "ac-evo");
      for (const frame of fixtureFrames) {
        recorder.writePhysics(frame.physics);
        recorder.writeGraphics(frame.graphics);
        recorder.writeStatic(frame.staticData);
      }
      await recorder.stop();

      const raw = readFileSync(filePath);
      const recordedFrames = readKunosFrames(filePath);

      expect(raw.readUInt32LE(12)).toBe(recorder.frameCount);
      expect(recordedFrames).toHaveLength(fixtureFrames.length);
      for (let i = 0; i < fixtureFrames.length; i++) {
        expect(recordedFrames[i]).toEqual(fixtureFrames[i]);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("deduplicates identical static frames but captures every change", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new KunosRecorder();
      const filePath = recorder.start(dir);

      const physics = Buffer.alloc(PHYSICS.SIZE, 0x01);
      const graphics = Buffer.alloc(GRAPHICS.SIZE, 0x02);
      const staticA = Buffer.alloc(STATIC.SIZE, 0x00); // e.g. track name not yet populated
      const staticB = Buffer.alloc(STATIC.SIZE, 0x00);
      staticB.write("monza", 0, "utf8"); // game fills in data mid-session

      // Polls 1-2: identical static → second static frame is skipped on disk
      recorder.writePhysics(physics);
      recorder.writeGraphics(graphics);
      recorder.writeStatic(staticA);
      recorder.writePhysics(physics);
      recorder.writeGraphics(graphics);
      recorder.writeStatic(staticA);
      // Poll 3: static changed → new static frame written
      recorder.writePhysics(physics);
      recorder.writeGraphics(graphics);
      recorder.writeStatic(staticB);

      // 3 physics + 3 graphics + 2 static (one duplicate skipped)
      expect(recorder.frameCount).toBe(8);
      await recorder.stop();

      // Replay still yields a full triplet per poll: the reader carries the
      // last-seen static forward across sparse static frames.
      const frames = readKunosFrames(filePath);
      expect(frames).toHaveLength(3);
      expect(frames[0].staticData).toEqual(staticA);
      expect(frames[1].staticData).toEqual(staticA);
      expect(frames[2].staticData).toEqual(staticB);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("dedup does not mirror caller-mutated buffers (defensive copy)", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new KunosRecorder();
      const filePath = recorder.start(dir);

      const physics = Buffer.alloc(PHYSICS.SIZE, 0x01);
      const graphics = Buffer.alloc(GRAPHICS.SIZE, 0x02);
      const shared = Buffer.alloc(STATIC.SIZE, 0x00); // simulates the reused shared-memory view

      recorder.writePhysics(physics);
      recorder.writeGraphics(graphics);
      recorder.writeStatic(shared);

      // Mutate the same buffer in place (shared memory updates) — must be
      // detected as a change, not compared against itself.
      shared.write("monza", 0, "utf8");
      recorder.writePhysics(physics);
      recorder.writeGraphics(graphics);
      recorder.writeStatic(shared);

      await recorder.stop();
      const frames = readKunosFrames(filePath);
      expect(frames).toHaveLength(2);
      expect(frames[0].staticData.toString("utf8", 0, 5)).not.toBe("monza");
      expect(frames[1].staticData.toString("utf8", 0, 5)).toBe("monza");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty array for file with no frames", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new KunosRecorder();
      const filePath = recorder.start(dir);
      await recorder.stop();
      const frames = readKunosFrames(filePath);
      expect(frames).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
