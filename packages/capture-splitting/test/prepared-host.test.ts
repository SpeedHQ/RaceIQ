import { syncDirectory, syncDirectoryTree } from "@raceiq/capture-formats/session/durable-directory";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ReadStream } from "node:fs";
import type { Gunzip } from "node:zlib";
import { join } from "node:path";
import { encodeFrameLength } from "@raceiq/capture-formats/session/framing";
import { FileStreamingSplitterHost } from "../src/streaming-host";

function host(root: string, archivePath = join(root, "archive.gz")) {
  return new FileStreamingSplitterHost({
    archivePath, maxQueuedBytes: 1024, maxUnresolvedBytes: 2048,
    commit: async () => undefined,
  });
}

test("prepared stage is open and replenishes one bounded gzip stage and position journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-host-"));
  const fileHost = host(root);
  try {
    const staging = join(root, ".live-staging");
    const first = await fileHost.createStage("lap", "lap-1");
    await first.append(Buffer.concat([encodeFrameLength(9), Buffer.from("first lap")]));
    await first.close();
    expect((await Array.fromAsync(first.readRecords())).map((record) => record.kind === "frame" ? record.frame.toString() : record.kind)).toEqual(["first lap"]);
    await first.discard();
    const second = await fileHost.createStage("auxiliary", "aux-1");
    await second.append(Buffer.concat([encodeFrameLength(10), Buffer.from("second lap")]));
    await second.close();
    expect((await Array.fromAsync(second.readRecords())).map((record) => record.kind === "frame" ? record.frame.toString() : record.kind)).toEqual(["second lap"]);
    await second.discard();
    const spool = await fileHost.createPositionSpool();
    await spool.append({ offset: 2, endOffset: 5, ordinal: 1 });
    expect(await Array.fromAsync(spool.positions())).toEqual([{ offset: 2, endOffset: 5, ordinal: 1 }]);
    await spool.discard();
    await fileHost.dispose();
    expect(await readdir(staging)).toEqual([]);
  } finally {
    await fileHost.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test("early staged-record iteration return releases staged reader and preserves full reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-reader-"));
  const fileHost = host(root);
  try {
    const stage = await fileHost.createStage("lap", "lap-reader");
    const frames = Array.from({ length: 64 }, (_, index) => {
      const frame = Buffer.alloc(1024, index);
      return Buffer.concat([encodeFrameLength(frame.byteLength), frame]);
    });
    await stage.append(Buffer.concat(frames));
    await stage.close();

    const sources: ReadStream[] = [];
    const decompressors: Gunzip[] = [];
    const createRead = fs.createReadStream;
    const createGunzip = zlib.createGunzip;
    const readSpy = spyOn(fs, "createReadStream").mockImplementation((...args) => {
      const source = createRead(...args);
      sources.push(source);
      return source;
    });
    const gunzipSpy = spyOn(zlib, "createGunzip").mockImplementation((...args) => {
      const decompressor = createGunzip(...args);
      decompressors.push(decompressor);
      return decompressor;
    });
    try {
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(Array.fromAsync(stage.readRecords(alreadyAborted.signal))).rejects.toThrow();
      expect(sources).toHaveLength(0);
      expect(decompressors).toHaveLength(0);
      const early = stage.readRecords()[Symbol.asyncIterator]();
      expect((await early.next()).done).toBe(false);
      await early.return?.();
      expect(sources).toHaveLength(1);
      expect(decompressors).toHaveLength(1);
      expect(sources[0].destroyed).toBe(true);
      expect(decompressors[0].destroyed).toBe(true);
      sources.length = 0;
      decompressors.length = 0;
      const controller = new AbortController();
      const cancelled = stage.readRecords(controller.signal)[Symbol.asyncIterator]();
      expect((await cancelled.next()).done).toBe(false);
      controller.abort();
      await expect(cancelled.next()).rejects.toThrow();
      expect(sources[0].destroyed).toBe(true);
      expect(decompressors[0].destroyed).toBe(true);
      sources.length = 0;
      decompressors.length = 0;
      const malformed = await fileHost.createStage("lap", "lap-malformed");
      await malformed.append(Buffer.concat([encodeFrameLength(9), Buffer.from([1])]));
      await malformed.close();
      await expect(Array.fromAsync(malformed.readRecords())).rejects.toThrow("Truncated session capture record");
      expect(sources[0].destroyed).toBe(true);
      expect(decompressors[0].destroyed).toBe(true);
      await malformed.discard();
      sources.length = 0;
      decompressors.length = 0;
      const missing = await fileHost.createStage("lap", "lap-missing");
      await missing.close();
      await missing.discard();
      await expect(Array.fromAsync(missing.readRecords())).rejects.toThrow();
      expect(sources[0].destroyed).toBe(true);
      expect(decompressors[0].destroyed).toBe(true);
    } finally {
      readSpy.mockRestore();
      gunzipSpy.mockRestore();
    }

    const fullRead = await Array.fromAsync(stage.readRecords());
    expect(fullRead).toHaveLength(frames.length);
    expect(fullRead.map((record) => record.kind === "frame" ? record.frame.byteLength : 0))
      .toEqual(frames.map((frame) => frame.byteLength - 4));
    await stage.discard();
  } finally {
    await fileHost.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose waits for prewarm and removes unused stage and journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-dispose-"));
  const fileHost = host(root);
  await Promise.all([fileHost.dispose(), fileHost.dispose()]);
  expect(await readdir(join(root, ".live-staging"))).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

test("failed staging destination rejects createStage and leaves no prepared artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-failure-"));
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "blocker");
  const fileHost = host(root, join(blocker, "archive.gz"));
  await expect(fileHost.createStage("lap", "lap-1")).rejects.toThrow();
  await expect(fileHost.dispose()).rejects.toThrow("Failed to dispose prepared streaming resources");
  await expect(fileHost.dispose()).rejects.toThrow("Failed to dispose prepared streaming resources");
  expect(await readdir(root)).toEqual(["not-a-directory"]);
  await rm(root, { recursive: true, force: true });
});


test("directory synchronization accepts existing directories but preserves missing-path errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-directory-sync-"));
  try {
    await expect(syncDirectoryTree(root)).resolves.toBeUndefined();
    await expect(syncDirectory(root)).resolves.toBeUndefined();
    await expect(syncDirectory(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(syncDirectoryTree(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

if (process.platform === "win32") {
  test("Windows directory fallback never swallows a regular-file sync failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-directory-sync-file-"));
    try {
      const path = join(root, "capture.bin");
      await writeFile(path, "retained capture");
      await expect(syncDirectoryTree(path)).rejects.toMatchObject({ code: "EPERM" });
      await expect(syncDirectory(path)).rejects.toMatchObject({ code: "EPERM" });
      expect(await fs.promises.readFile(path, "utf8")).toBe("retained capture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
