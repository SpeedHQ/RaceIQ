import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrameLength, encodeMetaFrame } from "@raceiq/capture-formats/session/framing";
import { splitCapture } from "../src/index";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "raceiq-split-cancellation-"));
  directories.push(path);
  return path;
}
function encodeRecord(frame: Buffer): Buffer {
  return Buffer.concat([encodeFrameLength(frame.length), frame]);
}
test("cancellation stops nested verification before reading subsequent owned records", async () => {
  const root = directory();
  const sourcePath = join(root, "cancel.bin");
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(3), ...[1, 2, 3].map((value) => encodeRecord(Buffer.from([value])))]));
  const controller = new AbortController();
  const verified: number[] = [];
  const task = splitCapture({
    sourcePath, outputDirectory: join(root, "bundle"), gameId: "fm-2023", sourceRevision: "cancel",
    lapWindows: [{ lapId: "lap", lapNumber: 1, startByteOffset: 12, frameCount: 3 }],
    onProgress(progress) {
      if (progress.phase === "verify") {
        verified.push(progress.frames);
        if (progress.frames === 1) controller.abort(new Error("cancel verification"));
      }
    },
  });
  await expect(Effect.runPromise(task, { signal: controller.signal })).rejects.toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(verified).toEqual([1]);
});
