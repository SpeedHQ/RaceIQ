import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, readFile, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreopenedFileWriter } from "@raceiq/capture-formats/session/preopened-file-writer";

const directories: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => { for (const spy of spies.splice(0)) spy.mockRestore(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporaryDirectory(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "raceiq-writer-")); directories.push(directory); return directory; }

describe("PreopenedFileWriter", () => {
  test("reserves file paths synchronously, rotates, and closes completed files", async () => {
    const closed: string[] = [];
    const directory = await temporaryDirectory();
    const writer = new PreopenedFileWriter(directory, { maxBatchDelayMs: 2, onClosed: info => { closed.push(info.path); } });
    const first = writer.active;
    expect(first.path.endsWith(".bin")).toBe(true);
    writer.appendOwned(Buffer.from("one"));
    expect(first.byteLength).toBe(3);
    await writer.ready;
    expect(writer.standbyReady).toBe(true);
    const rotation = writer.rotate();
    expect(rotation.previous.path).toBe(first.path);
    expect(rotation.current.path).not.toBe(first.path);
    writer.appendOwned(Buffer.from("two"));
    await writer.close();
    expect(await readFile(first.path, "utf8")).toBe("one");
    expect(await readFile(rotation.current.path, "utf8")).toBe("two");
    expect(closed).toContain(first.path);
    expect(closed).toContain(rotation.current.path);
  });

  test("handles real FileHandle partial writes without losing vector bytes", async () => {
    const directory = await temporaryDirectory();
    const probe = await open(join(directory, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as { writev: FileHandle["writev"] };
    const originalWritev = prototype.writev;
    const spy = spyOn(prototype, "writev").mockImplementation(async function <TBuffers extends readonly NodeJS.ArrayBufferView[]>(this: FileHandle, buffers: TBuffers, position?: number) {
      let remaining = 2;
      const partial: Buffer[] = [];
      for (const buffer of buffers) {
        if (remaining === 0) break;
        const part = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).subarray(0, remaining);
        partial.push(part);
        remaining -= part.length;
      }
      const result = await originalWritev.call(this, partial, position);
      return { bytesWritten: result.bytesWritten, buffers };
    });
    spies.push(spy);
    await probe.close();
    const writer = new PreopenedFileWriter(directory, { maxBatchDelayMs: 1000 });
    await writer.ready;
    const path = writer.active.path;
    writer.appendOwned(Buffer.from("abc"));
    writer.appendOwned(Buffer.from("defgh"));
    await writer.close();
    expect(await readFile(path, "utf8")).toBe("abcdefgh");
  });

  test("treats zero-progress writes as failure and does not publish incomplete files", async () => {
    const directory = await temporaryDirectory();
    const probe = await open(join(directory, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as { writev: FileHandle["writev"] };
    const spy = spyOn(prototype, "writev").mockImplementation(async function <TBuffers extends readonly NodeJS.ArrayBufferView[]>(buffers: TBuffers) {
      return { bytesWritten: 0, buffers };
    });
    spies.push(spy);
    await probe.close();
    const closed: string[] = [];
    const writer = new PreopenedFileWriter(directory, { maxBatchDelayMs: 1000, onClosed: info => { closed.push(info.path); } });
    await writer.ready;
    const path = writer.active.path;
    writer.appendOwned(Buffer.from("unfinished"));
    await expect(writer.close()).rejects.toThrow("File write made no progress");
    expect(closed).not.toContain(path);
    expect(await readFile(path, "utf8")).toBe("");
  });

  test("latches queue overflow but writes previously accepted bytes", async () => {
    const directory = await temporaryDirectory();
    const writer = new PreopenedFileWriter(directory, { maxQueuedBytes: 3, maxBatchDelayMs: 1000 });
    await writer.ready;
    writer.appendOwned(Buffer.from("abc"));
    const path = writer.active.path;
    expect(() => writer.appendOwned(Buffer.from("d"))).toThrow("Writer queue capacity exceeded");
    expect(() => writer.appendOwned(Buffer.from("e"))).toThrow("Writer queue capacity exceeded");
    await expect(writer.close()).rejects.toThrow("Writer queue capacity exceeded");
    expect(await readFile(path, "utf8")).toBe("abc");
    expect(writer.queuedBytes).toBe(0);
  });

  test("cleans partially initialized files after asynchronous open failure", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "not-a-directory");
    await writeFile(filePath, "x");
    const writer = new PreopenedFileWriter(join(filePath, "child"));
    await expect(writer.ready).rejects.toBeDefined();
    await expect(writer.close()).rejects.toBeDefined();
    expect(await readFile(filePath, "utf8")).toBe("x");
  });

  test("rejects rotation before standby readiness and removes unused standby", async () => {
    const directory = await temporaryDirectory();
    const writer = new PreopenedFileWriter(directory);
    expect(() => writer.rotate()).toThrow("Standby file is not ready");
    await writer.ready;
    await writer.close();
    expect((await readdir(directory)).length).toBe(0);
  });

  test("flush cancels pending delay when batch reaches threshold", async () => {
    const directory = await temporaryDirectory();
    let markWritten!: () => void;
    const written = new Promise<void>(resolve => { markWritten = resolve; });
    const writer = new PreopenedFileWriter(directory, { maxBatchBytes: 4, maxBatchDelayMs: 1000, onWritten: () => markWritten() });
    await writer.ready;
    const path = writer.active.path;
    writer.appendOwned(Buffer.from("a"));
    writer.appendOwned(Buffer.from("bcd"));
    await written;
    expect(await readFile(path, "utf8")).toBe("abcd");
    await writer.close();
  });

  test("caps outstanding retirements without blocking appends to active file", async () => {
    const directory = await temporaryDirectory();
    let releaseDurability!: () => void;
    let markDurability!: () => void;
    const durabilityStarted = new Promise<void>(resolve => { markDurability = resolve; });
    const durabilityGate = new Promise<void>(resolve => { releaseDurability = resolve; });
    let firstRetirement = true;
    const writer = new PreopenedFileWriter(directory, {
      maxRetiringFiles: 1,
      onDurable: async () => {
        if (firstRetirement) { firstRetirement = false; markDurability(); await durabilityGate; }
      },
    });
    await writer.ready;
    let secondFile: string;
    try {
      writer.appendOwned(Buffer.from("A"));
      writer.rotate();
      await durabilityStarted;
      await writer.standbyOpened;
      secondFile = writer.active.path;
      expect(() => writer.rotate()).toThrow();
      writer.appendOwned(Buffer.from("B"));
    } finally {
      releaseDurability();
      await writer.close();
    }
    expect(await readFile(secondFile, "utf8")).toBe("B");
  });

  test("close waits for in-flight write completion before syncing and closing", async () => {
    const directory = await temporaryDirectory();
    const probe = await open(join(directory, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as { writev: FileHandle["writev"] };
    const originalWritev = prototype.writev;
    let allowWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>(resolve => { allowWrite = resolve; });
    const spy = spyOn(prototype, "writev").mockImplementation(async function <TBuffers extends readonly NodeJS.ArrayBufferView[]>(this: FileHandle, buffers: TBuffers, position?: number) {
      markWriteStarted();
      await writeGate;
      const result = await originalWritev.call(this, buffers, position);
      return { bytesWritten: result.bytesWritten, buffers };
    });
    spies.push(spy);
    await probe.close();
    const writer = new PreopenedFileWriter(directory, { maxBatchDelayMs: 0 });
    await writer.ready;
    const path = writer.active.path;
    writer.appendOwned(Buffer.from("durable"));
    await writeStarted;
    const closing = writer.close();
    allowWrite();
    await closing;
    expect(await readFile(path, "utf8")).toBe("durable");
  });

  test("flush immediately writes bytes despite a pending idle timer", async () => {
    const directory = await temporaryDirectory();
    let markWritten!: () => void;
    const written = new Promise<void>(resolve => { markWritten = resolve; });
    const writer = new PreopenedFileWriter(directory, { maxBatchDelayMs: 1000, onWritten: () => markWritten() });
    await writer.ready;
    const path = writer.active.path;
    writer.appendOwned(Buffer.from("flush"));
    writer.flush();
    await written;
    expect(await readFile(path, "utf8")).toBe("flush");
    await writer.close();
  });
});
