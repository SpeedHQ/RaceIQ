import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
export interface PreopenedFileInfo { id: string; path: string; byteLength: number }
export interface PreopenedFileWriterOptions {
  maxRetiringFiles?: number;
  maxQueuedBytes?: number;
  maxBatchBytes?: number;
  maxBatchDelayMs?: number;
  onClosed?: (info: PreopenedFileInfo) => void | Promise<void>;
  onFailure?: (error: unknown) => void;
  onWritten?: (info: PreopenedFileInfo, bytes: number, durationMs: number) => void;
  onDurable?: (info: PreopenedFileInfo) => void | Promise<void>;
}
type FileState = {
  info: PreopenedFileInfo;
  handle: Promise<FileHandle>;
  queue: Buffer[];
  queued: number;
  head: number;
  writtenBytes: number;
  durable: boolean;
  closeSuccessful: boolean;
  timer?: NodeJS.Timeout;
  drain?: Promise<void>;
  close?: Promise<void>;
  closed: boolean;
  enqueuedAt?: number;
  opened?: FileHandle;
};

/** Low-latency bounded writer backed by an active and pre-opened standby file. */
export class PreopenedFileWriter {
  readonly ready: Promise<void>;
  get active(): PreopenedFileInfo { return this.activeState.info; }
  private activeState: FileState;
  private standby?: FileState;
  private standbyPromise: Promise<FileState>;
  private readonly retirees = new Set<Promise<void>>();
  private readonly states = new Set<FileState>();
  private readonly maxQueued: number;
  private readonly maxRetiring: number;
  private writeFailed = false;
  private readonly maxBatch: number;
  private readonly delay: number;
  private readonly onClosed?: PreopenedFileWriterOptions["onClosed"];
  private readonly onFailure?: PreopenedFileWriterOptions["onFailure"];
  private readonly onWritten?: PreopenedFileWriterOptions["onWritten"];
  private readonly onDurable?: PreopenedFileWriterOptions["onDurable"];
  private queued = 0;
  private failure?: unknown;
  private closing?: Promise<void>;
  private readonly directory: string;

  constructor(directory: string, options: PreopenedFileWriterOptions = {}) {
    this.directory = directory;
    this.maxQueued = options.maxQueuedBytes ?? 16 * 1024 * 1024;
    this.maxRetiring = options.maxRetiringFiles ?? 4;
    this.maxBatch = options.maxBatchBytes ?? 64 * 1024;
    this.delay = options.maxBatchDelayMs ?? 8;
    this.onClosed = options.onClosed;
    this.onFailure = options.onFailure;
    this.onWritten = options.onWritten;
    this.onDurable = options.onDurable;
    if (![this.maxQueued, this.maxRetiring, this.maxBatch].every(Number.isSafeInteger) || this.maxQueued < 1 || this.maxRetiring < 1 || this.maxBatch < 1 || !Number.isFinite(this.delay) || this.delay < 0) throw new RangeError("Invalid writer limits");
    this.activeState = this.makeState();
    
    this.standby = this.makeState();
    this.standbyPromise = Promise.all([this.activeState.handle, this.standby.handle]).then(() => this.standby!).catch(error => { this.fail(error); throw error; });
    void this.standbyPromise.catch(() => {});
    this.ready = Promise.all([this.activeState.handle, this.standby.handle]).then(() => undefined).catch(error => {
      this.fail(error);
      return Promise.allSettled([...this.states].map(state => this.closeState(state, true))).then(() => { throw error; });
    });
    void this.ready.catch(() => {});
  }

  get queuedBytes(): number { return this.queued; }
  get error(): unknown { return this.failure; }
  get standbyReady(): boolean { return !!this.standby?.opened; }
  get standbyOpened(): Promise<PreopenedFileInfo> { return this.standbyPromise.then(state => state.info); }

