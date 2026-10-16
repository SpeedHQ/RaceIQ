import { Worker } from "node:worker_threads";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, META_FRAME_BYTES, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords } from "./framing";
import { SparseCaptureEncoder } from "./sparse-recorder";

export type WorkerRecorderState = "recording" | "closing" | "closed" | "failed";
export interface WorkerRecorderOptions {
  maxInFlightBytes?: number;
  maxBatchBytes?: number;
  maxBatchRecords?: number;
  maxBatchDelayMs?: number;
  syncIntervalMs?: number;
  headerCountOffset?: number | null;
  patchCountOnClose?: boolean;
  exclusiveFile?: boolean;
  /** Raw byte writes carry complete canonical records when true. */
  canonicalRawCaptureBytes?: boolean;
  /** Existing ordered worker; caller must load source-writer-worker.ts in its worker entry. */
  worker?: Worker;
}
export interface WorkerDurabilityAcknowledgement {
  sequence: number;
  sourceByteLength: number;
  frameCount: number;
  sourceRecordCount: number;
  fileDev: string;
  fileIno: string;
}

export interface EncodedSourceEvent {
  sequence: number;
  kind: "frame" | "raw" | "segment-boundary";
  /** Sparse canonical storage offsets, including capture marker bytes. */
  offset: number;
  endOffset: number;
  /** Encoded record coordinates excluding trailing sparse marker. */
  sourceOffset: number;
  sourceEndOffset: number;
  /** Owned native bytes for frames; input bytes for raw capture events. */
  bytes: Uint8Array;
  frameTimeMs?: number;
}

