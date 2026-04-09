import { describe, test, expect } from "bun:test";
import { AccRecorder, readAccFrames } from "../server/games/acc/recorder";
import { PHYSICS, GRAPHICS, STATIC } from "../server/games/acc/structs";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import os from "os";

describe("readAccFrames", () => {
  test("reads frames written by AccRecorder", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new AccRecorder();
      const filePath = recorder.start(dir);

      const physics = Buffer.alloc(PHYSICS.SIZE, 0x01);
      const graphics = Buffer.alloc(GRAPHICS.SIZE, 0x02);
      const staticData = Buffer.alloc(STATIC.SIZE, 0x03);

      recorder.writeFrame(physics, graphics, staticData);
      recorder.writeFrame(physics, graphics, staticData);
      await recorder.stop();

      const frames = readAccFrames(filePath);
      expect(frames).toHaveLength(2);
      expect(frames[0].physics).toEqual(physics);
      expect(frames[0].graphics).toEqual(graphics);
      expect(frames[0].staticData).toEqual(staticData);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty array for file with no frames", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new AccRecorder();
      const filePath = recorder.start(dir);
      await recorder.stop();
      const frames = readAccFrames(filePath);
      expect(frames).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