  appendOwned(bytes: Buffer): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.closing) throw new Error("Writer is closing");
    if (!Buffer.isBuffer(bytes)) throw new TypeError("appendOwned requires a Buffer");
    if (this.queued + bytes.length > this.maxQueued) {
      const error = new Error("Writer queue capacity exceeded"); this.fail(error); throw error;
    }
    if (bytes.length === 0) return;
    const state = this.activeState;
    if (state.queued === 0) state.enqueuedAt = performance.now();
    state.queue.push(bytes);
    state.queued += bytes.length;
    state.info.byteLength += bytes.length;
    this.queued += bytes.length;
    if (state.opened) this.schedule(state);
  }

  rotate(): { previous: PreopenedFileInfo; current: PreopenedFileInfo } {
    if (this.failure !== undefined) throw this.failure;
    if (this.closing) throw new Error("Writer is closing");
    if (!this.standby?.opened) throw new Error("Standby file is not ready");
    if (this.retirees.size >= this.maxRetiring) throw new Error("Retiring file limit reached");
    const previous = this.activeState;
    this.activeState = this.standby;
    this.standby = undefined;
    this.retire(previous);
    const replenishing = this.makeState();
    this.standbyPromise = replenishing.handle.then(() => {
      if (!this.closing && this.failure === undefined) this.standby = replenishing;
      else void this.closeState(replenishing, true);
      return replenishing;
    });
    void this.standbyPromise.catch(error => this.fail(error));
    return { previous: previous.info, current: this.activeState.info };
  }

  flush(): void { this.schedule(this.activeState, true); }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeImpl();
    return this.closing;
  }

  private makeState(): FileState {
    const id = randomUUID();
    const state: FileState = { info: { id, path: join(this.directory, `${id}.bin`), byteLength: 0 }, handle: Promise.resolve(undefined as never), queue: [], queued: 0, head: 0, writtenBytes: 0, durable: false, closeSuccessful: false, closed: false };
    this.states.add(state);
    state.handle = mkdir(this.directory, { recursive: true }).then(() => open(state.info.path, "wx")).then(handle => { state.opened = handle; if (state.queue.length) this.schedule(state); return handle; }).catch(error => { this.fail(error); throw error; });
    void state.handle.catch(() => {});
    return state;
  }

  private schedule(state: FileState, immediate = false): void {
    if (state.drain || state.closed || !state.opened) return;
    if (state.timer) {
      if (!immediate && state.queued < this.maxBatch) return;
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (immediate || state.queued >= this.maxBatch || this.delay === 0) void this.drain(state);
    else state.timer = setTimeout(() => { state.timer = undefined; void this.drain(state); }, this.delay);
  }

  private drain(state: FileState): Promise<void> {
    if (state.drain) return state.drain;
    const run = async () => {
      const handle = await state.handle;
      while (state.head < state.queue.length && !this.writeFailed) {
        const batch: Buffer[] = [];
        let size = 0;
        while (state.head < state.queue.length && size < this.maxBatch) {
          const next = state.queue[state.head]!;
          const take = Math.min(next.length, this.maxBatch - size);
          batch.push(take === next.length ? next : next.subarray(0, take));
          size += take;
          if (take === next.length) state.head++;
          else state.queue[state.head] = next.subarray(take);
        }
        if (state.head === state.queue.length) { state.queue.length = 0; state.head = 0; }
        else if (state.head >= 256 && state.head * 2 >= state.queue.length) { state.queue.splice(0, state.head); state.head = 0; }
        let vectorIndex = 0;
        let vectorOffset = 0;
        while (vectorIndex < batch.length) {
          const vectors = batch.slice(vectorIndex);
          if (vectorOffset) vectors[0] = vectors[0]!.subarray(vectorOffset);
          const result = await handle.writev(vectors);
          if (result.bytesWritten <= 0) throw new Error("File write made no progress");
          this.queued -= result.bytesWritten;
          state.queued -= result.bytesWritten;
          state.writtenBytes += result.bytesWritten;
          let consumed = result.bytesWritten;
          while (vectorIndex < batch.length) {
            const remaining = batch[vectorIndex]!.length - vectorOffset;
            if (consumed < remaining) { vectorOffset += consumed; break; }
            consumed -= remaining;
            vectorIndex++;
            vectorOffset = 0;
          }
          const durationMs = Math.max(0, performance.now() - (state.enqueuedAt ?? performance.now()));
          try { this.onWritten?.(state.info, result.bytesWritten, durationMs); } catch (error) { this.fail(error); throw error; }
          if (state.queued === 0) state.enqueuedAt = undefined;
        }
      }
    };
    const promise = run().catch(error => { this.writeFailed = true; this.fail(error); throw error; }).finally(() => { state.drain = undefined; if (state.head < state.queue.length && !this.writeFailed) this.schedule(state, true); });
    state.drain = promise;
    void promise.catch(() => {});
    return promise;
  }

  private retire(state: FileState): void {
    const task = this.closeState(state, false);
    this.retirees.add(task);
    void task.finally(() => this.retirees.delete(task)).catch(() => {});
  }

  private closeState(state: FileState, removeEmpty: boolean): Promise<void> {
    if (state.close) return state.close;
    state.close = (async () => {
      clearTimeout(state.timer);
      state.timer = undefined;
      while (true) {
        if (state.drain) await state.drain.catch(() => {});
        if (state.head < state.queue.length && !this.writeFailed) {
          await this.drain(state).catch(() => {});
          continue;
        }
        if (!state.drain) break;
      }
      const handle = await state.handle.catch(() => undefined);
      if (handle && !state.closed) {
        try {
          await handle.sync();
          state.durable = true;
          await this.onDurable?.(state.info);
        } catch (error) { this.fail(error); }
        try { await handle.close(); state.closeSuccessful = true; } catch (error) { this.fail(error); }
        state.closed = true;
      }
      const removeFile = removeEmpty && state.info.byteLength === 0;
      if (removeFile) await unlink(state.info.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.fail(error); });
      if (state.closeSuccessful && state.durable && state.writtenBytes === state.info.byteLength && !removeFile) {
        try { await this.onClosed?.(state.info); } catch (error) { this.fail(error); }
      }
      this.states.delete(state);
    })();
    return state.close;
  }

  private fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    try { this.onFailure?.(error); } catch {}
  }

  private async closeImpl(): Promise<void> {
    this.closing = Promise.resolve();
    await this.ready.catch(() => {});
    await Promise.allSettled([...this.states].map(state => this.closeState(state, true)));
    await this.standbyPromise.catch(() => {});
    await Promise.allSettled([...this.retirees]);
    if (this.failure !== undefined) throw this.failure;
  }
}
