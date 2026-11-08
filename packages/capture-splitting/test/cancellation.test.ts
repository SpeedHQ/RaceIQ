import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { encodeFrameLength, encodeMetaFrame, iterateSessionCaptureRecords, iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";
import { splitCapture, splitCapturePromise } from "../src/index";

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

test("rotates large auxiliary ranges into independently decodable bounded members", async () => {
  const root = directory();
  const sourcePath = join(root, "large-aux.bin.gz");
  const frameBytes = 1024 * 1024;
  const frameCount = 66;
  const input = Readable.from((function* () {
    yield encodeMetaFrame(frameCount);
    for (let index = 0; index < frameCount; index++) {
      yield encodeFrameLength(frameBytes);
      yield Buffer.alloc(frameBytes, index);
    }
  })());
  await pipeline(input, createGzip(), createWriteStream(sourcePath));
  const outputDirectory = join(root, "archive");
  const manifest = await splitCapturePromise({ sourcePath, outputDirectory, gameId: "fm-2023", sourceRevision: "aux", lapWindows: [] });
  if (manifest.version !== 3) throw new Error("Expected directory manifest");
  expect(manifest.chunks.every((chunk) => chunk.kind === "auxiliary" && chunk.byteLength <= 65 * 1024 * 1024 && existsSync(join(outputDirectory, chunk.path)))).toBe(true);
  expect(readdirSync(outputDirectory)).not.toContain("capture.bin.gz");
  let ordinal = 0;
  for (const chunk of manifest.chunks) {
    for await (const record of iterateSessionCaptureRecordsAsync(createReadStream(join(outputDirectory, chunk.path)), { strict: true })) {
      if (record.kind !== "frame") throw new Error("Unexpected auxiliary record kind");
      expect(record.frame).toEqual(Buffer.alloc(frameBytes, ordinal++));
    }
  }
  expect(ordinal).toBe(frameCount);
}, 60_000);

test("a repeated output attempt cannot overwrite referenced physical lap files or manifest", async () => {
  const root = directory();
  const sourcePath = join(root, "source.bin");
  const outputDirectory = join(root, "publication");
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(1), encodeRecord(Buffer.from([1]))]));
  const options = { sourcePath, outputDirectory, gameId: "fm-2023" as const, sourceRevision: "first",
    lapWindows: [{lapId:"lap",lapNumber:0,startByteOffset:12,frameCount:1}] };
  const manifest = await splitCapturePromise(options);
  expect(manifest.chunks.find((chunk) => chunk.kind === "lap")?.lapNumber).toBe(0);
  if (manifest.version !== 3) throw new Error("Expected directory manifest");
  const manifestBytes = readFileSync(join(outputDirectory, "manifest.json"));
  writeFileSync(sourcePath, Buffer.concat([encodeMetaFrame(1), encodeRecord(Buffer.from([2]))]));
  expect(readdirSync(outputDirectory).sort()).toEqual([...manifest.chunks.map((chunk) => chunk.path), "manifest.json"].sort());
  expect(readdirSync(outputDirectory)).not.toContain("capture.bin.gz");
  await expect(splitCapturePromise({...options,sourceRevision:"second"})).rejects.toThrow();
  expect(readFileSync(join(outputDirectory, "manifest.json"))).toEqual(manifestBytes);
  const chunk = manifest.chunks.find((chunk) => chunk.kind === "lap")!;
  const restored = [...iterateSessionCaptureRecords(readFileSync(join(outputDirectory, chunk.path)))];
  expect(restored.filter((record) => record.kind === "frame").map((record) => record.frame)).toEqual([Buffer.from([1])]);
});
