import { describe, test, expect } from "bun:test";
import { KunosRecorder } from "../../../server/games/kunos/recorder";
import { readKunosFrames } from "../../../server/games/kunos/frame-reader";
import { PHYSICS, GRAPHICS, STATIC } from "../../../server/games/acc/structs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

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
  test("finalizes a stopped file without clobbering a restarted recorder", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new KunosRecorder();
      const firstPath = recorder.start(join(dir, "first"));
      const firstPhysics = Buffer.alloc(PHYSICS.SIZE, 0x11);
      const firstGraphics = Buffer.alloc(GRAPHICS.SIZE, 0x12);
      const firstStatic = Buffer.alloc(STATIC.SIZE, 0x13);
      recorder.writePhysics(firstPhysics);
      recorder.writeGraphics(firstGraphics);
      recorder.writeStatic(firstStatic);

      const firstStop = recorder.stop();
      const secondPath = recorder.start(join(dir, "second"));
      const secondPhysics = Buffer.alloc(PHYSICS.SIZE, 0x21);
      const secondGraphics = Buffer.alloc(GRAPHICS.SIZE, 0x22);
      const secondStatic = Buffer.alloc(STATIC.SIZE, 0x23);
      recorder.writePhysics(secondPhysics);
      recorder.writeGraphics(secondGraphics);
      recorder.writeStatic(secondStatic);

      await firstStop;
      expect(recorder.recording).toBe(true);
      expect(recorder.path).toBe(secondPath);
      expect(recorder.frameCount).toBe(3);
      await recorder.stop();

      const firstFrames = readKunosFrames(firstPath);
      expect(firstFrames).toHaveLength(1);
      expect(firstFrames[0].physics).toEqual(firstPhysics);
      expect(firstFrames[0].graphics).toEqual(firstGraphics);
      expect(firstFrames[0].staticData).toEqual(firstStatic);

      const secondFrames = readKunosFrames(secondPath);
      expect(secondFrames).toHaveLength(1);
      expect(secondFrames[0].physics).toEqual(secondPhysics);
      expect(secondFrames[0].graphics).toEqual(secondGraphics);
      expect(secondFrames[0].staticData).toEqual(secondStatic);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

});
