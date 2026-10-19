import { createHash, type Hash } from "node:crypto";
import { encodeMetaFrame, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame, encodeSparseCaptureFormatFrame, type SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import type { LapWindow } from "./contract";
import { encodeStreamingFrame, updateNativeRecordDigest, type StreamingMemberDescriptor, type StreamingMemberKind, type StreamingMemberStage, type StreamingSplitterOptions } from "./streaming";
import type { StreamingPositionSpool } from "./streaming-spool";

type Queued = { record: SessionCaptureRecord; wireBytes: number };
interface Candidate {
  id: string;
  lapNumber: number;
  startByteOffset: number;
  parserCheckpoint: Uint8Array;
  preparationOnly: boolean;
  binding: { promise: Promise<string>; resolve(value: string): void };
  lapId?: string;
  window?: LapWindow;
  prefixRecords?: number;
  prefixFrames?: number;
  prefixDigest?: string;
  digest?: Hash;
  digestSnapshot?: string;
}
interface ActiveMember {
  stage: StreamingMemberStage;
  encoder: SparseCaptureEncoder;
  kind: StreamingMemberKind;
  candidate?: Candidate;
  selected?: Candidate;
  lap?: LapWindow;
  positions?: StreamingPositionSpool;
  firstOrdinal: number;
  sourceByteStart: number;
  sourceByteEnd: number;
  records: number;
  frames: number;
  bytes: number;
  digest: Hash;
  trailingDigest: Hash;
  trailing: number;
  ownedFrameByteOffset?: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
}

/** Fixed-RAM ingress queue and disk-staged, unknown-length authoritative lap windows. */
export class StreamingCaptureSplitter {
  private readonly queue: Queued[] = [];
  private queuedBytes = 0;
  private draining: Promise<void> | null = null;
  private failed: unknown;
  private closed = false;
  private closing: Promise<void> | null = null;
  private aborted = false;
  private watermark = 0;
  private ordinal = 0;
  private resumeOffset = 0;
  private lastQueuedEnd = 0;
  private active: ActiveMember | null = null;
  private finalizing: Promise<void> | null = null;
  private terminalCleanup: Promise<void> | null = null;
  private errorNotified = false;
  private readonly candidates = new Map<string, Candidate>();
  private readonly abortBinding = Promise.withResolvers<never>();
  private readonly abortController = new AbortController();
  private readonly signal: AbortSignal;
  private readonly options: StreamingSplitterOptions;
  private readonly cancelBinding = () => this.abortBinding.reject(this.signal.reason);

  constructor(options: StreamingSplitterOptions) {
    this.options = options;
    this.signal = options.signal ? AbortSignal.any([options.signal, this.abortController.signal]) : this.abortController.signal;
    void this.abortBinding.promise.catch(() => undefined);
    if (this.signal.aborted) this.cancelBinding();
    else this.signal.addEventListener("abort", this.cancelBinding, { once: true });
    if (!(options.host.maxQueuedBytes > 0) || !(options.host.maxUnresolvedBytes > 0)) throw new RangeError("Streaming splitter byte limits must be positive");
  }

  resume(_generation: number, sourceOrdinal: number, sourceByteOffset: number): void {
    this.assertLive();
    if (this.active || this.queue.length || this.candidates.size || !Number.isSafeInteger(sourceOrdinal) || sourceOrdinal < 0 ||
        !Number.isSafeInteger(sourceByteOffset) || sourceByteOffset < 0) throw new Error("Invalid streaming resume position");
    this.ordinal = sourceOrdinal;
    this.resumeOffset = sourceByteOffset;
    this.lastQueuedEnd = sourceByteOffset;
    this.watermark = sourceByteOffset;
  }

  addWindow(window: LapWindow): void {
    this.startCandidate(window.lapId, window.lapNumber, window.startByteOffset, window.parserCheckpoint ?? new Uint8Array());
    this.bindCandidate(window.lapId, window.lapId);
    this.finalizeCandidate(window.lapId, window, 0);
  }

  startCandidate(candidateId: string, lapNumber: number, startByteOffset: number, parserCheckpoint: Uint8Array, preparationOnly = false): void {
    this.assertLive();
    if (!candidateId || this.candidates.has(candidateId) || !Number.isSafeInteger(lapNumber) || lapNumber < 0 ||
        !Number.isSafeInteger(startByteOffset) || startByteOffset < this.resumeOffset ||
        !(parserCheckpoint instanceof Uint8Array) || parserCheckpoint.byteLength > 1024 * 1024 ||
        (["ac-evo", "f1-2025", "iracing"].includes(this.options.gameId) && parserCheckpoint.byteLength === 0)) throw new Error("Invalid streaming candidate initialization");
    if (preparationOnly) {
      for (const [id, candidate] of this.candidates) {
        if (candidate.preparationOnly && !candidate.window) {
          this.candidates.delete(id);
          this.options.host.discardCandidate?.(id);
        }
      }
    }
    if (this.candidates.size >= 4) throw new Error("Streaming candidate budget exhausted");
    const binding = Promise.withResolvers<string>();
    this.candidates.set(candidateId, { id: candidateId, lapNumber, startByteOffset, parserCheckpoint, preparationOnly, binding });
  }

  finalizeCandidate(candidateId: string, window: LapWindow, revision: number): void {
    this.assertLive();
    const candidate = this.candidates.get(candidateId);
    if (!candidate || !Number.isSafeInteger(revision) || revision < 0 || candidate.startByteOffset !== window.startByteOffset || candidate.lapNumber !== window.lapNumber ||
        !Number.isSafeInteger(window.frameCount) || window.frameCount < 1 || !Number.isSafeInteger(window.trailingContextFrameCount ?? 0) || (window.trailingContextFrameCount ?? 0) > 1) throw new Error("Invalid finalized candidate ownership");
    if (candidate.window && (candidate.window.frameCount !== window.frameCount || candidate.window.startByteOffset !== window.startByteOffset)) throw new Error("Finalized candidate ownership changed");
    candidate.window = { ...window, parserCheckpoint: candidate.parserCheckpoint };
    if (/^[1-9]\d*$/.test(window.lapId) && !candidate.lapId) this.bindCandidate(candidateId, window.lapId);
    if (this.active?.candidate && (this.active.candidate.id === candidateId || candidate.preparationOnly)) this.active.selected = candidate;
    this.schedule();
  }

  bindCandidate(candidateId: string, lapId: string): void {
    this.assertLive();
    const candidate = this.candidates.get(candidateId);
    if (!candidate || !lapId || (candidate.lapId && candidate.lapId !== lapId)) throw new Error("Invalid persisted candidate binding");
    candidate.lapId = lapId;
    candidate.binding.resolve(lapId);
  }

  promoteCandidate(candidateId: string, lapNumber: number): void {
    this.assertLive();
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.window || !Number.isSafeInteger(lapNumber) || lapNumber < 0) throw new Error("Invalid candidate promotion");
    candidate.preparationOnly = false;
    candidate.lapNumber = lapNumber;
  }

  discardCandidate(candidateId: string): void {
    this.assertLive();
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return;
    if (candidate.window || candidate.lapId) throw new Error("Cannot abandon persisted or finalized ownership");
    this.candidates.delete(candidateId);
    this.options.host.discardCandidate?.(candidateId);
    // An active unowned stage remains intact and is rebuilt as auxiliary at the next boundary or close.
  }

  enqueue(record: SessionCaptureRecord): boolean {
    this.assertLive();
    const wireBytes = (record.kind === "frame" ? record.frame.byteLength : record.kind === "parser-bootstrap" ? record.payload.byteLength : 16) + 64;
    if (this.queuedBytes + wireBytes > Math.min(this.options.host.maxQueuedBytes, this.options.host.maxUnresolvedBytes)) return false;
    if (!Number.isSafeInteger(record.offset) || !Number.isSafeInteger(record.endOffset) || record.offset < this.lastQueuedEnd || record.endOffset <= record.offset) throw new Error("Source records are not ordered");
    this.lastQueuedEnd = record.endOffset;
    this.queue.push({ record, wireBytes });
    this.queuedBytes += wireBytes;
    this.schedule();
    return true;
  }

  advanceWatermark(sourceByteOffset: number): void {
    this.assertLive();
    if (!Number.isSafeInteger(sourceByteOffset) || sourceByteOffset < this.watermark) throw new Error("Source processing watermark moved backwards");
    this.watermark = sourceByteOffset;
    this.schedule();
  }
  progress(): { derivedQueueBytes: number; derivedQueueRecords: number; unresolvedCandidates: number; unresolvedSourceBytes: number } {
    const unresolvedStart = this.candidates.size
      ? Math.min(...Array.from(this.candidates.values(), (candidate) => candidate.startByteOffset))
      : this.watermark;
    return {
      derivedQueueBytes: this.queuedBytes,
      derivedQueueRecords: this.queue.length,
      unresolvedCandidates: this.candidates.size,
      unresolvedSourceBytes: Math.max(0, this.watermark - unresolvedStart),
    };
  }

  async drain(): Promise<void> {
    while (this.draining) await this.draining;
    this.assertHealthy();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal();
    return this.closing;
  }

  async abort(error: unknown): Promise<void> {
    if (!this.failed) this.failed = error;
    this.aborted = true;
    this.abortController.abort(error);
    this.abortBinding.reject(error);
    this.queue.length = 0;
    this.queuedBytes = 0;
    await this.cleanupTerminal();
    this.closed = true;
  }

  private async closeInternal(): Promise<void> {
    this.watermark = Number.MAX_SAFE_INTEGER;
    this.schedule();
    let failure: unknown;
    try {
      await this.drain();
      if (!this.failed) await this.finishActive();
      await this.finalizing;
      await this.draining;
      this.assertHealthy();
    } catch (error) { failure = error; }
    try { await this.cleanupTerminal(); }
    catch (cleanupError) { failure = failure === undefined ? cleanupError : failure === cleanupError ? failure : new AggregateError([failure, cleanupError], "Streaming splitter close failed"); }
    this.closed = true;
    if (failure !== undefined) throw failure;
  }

  private async cleanupTerminal(): Promise<void> {
    if (this.terminalCleanup) return this.terminalCleanup;
    this.terminalCleanup = this.performTerminalCleanup();
    return this.terminalCleanup;
  }

  private async performTerminalCleanup(): Promise<void> {
    const errors: unknown[] = [];
    const operationalFailure = this.failed;
    const draining = this.draining;
    if (draining) try { await draining; } catch (error) { if (error !== operationalFailure) errors.push(error); }
    const finalizing = this.finalizing;
    if (finalizing) try { await finalizing; } catch (error) { if (error !== operationalFailure) errors.push(error); }
    for (const candidate of this.candidates.values()) {
      try { this.options.host.discardCandidate?.(candidate.id); } catch (error) { errors.push(error); }
    }
    this.candidates.clear();
    const active = this.active;
    this.active = null;
    if (active) {
      try { await active.stage.discard(); } catch (error) { errors.push(error); }
      try { await active.positions?.discard(); } catch (error) { errors.push(error); }
    }
    try { await this.options.host.dispose?.(); } catch (error) { errors.push(error); }
    this.signal.removeEventListener("abort", this.cancelBinding);
    if (errors.length) throw new AggregateError(errors, "Streaming splitter cleanup failed");
  }

  private schedule(): void {
    if (this.draining || this.failed || !this.queue.length || this.queue[0]!.record.endOffset > this.watermark) return;
    const draining = this.pump().catch((error) => {
      if (!this.failed) this.failed = error;
      this.abortController.abort(error);
      this.queue.length = 0;
      this.queuedBytes = 0;
      if (!this.errorNotified) {
        this.errorNotified = true;
        queueMicrotask(() => {
          try { this.options.onError?.(error); }
          finally {
            void this.cleanupTerminal().catch((cleanupError) => {
              this.failed = new AggregateError([error, cleanupError], "Streaming splitter failed and cleanup failed");
            });
          }
        });
      } else {
        void this.cleanupTerminal().catch(() => undefined);
      }
    });
    this.draining = draining;
    void draining.finally(() => {
      if (this.draining === draining) this.draining = null;
      if (!this.failed && this.queue.length && this.queue[0]!.record.endOffset <= this.watermark) this.schedule();
    }).catch(() => undefined);
  }

  private async pump(): Promise<void> {
    while (this.queue.length && this.queue[0]!.record.endOffset <= this.watermark) {
      this.assertHealthy();
      this.options.signal?.throwIfAborted();
      const item = this.queue[0]!;
      await this.consume(item.record);
      if (this.aborted || this.failed) break;
      if (this.queue[0] === item) {
        this.queue.shift();
        this.queuedBytes -= item.wireBytes;
      }
    }
  }

  private async consume(record: SessionCaptureRecord): Promise<void> {
    const next = [...this.candidates.values()].find((candidate) => !candidate.preparationOnly && candidate.startByteOffset === record.offset);
    const active = this.active;
    if (active?.candidate) {
      const selected = active.selected ?? active.candidate;
      const owned = active.frames - (selected.prefixFrames ?? 0);
      const window = selected.window;
      const reachesNext = next && next.id !== active.candidate.id;
      if (window && (owned >= window.frameCount || reachesNext)) {
        const overlap = reachesNext && window.frameCount - owned === 1;
        if (window.frameCount - owned > (overlap ? 1 : 0) || owned > window.frameCount) throw new Error("Lap ownership overlaps beyond one completion frame");
        const normalized = { ...window, frameCount: owned, trailingContextFrameCount: overlap ? 1 : window.trailingContextFrameCount ?? 0 };
        if (normalized.frameCount < 1) throw new Error("Lap ownership has no owned frames");
        this.options.host.finalizeWindow?.(normalized);
        if (normalized.trailingContextFrameCount === 1) {
          if (record.kind !== "frame") throw new Error("Lap completion context is not a native frame");
          await this.append(active, record, true);
        }
        active.lap = normalized;
        await this.finishActive();
      } else if (reachesNext || record.kind !== "frame") {
        if (reachesNext && this.candidates.has(active.candidate.id)) throw new Error("Ownership must resolve before advancing to the next candidate");
        if (window) throw new Error("Lap source window crosses a reset or unaligned boundary");
        await this.finishActive();
      }
    } else if (active && next) await this.finishActive();
    if (this.active?.candidate) {
      for (const candidate of this.candidates.values()) {
        if (candidate.preparationOnly && candidate.startByteOffset === record.offset) {
          candidate.prefixFrames = this.active.frames;
          candidate.prefixRecords = this.active.records;
          candidate.prefixDigest = this.active.digest.copy().digest("hex");
          candidate.digest = createHash("sha256");
          if (candidate.window) this.active.selected = candidate;
        }
      }
    }
    if (!this.active) this.active = await this.begin(next && record.kind === "frame" ? next : undefined, record, this.ordinal);
    this.options.sourceRecord?.(record);
    await this.append(this.active, record, false);
    if (this.active.candidate) {
      for (const candidate of this.candidates.values()) {
        if (candidate.preparationOnly && candidate.digest && candidate.digestSnapshot === undefined && record.offset >= candidate.startByteOffset) {
          updateNativeRecordDigest(candidate.digest, record);
        }
      }
    }
    this.ordinal++;
    if (!this.active.candidate && this.active.bytes >= (this.options.host.auxiliaryMemberBytes ?? 64 * 1024 * 1024)) await this.finishActive();
  }

  private async begin(candidate: Candidate | undefined, record: SessionCaptureRecord, ordinal: number): Promise<ActiveMember> {
    const kind = candidate ? "lap" : "auxiliary";
    const stage = await this.options.host.createStage(kind, candidate?.id ?? `aux-${ordinal}`);
    let positions: StreamingPositionSpool | undefined;
    try {
      const header = Buffer.concat([encodeMetaFrame(0), encodeSparseCaptureFormatFrame()]);
      await stage.append(header);
      let bytes = header.length;
      if (candidate?.parserCheckpoint.byteLength) {
        const bootstrap = encodeParserBootstrapFrame(this.options.gameId, candidate.parserCheckpoint);
        await stage.append(bootstrap);
        bytes += bootstrap.length;
      }
      positions = candidate ? await this.options.host.createPositionSpool?.() : undefined;
      if (candidate && !positions) throw new Error("Dynamic lap staging requires a bounded source-position journal");
      return { stage, encoder: new SparseCaptureEncoder(this.options.gameId), kind, candidate, positions, firstOrdinal: ordinal,
        sourceByteStart: record.offset, sourceByteEnd: record.offset, records: 0, frames: 0, bytes,
        digest: createHash("sha256"), trailingDigest: createHash("sha256"), trailing: 0 };
    } catch (error) {
      const errors: unknown[] = [error];
      try { await stage.discard(); } catch (cleanupError) { errors.push(cleanupError); }
      try { await positions?.discard(); } catch (cleanupError) { errors.push(cleanupError); }
      throw errors.length === 1 ? error : new AggregateError(errors, "Streaming stage initialization failed");
    }
  }

  private async append(active: ActiveMember, record: SessionCaptureRecord, context: boolean): Promise<void> {
    if (record.kind === "frame") {
      if (!context && active.frames === 0) {
        active.firstTimestamp = record.frameTimeMs;
        if (active.candidate) active.ownedFrameByteOffset = active.bytes;
      }
      const [prefix, encoded] = encodeStreamingFrame(active.encoder, record.frame, active.bytes, record.frameTimeMs);
      await active.stage.append(prefix); await active.stage.append(encoded);
      active.bytes += prefix.length + encoded.length;
      active.lastTimestamp = record.frameTimeMs;
      if (!context) active.frames++;
    } else {
      if (context) throw new Error("Completion context must be a native frame");
      const bytes = record.kind === "segment-boundary" ? encodeSegmentBoundaryFrame()
        : record.kind === "segment-context" ? encodeSegmentContextFrame()
        : record.kind === "segment-context-end" ? encodeSegmentContextEndFrame() : encodeParserBootstrapFrame(record.gameId, record.payload);
      await active.stage.append(bytes); active.bytes += bytes.length;
      if (record.kind !== "segment-context") active.encoder.reset();
    }
    updateNativeRecordDigest(context ? active.trailingDigest : active.digest, record);
    if (context) active.trailing++;
    else {
      await active.positions?.append({ offset: record.offset, endOffset: record.endOffset, ordinal: active.firstOrdinal + active.records });
      active.records++;
      active.sourceByteEnd = record.endOffset;
    }
  }

  private descriptor(active: ActiveMember, lap?: LapWindow): StreamingMemberDescriptor {
    return { id: lap?.lapId ?? `aux-${active.firstOrdinal}`, kind: lap ? "lap" : "auxiliary", lap,
      firstOrdinal: active.firstOrdinal, sourceStart: active.firstOrdinal, sourceEnd: active.firstOrdinal + active.records,
      sourceByteStart: active.sourceByteStart, sourceByteEnd: active.sourceByteEnd, recordCount: active.records,
      ownedFrameCount: lap ? active.frames : 0, trailingContextFrameCount: active.trailing, nativeDigest: active.digest.copy().digest("hex"), byteLength: active.bytes,
      ...(active.trailing ? { trailingContextDigest: active.trailingDigest.copy().digest("hex") } : {}),
      ...(lap?.parserCheckpoint?.byteLength ? { parserBootstrapHash: createHash("sha256").update(lap.parserCheckpoint).digest("hex") } : {}),
      ...(lap ? { ownedFrameByteOffset: active.ownedFrameByteOffset } : {}),
      ...(active.firstTimestamp === undefined ? {} : { firstTimestamp: active.firstTimestamp }),
      ...(active.lastTimestamp === undefined ? {} : { lastTimestamp: active.lastTimestamp }) };
  }

  private async publish(active: ActiveMember, lap?: LapWindow): Promise<void> {
    this.assertHealthy();
    let descriptor = this.descriptor(active, lap);
    await active.stage.close();
    this.assertHealthy();
    await active.stage.verify(descriptor, this.signal);
    this.assertHealthy();
    if (lap) {
      const evidence = this.options.host.replayEvidence?.(lap);
      if (!evidence || !this.options.host.replayParser) throw new Error(`Missing independent parser replay for lap ${lap.lapId}`);
      await this.options.host.replayParser(active.stage, lap, evidence, this.signal);
      this.assertHealthy();
      descriptor = { ...descriptor, parserReplayVerified: true, parserReplayEvidence: evidence };
    }
    this.assertHealthy();
    const result = await active.stage.commit(descriptor, this.signal);
    this.assertHealthy();
    this.options.onCommitted?.(descriptor, result);
  }

  private async finishActive(): Promise<void> {
    if (this.finalizing) await this.finalizing;
    const active = this.active;
    if (!active) return;
    this.active = null;
    for (const candidate of this.candidates.values()) {
      if (candidate.preparationOnly && candidate.digest && candidate.digestSnapshot === undefined &&
          candidate.startByteOffset < active.sourceByteEnd) candidate.digestSnapshot = candidate.digest.copy().digest("hex");
    }
    const job = this.finalizeActive(active).catch(async (error) => {
      if (!this.failed) this.failed = error;
      const errors: unknown[] = [error];
      try { await active.stage.discard(); } catch (cleanupError) { errors.push(cleanupError); }
      try { await active.positions?.discard(); } catch (cleanupError) { errors.push(cleanupError); }
      const failure = errors.length === 1 ? error : new AggregateError(errors, "Streaming finalization failed and cleanup failed");
      this.failed = failure;
      this.queue.length = 0;
      this.queuedBytes = 0;
      if (!this.errorNotified) {
        this.errorNotified = true;
        queueMicrotask(() => {
          try { this.options.onError?.(failure); }
          finally {
            void this.cleanupTerminal().catch((cleanupError) => {
              this.failed = new AggregateError([failure, cleanupError], "Streaming finalization failed and cleanup failed");
            });
          }
        });
      }
      throw failure;
    });
    this.finalizing = job;
    void job.catch(() => undefined);
    void job.finally(() => { if (this.finalizing === job) this.finalizing = null; }).catch(() => undefined);
  }

  private async finalizeActive(active: ActiveMember): Promise<void> {
    const selected = active.selected ?? active.candidate;
    if (!active.candidate) { await this.publish(active); return; }
    let lap = active.lap;
    if (!lap && selected?.window) {
      const owned = active.frames - (selected.prefixFrames ?? 0);
      if (owned !== selected.window.frameCount || (selected.window.trailingContextFrameCount ?? 0) !== 0) throw new Error("Final lap is incomplete or missing completion context");
      lap = { ...selected.window, frameCount: owned };
      this.options.host.finalizeWindow?.(lap);
    }
    if (lap && selected) lap = { ...lap, lapId: selected.lapId ?? await Promise.race([selected.binding.promise, this.abortBinding.promise]) };
    const trimmed = !!lap && selected !== active.candidate;
    if (trimmed || !lap) await this.rebuild(active, trimmed ? selected : undefined, lap);
    else await this.publish(active, lap);
    await active.positions!.discard();
    for (const [id, candidate] of this.candidates) {
      if (candidate === active.candidate || candidate === selected || candidate.preparationOnly && candidate.startByteOffset < active.sourceByteEnd) {
        this.candidates.delete(id); this.options.host.discardCandidate?.(id);
      }
    }
  }

  private async rebuild(original: ActiveMember, selected: Candidate | undefined, lap: LapWindow | undefined): Promise<void> {
    let output: ActiveMember | null = null;
    let records: AsyncIterator<SessionCaptureRecord> | undefined;
    let positions: AsyncIterator<{ offset: number; endOffset: number; ordinal: number }> | undefined;
    const errors: unknown[] = [];
    try {
      await original.stage.close();
      const initialization = original.candidate?.parserCheckpoint;
      const verifiedLap: LapWindow | undefined = initialization?.byteLength ? {
        lapId: original.candidate!.id, lapNumber: original.candidate!.lapNumber, startByteOffset: original.sourceByteStart,
        frameCount: original.frames, parserCheckpoint: initialization,
      } : undefined;
      await original.stage.verify(this.descriptor(original, verifiedLap), this.signal);
      positions = original.positions!.positions()[Symbol.asyncIterator]();
      records = original.stage.readRecords(this.signal)[Symbol.asyncIterator]();
      let seen = 0;
      if (initialization?.byteLength) {
        const bootstrap = await records.next();
        if (bootstrap.done || bootstrap.value.kind !== "parser-bootstrap") throw new Error("Missing tentative initialization");
      }
      while (seen < original.records) {
        const position = await positions.next(); const next = await records.next();
        if (position.done || next.done) throw new Error("Tentative source journal is truncated");
        const record = { ...next.value, offset: position.value.offset, endOffset: position.value.endOffset };
        const ownsLap = !!selected && record.offset >= selected.startByteOffset;
        if (!output || (ownsLap && !output.candidate)) {
          if (output) { await this.publish(output); output = null; }
          output = await this.begin(ownsLap ? selected : undefined, record, position.value.ordinal);
        }
        await this.append(output, record, false); seen++;
      }
      if (original.trailing) {
        const context = await records.next();
        if (context.done || !output || !lap) throw new Error("Tentative context record is missing");
        await this.append(output, context.value, true);
      }
      if (output) {
        const expectedDigest = selected?.digestSnapshot ?? selected?.digest?.copy().digest("hex");
        if (lap && selected && expectedDigest && output.digest.copy().digest("hex") !== expectedDigest) throw new Error("Rebuilt selected interval differs from source ledger");
        await this.publish(output, lap);
        await output.positions?.discard();
        output = null;
      }
      if (!(await records.next()).done || !(await positions.next()).done) throw new Error("Tentative source journal contains extra records");
    } catch (error) {
      errors.push(error);
    } finally {
      try { await records?.return?.(); } catch (error) { errors.push(error); }
      try { await positions?.return?.(); } catch (error) { errors.push(error); }
      if (output) {
        try { await output.stage.discard(); } catch (error) { errors.push(error); }
        try { await output.positions?.discard(); } catch (error) { errors.push(error); }
      }
      try { await original.stage.discard(); } catch (error) { errors.push(error); }
      try { await original.positions?.discard(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Streaming rebuild failed and cleanup failed");
  }

  private assertLive(): void {
    if (this.closed) throw new Error("Streaming splitter is closed");
    this.assertHealthy();
  }
  private assertHealthy(): void {
    if (this.failed) throw this.failed;
    this.signal.throwIfAborted();
  }
}
