export async function waitForSourcePrefix(sourceByteOffset: number): Promise<{ sourcePath: string | null; fileDev: string; fileIno: string }> {
  if (!Number.isSafeInteger(sourceByteOffset) || sourceByteOffset < 0) throw new RangeError("Invalid source prefix wait offset");
  await writing;
  if (terminal && sourceByteOffset > latestSourceByteLength) throw new Error("Source writer stopped before requested prefix");
  if (latestSourceByteLength < sourceByteOffset) throw new Error("Source writer has not accepted requested prefix");
  return { sourcePath: filePath, fileDev, fileIno };
}
import { parentPort, workerData } from "node:worker_threads";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectoryTree } from "./durable-directory";
if (!parentPort) throw new Error("Source writer requires worker thread");
const port = parentPort;
let handle: FileHandle | null = null;
let filePath: string | null = null;
let fileExclusive = false;
let terminal = false;
let admissionClosed = false;
let writing: Promise<void> = Promise.resolve();
let latestSequence = 0;
let latestDurableSequence = 0;
let latestSourceByteLength = 0;
let latestFrameCount = 0;
let latestSourceRecordCount = 0;
let bytesWritten = 0;
let fileDev = "";
let fileIno = "";
let directoryDurable = false;
const failSequence = (workerData as { failSequence?: number } | undefined)?.failSequence;
const syncIntervalMs = Number((workerData as { syncIntervalMs?: number } | undefined)?.syncIntervalMs ?? 1000);
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncQueued = false;

function queueSync(): void {
  if (syncQueued || terminal || admissionClosed) return;
  syncQueued = true;
  writing = writing.then(() => terminal ? undefined : syncFile()).catch(fail).finally(() => { syncQueued = false; });
}
async function writeAll(data: Uint8Array, position: number | null = null): Promise<void> {
  if (!handle) throw new Error("Source writer file is not open");
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position === null ? null : position + written);
    if (result.bytesWritten === 0) throw new Error("Source writer made no write progress");
    written += result.bytesWritten;
  }
}

async function writeRecords(records: readonly { bytes: Uint8Array }[]): Promise<void> {
  if (!handle) throw new Error("Source writer file is not open");
  const buffers = records.map((record) => record.bytes);
  let index = 0, consumed = 0;
  while (index < buffers.length) {
    const end = Math.min(buffers.length, index + 1024);
    const vectors = index === 0 && consumed === 0 && end === buffers.length ? buffers : buffers.slice(index, end);
    if (consumed) vectors[0] = vectors[0]!.subarray(consumed);
    const result = await handle.writev(vectors);
    if (result.bytesWritten === 0) throw new Error("Source writer made no write progress");
    let remaining = result.bytesWritten;
    while (remaining > 0) {
      const available = buffers[index]!.byteLength - consumed;
      if (remaining < available) { consumed += remaining; remaining = 0; }
      else { remaining -= available; index++; consumed = 0; }
    }
  }
}

async function syncFile(announce = true): Promise<void> {
  if (!handle || terminal) return;
  await handle.sync();
  if (filePath && !directoryDurable) {
    await syncDirectoryTree(dirname(filePath));
    directoryDurable = true;
  }
  latestDurableSequence = latestSequence;
  if (announce) port.postMessage({
    type: "durable", sequence: latestDurableSequence, sourceByteLength: latestSourceByteLength,
    frameCount: latestFrameCount, sourceRecordCount: latestSourceRecordCount, fileDev, fileIno,
  });
}

port.on("message", (message: { type: string; path?: string; exclusiveFile?: boolean; headerCountOffset?: number | null; patchCountOnClose?: boolean; records?: { sequence: number; bytes: Uint8Array; chargeBytes: number; sourceByteLength: number; frameCount: number; sourceRecordCount: number }[]; sequence?: number; count?: number; hadMeta?: boolean; requestId?: number; bytes?: number }) => {
  if (terminal || admissionClosed) return;
  if (message.type === "start") {
    filePath = message.path ?? null;
    fileExclusive = message.exclusiveFile ?? false;
    directoryDurable = false;
    if (syncIntervalMs > 0) syncTimer = setInterval(queueSync, syncIntervalMs);
  } else if (message.type === "batch") {
    const records = message.records ?? [];
    const batchBytes = records.reduce((sum, record) => sum + record.chargeBytes, 0);
    writing = writing.then(async () => {
      if (terminal) return;
      if (!filePath) throw new Error("Writer path missing");
      if (!handle) {
        await mkdir(dirname(filePath), { recursive: true });
        handle = await open(filePath, fileExclusive ? "wx" : "w");
        const stats = await handle.stat({ bigint: true });
        fileDev = stats.dev.toString();
        fileIno = stats.ino.toString();
      }
      if (failSequence !== undefined && records.some((record) => record.sequence === failSequence)) throw new Error("Injected source writer write failure");
      await writeRecords(records);
      for (const record of records) {
        latestSequence = record.sequence;
        latestSourceByteLength = record.sourceByteLength;
        latestFrameCount = record.frameCount;
        latestSourceRecordCount = record.sourceRecordCount;
        bytesWritten += record.bytes.byteLength;
      }
      port.postMessage({
        type: "ack", sequence: latestSequence, bytes: batchBytes, sourceByteLength: latestSourceByteLength,
        frameCount: latestFrameCount, sourceRecordCount: latestSourceRecordCount, fileDev, fileIno,
      });
    }).catch(fail);
  } else if (message.type === "sync-request") {
    writing = writing.then(async () => {
      if (terminal) return;
      await syncFile(false);
      if (!terminal) port.postMessage({
        type: "sync-ack", requestId: message.requestId, bytes: message.bytes, sequence: latestSequence,
        sourceByteLength: latestSourceByteLength, frameCount: latestFrameCount, sourceRecordCount: latestSourceRecordCount, fileDev, fileIno,
      });
    }).catch(fail);
  } else if (message.type === "close") {
    admissionClosed = true;
    clearInterval(syncTimer ?? undefined);
    writing = writing.then(async () => {
      if (terminal) return;
      if (handle && filePath) {
        await handle.sync();
        const closeCount = message.count ?? 0;
        const countOffset = message.headerCountOffset ?? 8;
        if (message.headerCountOffset !== null && (message.hadMeta || message.patchCountOnClose)) {
          const countBytes = Buffer.allocUnsafe(4);
          countBytes.writeUInt32LE(closeCount);
          await writeAll(countBytes, countOffset);
        }
        await handle.sync();
        await handle.close();
        handle = null;
        if (!directoryDurable) {
          await syncDirectoryTree(dirname(filePath));
          directoryDurable = true;
        }
      }
      terminal = true;
      latestDurableSequence = latestSequence;
      port.postMessage({
        type: "durable", sequence: latestSequence, sourceByteLength: latestSourceByteLength,
        frameCount: latestFrameCount, sourceRecordCount: latestSourceRecordCount, fileDev, fileIno,
      });
      port.postMessage({ type: "closed", sequence: latestSequence, bytes: bytesWritten, fileDev, fileIno });
    }).catch(fail);
  }
});

function fail(error: unknown): void {
  if (terminal) return;
  terminal = true;
  admissionClosed = true;
  clearInterval(syncTimer ?? undefined);
  const detail = error instanceof Error ? error.message : String(error);
  port.postMessage({ type: "failed", error: detail, sequence: latestDurableSequence });
  void handle?.close().catch(() => {});
  handle = null;
}