const DEFAULTS = { maxInFlightBytes: 8 * 1024 * 1024, maxBatchBytes: 256 * 1024, maxBatchRecords: 256, maxBatchDelayMs: 8, syncIntervalMs: 1000, headerCountOffset: 8, patchCountOnClose: false, exclusiveFile: false, canonicalRawCaptureBytes: false };
const RECORD_TRANSPORT_OVERHEAD_BYTES = 128;
const SPARSE_MARKER_FRAME_BYTES = 16;
/** Sparse source recorder whose ingress path only encodes, reserves, and copies bounded transport bytes. */
export class WorkerSessionRecorder {
  private readonly encoder: SparseCaptureEncoder;
  readonly worker: Worker;
  private readonly ownsWorker: boolean;
  private readonly options: Required<Omit<WorkerRecorderOptions, "worker">> & Pick<WorkerRecorderOptions, "worker">;
  private stateValue: WorkerRecorderState = "recording";
  private failure: Error | null = null;
  private pathValue: string | null = null;
  private active = true;
  private metaPending = false;
  private markerWritten = false;
  private offset = 0;
  private count = 0;
  private logicalCount = 0;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private durableSequence = 0;
  private writtenProgress: WorkerDurabilityAcknowledgement = { sequence: 0, sourceByteLength: 0, frameCount: 0, sourceRecordCount: 0, fileDev: "", fileIno: "" };
  private durableProgress: WorkerDurabilityAcknowledgement = this.writtenProgress;
  private inFlightBytes = 0;
  private batch: { sequence: number; bytes: Uint8Array; chargeBytes: number; sourceByteLength: number; frameCount: number; sourceRecordCount: number; sourceEvent: EncodedSourceEvent }[] = [];
  private batchBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closePromise: Promise<void> | null = null;
  private hasSourceRecord = false;
  private writerFailed = false;
  private headerWritten = false;
  private nextSyncRequestId = 0;
  private syncWaiter: {
    requestId: number;
    promise: Promise<WorkerDurabilityAcknowledgement>;
    resolve: (acknowledgement: WorkerDurabilityAcknowledgement) => void;
    reject: (error: Error) => void;
  } | null = null;
  private listeners = new Set<(event: EncodedSourceEvent) => void>();
  private durableListeners = new Set<(ack: WorkerDurabilityAcknowledgement) => void>();
  private failureListeners = new Set<(error: Error) => void>();
  constructor(gameId: ConstructorParameters<typeof SparseCaptureEncoder>[0] = "lmu", options: WorkerRecorderOptions = {}) {

    this.encoder = new SparseCaptureEncoder(gameId);
    this.options = {
      ...DEFAULTS,
      ...options,
      maxBatchBytes: options.maxBatchBytes ?? Math.min(DEFAULTS.maxBatchBytes, options.maxInFlightBytes ?? DEFAULTS.maxInFlightBytes),
    };
    if (this.options.maxBatchBytes <= 0 || this.options.maxBatchRecords <= 0 || this.options.maxInFlightBytes < this.options.maxBatchBytes || this.options.maxBatchDelayMs < 0 ||
      (this.options.headerCountOffset !== null && (!Number.isSafeInteger(this.options.headerCountOffset) || this.options.headerCountOffset < 0))) throw new Error("Invalid worker recorder limits");
    this.ownsWorker = !options.worker;
    this.worker = options.worker ?? new Worker(new URL("./source-writer-worker.ts", import.meta.url), { workerData: { syncIntervalMs: this.options.syncIntervalMs } });
    this.worker.on("message", (message: { type: string; sequence?: number; bytes?: number; error?: string; fileDev?: string; fileIno?: string }) => this.onMessage(message));
    this.worker.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error)), true));
    this.worker.on("exit", (code) => {
      if (this.stateValue !== "closed") this.fail(new Error(`Source writer worker exited (${code})`), true);
    });
  }
  get recording(): boolean { return this.active; }
  get recordCount(): number { return this.count; }
  get sourceRecordCount(): number { return this.logicalCount; }
  get path(): string | null { return this.pathValue; }
  get state(): WorkerRecorderState { return this.stateValue; }
  get acceptedSequence(): number { return this.sequence; }
  get writtenSequence(): number { return this.acknowledgedSequence; }
  get durableSequenceValue(): number { return this.durableSequence; }
  get writtenProgressValue(): WorkerDurabilityAcknowledgement { return this.writtenProgress; }
  get durableProgressValue(): WorkerDurabilityAcknowledgement { return this.durableProgress; }
  get error(): Error | null { return this.failure; }
  get inFlightByteCount(): number { return this.inFlightBytes; }
  get pendingBatchByteCount(): number { return this.batchBytes; }
  getCurrentByteOffset(): number { return this.offset; }

  start(path: string): string {
    if (this.pathValue) throw new Error("WorkerSessionRecorder already started");
    this.pathValue = path;
    this.worker.postMessage({
      type: "start", path, exclusiveFile: this.options.exclusiveFile,
      headerCountOffset: this.options.headerCountOffset,
    });
    return path;
  }
  writeMetaFrame(): void {
    if (!this.active || this.metaPending || this.offset !== 0) return;
    this.metaPending = true;
    this.offset = META_FRAME_BYTES;
  }
  requestFullCheckpoint(): void { this.encoder.requestCheckpoint(); }
  writeRecord(frame: Buffer, frameTimeMs?: number): void {
    this.assertAccepting();
    const worstCaseBytes = frame.length + (frameTimeMs === undefined ? 4 : 12) +
      (this.markerWritten ? 0 : SPARSE_MARKER_FRAME_BYTES) + (this.metaPending && !this.headerWritten ? META_FRAME_BYTES : 0);
    const chargeBytes = worstCaseBytes + frame.byteLength * (1 + (this.listeners.size ? 1 : 0)) + RECORD_TRANSPORT_OVERHEAD_BYTES;
    if (worstCaseBytes + frame.byteLength + RECORD_TRANSPORT_OVERHEAD_BYTES > this.options.maxBatchBytes || this.inFlightBytes + chargeBytes > this.options.maxInFlightBytes) {
      this.flushBatch();
      const error = new Error(`Source recording capacity exhausted at sequence ${this.sequence}`);
      this.fail(error);
      throw error;
    }
    const encoded = this.encoder.encode(frame, this.offset);
    const frameBytes = Buffer.concat([encodeFrameLength(encoded.length, frameTimeMs), encoded]);
    const addMarker = !this.markerWritten;
    const bytes = addMarker ? Buffer.concat([frameBytes, encodeSparseCaptureFormatFrame()]) : frameBytes;
    this.reserve("frame", bytes, frameTimeMs, true, addMarker, frame, frameBytes.length);
  }
  writeRawCaptureBytes(bytes: Buffer): void {
    this.assertAccepting();
    let sourceRecordDelta = 0;
    if (this.options.canonicalRawCaptureBytes) {
      for (const _record of iterateSessionCaptureRecords(bytes, 0, { strict: true })) sourceRecordDelta++;
    }
    this.reserve("raw", bytes, undefined, false, false, bytes, bytes.length, 0, sourceRecordDelta);
    this.encoder.reset();
  }
  writeRawCaptureRecord(bytes: Buffer, countDelta = 1): void {
    this.assertAccepting();
    if (!Number.isSafeInteger(countDelta) || countDelta < 0) throw new RangeError("Invalid raw capture record count");
    this.reserve("raw", bytes, undefined, false, false, bytes, bytes.length, countDelta, countDelta);
  }
  writeSegmentBoundary(): void {
    this.assertAccepting();
    if (!this.hasSourceRecord) {
      this.encoder.reset();
      return;
    }
    const bytes = encodeSegmentBoundaryFrame();
    this.reserve("segment-boundary", bytes, undefined, false, false, Buffer.alloc(0), bytes.length, 0, 1);
    this.encoder.reset();
  }
  flush(): void { this.flushBatch(); }
  requestSync(): Promise<WorkerDurabilityAcknowledgement> {
    this.assertAccepting();
    if (this.syncWaiter) return this.syncWaiter.promise;
    this.flushBatch();
    const bytes = RECORD_TRANSPORT_OVERHEAD_BYTES;
    if (this.inFlightBytes + bytes > this.options.maxInFlightBytes) {
      const error = new Error(`Source recording capacity exhausted before sync at sequence ${this.sequence}`);
      this.fail(error);
      return Promise.reject(error);
    }
    const requestId = ++this.nextSyncRequestId;
    let resolve: (acknowledgement: WorkerDurabilityAcknowledgement) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<WorkerDurabilityAcknowledgement>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.syncWaiter = { requestId, promise, resolve, reject };
    this.inFlightBytes += bytes;
    this.worker.postMessage({ type: "sync-request", requestId, bytes });
    return promise;
  }

  stop(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.writerFailed) return Promise.reject(this.failure);
    this.active = false;
    this.stateValue = "closing";
    this.flushBatch();
    const sequence = this.sequence;
    this.closePromise = new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.worker.off("message", onDone);
        this.worker.off("error", onError);
        if (this.ownsWorker) void this.worker.terminate();
      };
      const onDone = (message: { type: string; error?: string }) => {
        if (message.type === "closed") {
          finish();
          if (this.failure) { this.stateValue = "failed"; reject(this.failure); }
          else { this.stateValue = "closed"; resolve(); }
        } else if (message.type === "failed") {
          this.fail(new Error(message.error ?? "Source writer failed"), true);
          finish();
          reject(this.failure);
        }
      };
      const onError = (error: Error) => { finish(); reject(error); };
      this.worker.on("message", onDone);
      this.worker.on("error", onError);
      try {
        this.worker.postMessage({
          type: "close", sequence, count: this.count, hadMeta: this.metaPending,
          headerCountOffset: this.options.headerCountOffset, patchCountOnClose: this.options.patchCountOnClose,
        });
      }
      catch (error) { finish(); reject(error); }
    });
    return this.closePromise;
  }
  onEncodedSourceEvent(listener: (event: EncodedSourceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onDurableAcknowledgement(listener: (acknowledgement: WorkerDurabilityAcknowledgement) => void): () => void {
    this.durableListeners.add(listener);
    return () => this.durableListeners.delete(listener);
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }
  postOrderedControl(typeName: string, payload: unknown, payloadBytes: number): number {
    this.assertAccepting();
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new RangeError("Invalid source control byte length");
    const sequence = this.sequence + 1;
    const controlBytes = payloadBytes + RECORD_TRANSPORT_OVERHEAD_BYTES;
    if (controlBytes > this.options.maxInFlightBytes || this.inFlightBytes + controlBytes > this.options.maxInFlightBytes) {
      this.flushBatch();
      const error = new Error(`Source recording control capacity exhausted at sequence ${this.sequence}`);
      this.fail(error);
      throw error;
    }
    this.flushBatch();
    this.sequence = sequence;
    this.inFlightBytes += controlBytes;
    this.worker.postMessage({ type: "capture-control", sequence, typeName, payload, bytes: controlBytes });
    return sequence;
  }
  private reserve(kind: EncodedSourceEvent["kind"], bytes: Buffer, frameTimeMs: number | undefined, frame: boolean, marker: boolean, source: Buffer, encodedRecordLength: number, countDelta = frame ? 1 : 0, sourceRecordDelta = countDelta): void {
    const prefix = this.metaPending && !this.headerWritten ? encodeMetaFrame() : null;
    const full = prefix ? Buffer.concat([prefix, bytes]) : bytes;
    const markerLength = marker ? SPARSE_MARKER_FRAME_BYTES : 0;
    const sourceCopyBytes = source.byteLength * (1 + (this.listeners.size ? 1 : 0));
    const chargeBytes = full.byteLength + sourceCopyBytes + RECORD_TRANSPORT_OVERHEAD_BYTES;
    if (full.byteLength + source.byteLength + RECORD_TRANSPORT_OVERHEAD_BYTES > this.options.maxBatchBytes ||
      this.inFlightBytes + chargeBytes > this.options.maxInFlightBytes) {
      this.flushBatch();
      const error = new Error(`Source recording capacity exhausted at sequence ${this.sequence}`);
      this.fail(error);
      throw error;
    }
    if (this.batchBytes + full.byteLength + source.byteLength + RECORD_TRANSPORT_OVERHEAD_BYTES > this.options.maxBatchBytes ||
      this.batch.length >= this.options.maxBatchRecords) this.flushBatch();
    const nextCount = this.count + countDelta;
    const nextSourceRecordCount = this.logicalCount + sourceRecordDelta;
    if (!Number.isSafeInteger(nextCount) || !Number.isSafeInteger(nextSourceRecordCount)) {
      const error = new Error("Source recording count exceeds supported range");
      this.fail(error); throw error;
    }
    const start = this.offset;
    const seq = ++this.sequence;
    if (prefix) this.headerWritten = true;
    const sourceEndOffset = start + encodedRecordLength;
    const sourceByteLength = sourceEndOffset + markerLength;
    const sourceEvent: EncodedSourceEvent = {
      sequence: seq, kind, offset: start, endOffset: sourceByteLength, sourceOffset: start,
      sourceEndOffset,
      bytes: new Uint8Array(source), ...(frameTimeMs === undefined ? {} : { frameTimeMs }),
    };
    const record = {
      sequence: seq, bytes: new Uint8Array(full), chargeBytes, sourceByteLength, frameCount: nextCount, sourceRecordCount: nextSourceRecordCount, sourceEvent,
    };
    this.batch.push(record);
    this.hasSourceRecord = true;
    this.batchBytes += full.byteLength + source.byteLength + RECORD_TRANSPORT_OVERHEAD_BYTES;
    this.inFlightBytes += chargeBytes;
    this.offset = sourceByteLength;
    this.count = nextCount;
    this.logicalCount = nextSourceRecordCount;
    if (marker) this.markerWritten = true;
    if (this.listeners.size) {
      const event: EncodedSourceEvent = { ...sourceEvent, bytes: new Uint8Array(sourceEvent.bytes) };
      try {
        for (const listener of this.listeners) listener(event);
      } catch (error) {
        this.flushBatch();
        this.fail(error instanceof Error ? error : new Error(String(error)));
        throw this.failure;
      }
    }
    if (this.batchBytes >= this.options.maxBatchBytes) this.flushBatch();
    else if (!this.timer) this.timer = setTimeout(() => this.flushBatch(), this.options.maxBatchDelayMs);
  }
  private flushBatch(): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    if (!this.batch.length || this.stateValue === "failed") return;
    const batch = this.batch;
    this.batch = [];
    this.batchBytes = 0;
    const transfer = batch.flatMap((record) => [
      record.bytes.buffer as ArrayBuffer,
      record.sourceEvent.bytes.buffer as ArrayBuffer,
    ]);
    this.worker.postMessage({ type: "batch", records: batch }, transfer);
  }
  private onMessage(message: {
    type: string;
    sequence?: number;
    bytes?: number;
    error?: string;
    requestId?: number;
    sourceByteLength?: number;
    frameCount?: number;
    sourceRecordCount?: number;
    fileDev?: string;
    fileIno?: string;
  }): void {
    if ((message.type === "ack" || message.type === "sync-ack" || message.type === "durable") &&
        (typeof message.sourceRecordCount !== "number" || !Number.isSafeInteger(message.sourceRecordCount) || message.sourceRecordCount < 0)) {
      this.fail(new Error("Source writer omitted a valid logical record count")); return;
    }
    if (message.type === "ack") {
      this.acknowledgedSequence = Math.max(this.acknowledgedSequence, message.sequence ?? 0);
      this.inFlightBytes = Math.max(0, this.inFlightBytes - (message.bytes ?? 0));
      this.writtenProgress = {
        sequence: message.sequence ?? this.acknowledgedSequence, sourceByteLength: message.sourceByteLength ?? 0,
        frameCount: message.frameCount ?? 0, fileDev: message.fileDev ?? "", fileIno: message.fileIno ?? "",
        sourceRecordCount: message.sourceRecordCount!,
      };
    } else if (message.type === "capture-control-ack") {
      this.acknowledgedSequence = Math.max(this.acknowledgedSequence, message.sequence ?? 0);
      this.inFlightBytes = Math.max(0, this.inFlightBytes - (message.bytes ?? 0));
      if (message.error) this.fail(new Error(message.error));
    } else if (message.type === "sync-ack" && this.syncWaiter && this.syncWaiter.requestId === message.requestId) {
      const waiter = this.syncWaiter;
      this.syncWaiter = null;
      this.inFlightBytes = Math.max(0, this.inFlightBytes - (message.bytes ?? 0));
      const acknowledgement: WorkerDurabilityAcknowledgement = {
        sequence: message.sequence ?? 0, sourceByteLength: message.sourceByteLength ?? 0,
        frameCount: message.frameCount ?? 0, fileDev: message.fileDev ?? "", fileIno: message.fileIno ?? "",
        sourceRecordCount: message.sourceRecordCount!,
      };
      this.durableSequence = Math.max(this.durableSequence, acknowledgement.sequence);
      this.durableProgress = acknowledgement;
      waiter.resolve(acknowledgement);
      try {
        for (const listener of this.durableListeners) listener(acknowledgement);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (message.type === "durable") {
      this.durableSequence = Math.max(this.durableSequence, message.sequence ?? 0);
      this.durableProgress = {
        sequence: message.sequence ?? this.durableSequence, sourceByteLength: message.sourceByteLength ?? 0,
        frameCount: message.frameCount ?? 0, fileDev: message.fileDev ?? "", fileIno: message.fileIno ?? "",
        sourceRecordCount: message.sourceRecordCount!,
      };
      try {
        for (const listener of this.durableListeners) listener(this.durableProgress);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (message.type === "failed") this.fail(new Error(message.error ?? "Source writer failed"), true);
  }
  private assertAccepting(): void {
    if (!this.active) throw new Error("WorkerSessionRecorder is not recording");
    if (!this.pathValue) throw new Error("WorkerSessionRecorder.start() required");
    if (this.stateValue === "failed") throw this.failure;
  }
  private fail(error: Error, writerFailed = false): void {
    if (this.stateValue === "closed") return;
    if (writerFailed) {
      this.writerFailed = true;
      if (this.ownsWorker) void this.worker.terminate();
    }
    if (this.stateValue === "failed") return;
    this.failure = error;
    this.stateValue = "failed";
    this.active = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    if (writerFailed && this.syncWaiter) {
      this.syncWaiter.reject(error);
      this.syncWaiter = null;
    }
    for (const listener of this.failureListeners) {
      try { listener(error); } catch {}
    }
  }
}
