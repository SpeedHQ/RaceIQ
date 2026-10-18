import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";
import { syncDirectoryTree } from "@raceiq/capture-formats/session/durable-directory";
import type { StreamingMemberDescriptor, StreamingMemberKind, StreamingMemberStage, StreamingSplitterHost } from "./streaming";
import { updateNativeRecordDigest } from "./streaming";
import { createStreamingPositionSpool, type PreparedPositionFile } from "./streaming-spool";

export interface StreamingArchiveCommit {
  (member: StreamingMemberDescriptor & { readonly compressedByteLength: number; readonly memberOffset: number }): Promise<unknown>;
}
export interface FileStreamingHostOptions {
  readonly archivePath: string;
  readonly maxQueuedBytes: number;
  readonly maxUnresolvedBytes: number;
  readonly auxiliaryMemberBytes?: number;
  readonly initialCommittedLength?: number;
  readonly commit: StreamingArchiveCommit;
}


async function* readStageRecords(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const source = createReadStream(path);
  const gunzip = createGunzip();
  const abort = () => {
    source.destroy();
    gunzip.destroy();
  };
  const forwardSourceError = (error: Error) => gunzip.destroy(error);
  signal?.addEventListener("abort", abort, { once: true });
  source.on("error", forwardSourceError);
  source.pipe(gunzip);
  try {
    const records = iterateSessionCaptureRecordsAsync(gunzip, { strict: true });
    for await (const record of records) {
      signal?.throwIfAborted();
      yield record;
    }
    signal?.throwIfAborted();
  } finally {
    source.removeListener("error", forwardSourceError);
    signal?.removeEventListener("abort", abort);
    source.destroy();
    gunzip.destroy();
  }
}
/** Concrete bounded staging, production-framing semantic verification, and append-only archive writer. */
export class FileStreamingSplitterHost implements StreamingSplitterHost {
  readonly maxQueuedBytes: number;
  readonly maxUnresolvedBytes: number;
  readonly auxiliaryMemberBytes: number;
  private readonly archivePath: string;
  private readonly stageDirectory: string;
  private committedLength: number;
  private readonly options: FileStreamingHostOptions;
  private preparedStage?: Promise<{ path: string; file: FileHandle }>;
  private preparedPosition?: Promise<PreparedPositionFile>;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(options: FileStreamingHostOptions) {
    this.options = options;
    this.archivePath = options.archivePath;
    this.stageDirectory = join(dirname(options.archivePath), ".live-staging");
    this.maxQueuedBytes = options.maxQueuedBytes;
    this.maxUnresolvedBytes = options.maxUnresolvedBytes;
    this.auxiliaryMemberBytes = options.auxiliaryMemberBytes ?? 64 * 1024 * 1024;
    this.committedLength = options.initialCommittedLength ?? 0;
    this.prepareStage();
    this.preparePosition();
  }

  private prepareStage(): void {
    if (this.preparedStage || this.disposed) return;
    this.preparedStage = (async () => {
      await mkdir(this.stageDirectory, { recursive: true });
      const path = join(this.stageDirectory, `${randomUUID()}.gz`);
      return { path, file: await open(path, "wx") };
    })();
    void this.preparedStage.catch(() => undefined);
  }

