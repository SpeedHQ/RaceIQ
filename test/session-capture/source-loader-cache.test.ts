import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _sourceLoaderCacheForTest,
  loadSessionSource,
  type SessionCaptureSource,
} from "../../server/session-capture/source-loader";

describe("source-loader byte cache", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "raceiq-source-cache-"));
    _sourceLoaderCacheForTest.clear();
    _sourceLoaderCacheForTest.setMaxBytes(256 * 1024 * 1024);
  });

  afterEach(() => {
    _sourceLoaderCacheForTest.clear();
    _sourceLoaderCacheForTest.resetMaxBytes();
    rmSync(dir, { recursive: true, force: true });
  });

  function source(name: string): SessionCaptureSource {
    return { rawFile: join(dir, name), source: null, gameId: "f1-2025", carOrdinal: 0, trackOrdinal: 0 };
  }

  test("accounts decompressed capture bytes and evicts least recently used entry", async () => {
    const first = source("first.bin");
    const second = source("second.bin");
    writeFileSync(first.rawFile, Buffer.alloc(6));
    writeFileSync(second.rawFile, Buffer.alloc(6));
    _sourceLoaderCacheForTest.setMaxBytes(6);

    await loadSessionSource(first);
    await loadSessionSource(second);

    expect(_sourceLoaderCacheForTest.bytesUsed()).toBe(6);
    expect(_sourceLoaderCacheForTest.entries()).toBe(1);
  });

  test("returns oversize source without retaining it", async () => {
    const capture = source("large.bin");
    writeFileSync(capture.rawFile, Buffer.alloc(7));
    _sourceLoaderCacheForTest.setMaxBytes(6);

    const loaded = await loadSessionSource(capture);

    expect(loaded.kind).toBe("capture");
    expect(_sourceLoaderCacheForTest.entries()).toBe(0);
    expect(_sourceLoaderCacheForTest.bytesUsed()).toBe(0);
  });

  test("deduplicates concurrent uncached loads", async () => {
    const capture = source("concurrent.bin");
    writeFileSync(capture.rawFile, Buffer.alloc(8));

    const [first, second] = await Promise.all([
      loadSessionSource(capture),
      loadSessionSource(capture),
    ]);

    expect(first).toBe(second);
    expect(_sourceLoaderCacheForTest.inFlight()).toBe(0);
  });

  test("failed load remains retryable", async () => {
    const capture = source("retry.bin");
    await expect(loadSessionSource(capture)).rejects.toBeDefined();
    expect(_sourceLoaderCacheForTest.inFlight()).toBe(0);
    writeFileSync(capture.rawFile, Buffer.alloc(3));

    await expect(loadSessionSource(capture)).resolves.toMatchObject({ kind: "capture" });
    expect(_sourceLoaderCacheForTest.entries()).toBe(1);
  });
});