  private preparePosition(): void {
    if (this.preparedPosition || this.disposed) return;
    this.preparedPosition = (async () => {
      await mkdir(this.stageDirectory, { recursive: true });
      const path = join(this.stageDirectory, `${randomUUID()}.positions`);
      return { path, file: await open(path, "wx") };
    })();
    void this.preparedPosition.catch(() => undefined);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      const errors: unknown[] = [];
      for (const pending of [this.preparedStage, this.preparedPosition]) {
        if (!pending) continue;
        try {
          const resource = await pending;
          try { await resource.file.close(); } catch (error) { errors.push(error); }
          try { await rm(resource.path, { force: true }); } catch (error) { errors.push(error); }
        } catch (error) { errors.push(error); }
      }
      this.preparedStage = undefined;
      this.preparedPosition = undefined;
      if (errors.length) throw new AggregateError(errors, "Failed to dispose prepared streaming resources");
    })();
    return this.disposal;
  }

  async createPositionSpool() {
    if (this.disposed) throw new Error("Streaming host is disposed");
    this.preparePosition();
    const pending = this.preparedPosition!;
    this.preparedPosition = undefined;
    this.preparePosition();
    const prepared = await pending;
    return createStreamingPositionSpool(this.stageDirectory, prepared);
  }

  async createStage(kind: StreamingMemberKind, _id: string): Promise<StreamingMemberStage> {
    if (this.disposed) throw new Error("Streaming host is disposed");
    this.prepareStage();
    const pending = this.preparedStage!;
    this.preparedStage = undefined;
    this.prepareStage();
    const { path, file } = await pending;
    const gzip = createGzip();
    const output = file.createWriteStream();
    const completion = pipeline(gzip, output);
    void completion.catch(() => undefined);
    let closed = false;
    let committed = false;
    const input = Buffer.allocUnsafe(64 * 1024);
    let bufferedBytes = 0;
    const write = (bytes: Uint8Array) => new Promise<void>((resolve, reject) =>
      gzip.write(bytes, (error) => error ? reject(error) : resolve()));
    const flushInput = async () => {
      if (bufferedBytes === 0) return;
      await write(bufferedBytes === input.length ? input : input.subarray(0, bufferedBytes));
      bufferedBytes = 0;
    };
    const append = async (bytes: Uint8Array) => {
      if (closed) throw new Error("Streaming stage is closed");
      if (bytes.byteLength >= input.length) {
        await flushInput();
        await write(bytes);
        return;
      }
      if (bufferedBytes + bytes.byteLength > input.length) await flushInput();
      input.set(bytes, bufferedBytes);
      bufferedBytes += bytes.byteLength;
      if (bufferedBytes === input.length) await flushInput();
    };
    return {
      append,
      readRecords(signal) {
        if (!closed) throw new Error("Cannot read an open streaming stage");
        return readStageRecords(path, signal);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await flushInput();
        gzip.end(); await completion;
      },
      verify: async (expected, signal) => {
        if (!closed) throw new Error("Cannot verify an open streaming stage");
        signal?.throwIfAborted();
        const hash = createHash("sha256");
        const contextHash = createHash("sha256");
        let count = 0;
        const iterator = readStageRecords(path, signal)[Symbol.asyncIterator]();
        try {
          if (expected.lap?.parserCheckpoint?.byteLength) {
            const bootstrap = await iterator.next();
            if (bootstrap.done || bootstrap.value.kind !== "parser-bootstrap" ||
              !Buffer.from(bootstrap.value.payload).equals(Buffer.from(expected.lap.parserCheckpoint)) ||
              createHash("sha256").update(bootstrap.value.payload).digest("hex") !== expected.parserBootstrapHash) {
              throw new Error("Staged parser initialization prefix differs from checkpoint");
            }
          }
          for (;;) {
            signal?.throwIfAborted();
            const next = await iterator.next();
            if (next.done) break;
            if (count < expected.recordCount) updateNativeRecordDigest(hash, next.value);
            else {
              if (next.value.kind !== "frame") throw new Error("Completion context contains non-frame metadata");
              updateNativeRecordDigest(contextHash, next.value);
            }
            count++;
          }
        } finally { await iterator.return?.(); }
        if (count !== expected.recordCount + expected.trailingContextFrameCount || hash.digest("hex") !== expected.nativeDigest ||
            (expected.trailingContextFrameCount > 0 && contextHash.digest("hex") !== expected.trailingContextDigest)) throw new Error(`Staged ${kind} member failed native semantic verification`);
      },
      commit: async (descriptor, signal) => {
        if (!closed || committed) throw new Error("Stage must be closed and committed exactly once");
        signal?.throwIfAborted();
        let memberOffset = 0;
        let newArchive = false;
        try { memberOffset = (await stat(this.archivePath)).size; } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          newArchive = true;
        }
        if (memberOffset !== this.committedLength) throw new Error("Archive append found an unexpected or uncommitted suffix");
        const compressedByteLength = (await stat(path)).size;
        const archive = await open(this.archivePath, "a");
        try {
          const source = createReadStream(path);
          for await (const part of source) {
            let offset = 0;
            while (offset < part.byteLength) {
              signal?.throwIfAborted();
              const result = await archive.write(part, offset, part.byteLength - offset, null);
              if (result.bytesWritten === 0) throw new Error("Archive append made no write progress");
              offset += result.bytesWritten;
            }
          }
          await archive.sync();
        } finally { await archive.close(); }
        if (newArchive) await syncDirectoryTree(dirname(this.archivePath));
        signal?.throwIfAborted();
        committed = true;
        const result = await this.options.commit({ ...descriptor, memberOffset, compressedByteLength });
        this.committedLength = memberOffset + compressedByteLength;
        await rm(path, { force: true });
        return result;
      },
      discard: async () => {
        closed = true;
        gzip.destroy();
        await completion.catch(() => undefined);
        await rm(path, { force: true });
      },
    };
  }
}

