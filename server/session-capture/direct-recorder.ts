import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { ChunkSchema, ManifestSchema, type Chunk, type Manifest } from "@raceiq/capture-splitting";
import { encodeFrameLength, encodeMetaFrame, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords, META_FRAME_BYTES } from "@raceiq/capture-formats/session/framing";
import { PreopenedFileWriter, type PreopenedFileInfo, type PreopenedFileWriterOptions } from "@raceiq/capture-formats/session/preopened-file-writer";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import type { DetectorOwnershipTransition } from "@raceiq/telemetry-core/processor/ordinal-engine";
import { materializeParserInitializationPlan, type ParserReplayLocator } from "../games/packet-dispatch";
import { db } from "../db";
import { laps, sessions } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { resolveRecordingGameDirectory } from "../runtime/config/recording-directory";
import type { PersistedLapBinding } from "../telemetry/pipeline-ports";
import { SparseSessionRecorderAdapter } from "../telemetry/pipeline-ports";
import { timestampForFilename } from "./filename";

export interface DirectCaptureRecordingOptions { writerOptions?: PreopenedFileWriterOptions }
type Owner = { binding?: PersistedLapBinding; startOrdinal: number; count: number; trailing: number; finalized: boolean; abandoned: boolean; ownedByteOffset: number };
type Part = { info: PreopenedFileInfo; encoder: SparseCaptureEncoder | null; localOffset: number; prefixBytes: number; records: number; firstOrdinal: number; sourceStart: number; sourceEnd: number; kind: "lap" | "auxiliary"; owner?: Owner; bootstrapHash?: string; firstTimestamp?: number; lastTimestamp?: number; closed?: boolean; chunkId?: string };
type FrameRef = { frame: Buffer; timestamp?: number; start: number; end: number; ordinal: number; localOffset: number };
const MAX_CANDIDATE_SUFFIX_RECORDS = 1_200;

export class DirectCaptureRecording {
  readonly ready: Promise<void>;
  readonly sourcePath: string;
  sourceBytes = META_FRAME_BYTES;
  sourceRecordCount = 0;
  private nativeFrameCount = 0;
  private readonly writer: PreopenedFileWriter;
  private readonly gameId: GameId;
  private readonly directory: string;
  private readonly manifestPath: string;
  private readonly parts = new Map<string, Part>();
  private current: Part;
  private lastFrame: FrameRef | null = null;
  private pendingCandidate: { frame: FrameRef; window: NonNullable<DetectorOwnershipTransition["window"]>; locator: ParserReplayLocator | null; suffix: FrameRef[] } | null = null;
  private readonly windows = new Map<number, { ordinal: number; window: NonNullable<DetectorOwnershipTransition["window"]> }>();
  private readonly bindings = new Map<number, PersistedLapBinding>();
  private readonly publishedLapIds = new Set<number>();
  private readonly manifestRevision = randomUUID();
  private manifest: Manifest;
  private persistedManifest: Manifest;
  private startupTask: Promise<void> | null = null;
  private publicationTask: Promise<void> | null = null;
  private publicationRequested = false;
  private stopTask: Promise<void> | null = null;
  private sessionId: number | null = null;
  private sourceRegistered: Promise<void> = Promise.resolve();
  private notify: (event: Record<string, unknown>) => void = () => {};
  private failure: Error | null = null;
  private closing = false;
  private sealed = false;
  get queuedBytes(): number { return this.writer.queuedBytes; }
  get standbyReady(): boolean { return this.writer.standbyReady; }
  get isSealed(): boolean { return this.sealed; }
  get hasFailed(): boolean { return this.failure !== null; }
  get error(): Error | null { return this.failure; }
  get path(): string { return this.sourcePath; }
  get active(): boolean { return !this.closing && !this.sealed && !this.failure; }
  get sourceOrdinal(): number | undefined { return this.nativeFrameCount ? this.nativeFrameCount - 1 : undefined; }
  get rotationCount(): number { return this.parts.size - 1; }
  isLapReady(lapId: number): boolean { return this.publishedLapIds.has(lapId); }

  constructor(gameId: GameId, directory: string, manifestPath: string, options: DirectCaptureRecordingOptions = {}) {
    this.gameId = gameId; this.directory = directory; this.manifestPath = manifestPath; this.sourcePath = manifestPath;
    const onClosed = options.writerOptions?.onClosed;
    const onFailure = options.writerOptions?.onFailure;
    this.writer = new PreopenedFileWriter(directory, { ...options.writerOptions,
      onClosed: async (info) => { try { this.closed(info); } finally { await onClosed?.(info); } },
      onFailure: (error) => { try { onFailure?.(error); } finally { this.fail(error); } },
    });
    this.current = this.part(this.writer.active, 0, this.sourceBytes, "auxiliary");
    this.parts.set(this.current.info.id, this.current);
    this.ready = this.writer.ready;
    this.manifest = Schema.decodeSync(ManifestSchema)({
      version: 3, gameId, sourceRevision: this.manifestRevision, sourceByteLength: META_FRAME_BYTES,
      sourceRecordCount: 0, sourceCoordinates: "native-wire-v1", chunks: [],
    });
    this.persistedManifest = this.manifest;
    const header = Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame()]);
    this.append(header);
    this.current.prefixBytes = header.length;
    void this.ready.catch((error) => this.fail(error));
  }

  attachSession(sessionId: number, sourceRegistered: Promise<void>, notify: (event: Record<string, unknown>) => void): void {
    this.sessionId = sessionId; this.sourceRegistered = sourceRegistered; this.notify = notify;
    this.startupTask = this.ready.then(() => sourceRegistered).then(async () => {
      const snapshot = this.buildManifestSnapshot();
      await this.persistManifest(snapshot);
      this.persistedManifest = snapshot;
      const updated = await db.update(sessions).set({ rawFile: this.manifestPath, captureManifestFile: this.manifestPath, captureLayoutVersion: 1, captureArchiveFile: null }).where(eq(sessions.id, sessionId)).run();
      if (updated.rowsAffected !== 1) throw new Error(`Session ${sessionId} changed before direct capture publication`);
      await this.publishReady(snapshot);
    }).catch((error) => this.fail(error));
  }
  bindLap(binding: PersistedLapBinding): void {
    if (binding.sessionId !== this.sessionId || this.failure) return;
    this.bindings.set(binding.startByteOffset, binding);
    const ordinal = this.windows.get(binding.startByteOffset)?.ordinal;
    let closedBinding = false;
    if (ordinal !== undefined) {
      for (const part of this.parts.values()) {
        if (part.owner?.startOrdinal !== ordinal) continue;
        part.owner.binding = binding;
        closedBinding ||= !!part.closed;
      }
    }
    if (ordinal !== undefined) this.bindings.delete(binding.startByteOffset);
    if (closedBinding) this.schedulePublication();
  }
  invalidateLap(lapId: number): void {
    for (const [offset, binding] of this.bindings) if (binding.lapId === lapId) this.bindings.delete(offset);
    let closedBinding = false;
    for (const part of this.parts.values()) {
      if (part.owner?.binding?.lapId !== lapId) continue;
      part.owner.binding = undefined;
      closedBinding ||= !!part.closed;
    }
    if (closedBinding) this.schedulePublication();
  }
  fail(value: unknown): void {
    if (this.failure) return;
    this.failure = value instanceof Error ? value : new Error(String(value));
    this.notify({ type: "recording-failed", sessionId: this.sessionId, error: this.failure.message });
  }

  processTransitions(transitions: readonly DetectorOwnershipTransition[], locator: ParserReplayLocator | null): void {
    if (!this.active || transitions.length === 0) return;
    let publishClosedPrefix = false;
    try {
      for (const transition of transitions) {
        const window = transition.window;
        if (!window || window.startOffset == null) continue;
        if (transition.kind === "candidate-start") {
          if (!this.pendingCandidate && this.lastFrame?.start === window.startOffset) {
            this.pendingCandidate = { frame: this.lastFrame, window, locator, suffix: [this.lastFrame] };
          }
        } else if (transition.kind === "window-start") {
          const known = this.windows.get(window.startOffset);
          if (known) {
            if (window.startOrdinal !== null && window.startOrdinal !== known.ordinal) throw new Error("Ownership promotion changed source ordinal");
            known.window = window;
            continue;
          }
          const candidate = this.pendingCandidate?.frame.start === window.startOffset ? this.pendingCandidate : null;
          const ordinal = candidate?.frame.ordinal ?? this.ordinalAt(window.startOffset);
          if (ordinal === null) throw new Error(`Ownership start offset ${window.startOffset} is not a captured native frame`);
          if (candidate) {
            const suffix = candidate.suffix;
            this.current.records -= suffix.length;
            if (this.current.owner) {
              this.current.owner.trailing = Math.max(this.current.owner.trailing, 1);
              if (!this.current.owner.finalized) this.current.owner.count = Math.max(0, this.current.owner.count - suffix.length);
            }
            this.current.sourceEnd = window.startOffset;
            this.lastFrame = candidate.frame;
            this.rotate(window, candidate.locator, ordinal);
            for (let index = 1; index < suffix.length; index++) this.appendStoredFrame(suffix[index]!);
            this.pendingCandidate = null;
          } else if (this.windows.size > 0 && this.current.records > 0) {
            if (this.current.owner && !this.current.owner.abandoned) this.current.owner.trailing = 1;
            this.current.records--;
            this.current.sourceEnd = window.startOffset;
            this.rotate(window, locator, ordinal);
          }
          const binding = this.bindings.get(window.startOffset);
          this.current.owner ??= { binding, startOrdinal: ordinal, count: 1, trailing: 0, finalized: false, abandoned: false, ownedByteOffset: this.lastFrame!.localOffset };
          this.current.owner.binding ??= binding;
          this.bindings.delete(window.startOffset);
          this.windows.set(window.startOffset, { ordinal, window });
        } else if (transition.kind === "window-finalized" || transition.kind === "final-incomplete") {
          const owned = this.windows.get(window.startOffset);
          if (!owned) throw new Error(`Authoritative ownership lacks recorded start ${window.startOffset}`);
          const part = [...this.parts.values()].find((item) => item.owner?.startOrdinal === owned.ordinal);
          if (!part?.owner) throw new Error(`Authoritative ownership lacks recording part ${window.startOffset}`);
          part.owner.count = window.frameCount; part.owner.trailing = Math.max(part.owner.trailing, window.trailingContextFrameCount); part.owner.finalized = true;
          publishClosedPrefix ||= !!part.closed;
        } else if (transition.kind === "window-abandoned") {
          if (this.pendingCandidate?.frame.start === window.startOffset) {
            this.pendingCandidate = null;
            continue;
          }
          const abandoned = this.windows.get(window.startOffset);
          for (const part of this.parts.values()) {
            if (!part.owner || part.owner.startOrdinal !== abandoned?.ordinal) continue;
            part.owner.abandoned = true; part.owner = undefined; part.kind = "auxiliary";
            publishClosedPrefix ||= !!part.closed;
          }
          this.bindings.delete(window.startOffset);
          this.windows.delete(window.startOffset);
        }
      }
      if (publishClosedPrefix) this.schedulePublication();
    } catch (error) { this.fail(error); }
  }

  writeMetaFrame(): void {}
  writeRecord(frame: Buffer, timestamp?: number): void {
    const start = this.sourceBytes;
    const localOffset = this.current.localOffset;
    const encoded = this.current.encoder!.encode(frame, localOffset);
    this.append(Buffer.concat([encodeFrameLength(encoded.length, timestamp), encoded]));
    const end = start + encodeFrameLength(frame.length, timestamp).length + frame.length;
    const ordinal = this.nativeFrameCount++;
    this.sourceRecordCount++; this.current.records++; this.current.sourceEnd = end;
    if (this.current.records === 1) this.current.sourceStart = start;
    this.current.firstTimestamp ??= timestamp; this.current.lastTimestamp = timestamp;
    if (this.current.owner) this.current.owner.count++;
    this.lastFrame = { frame, timestamp, start, end, ordinal, localOffset };
    this.sourceBytes = end;
    if (this.pendingCandidate && ordinal > this.pendingCandidate.frame.ordinal) {
      this.pendingCandidate.suffix.push(this.lastFrame);
      if (this.pendingCandidate.suffix.length > MAX_CANDIDATE_SUFFIX_RECORDS) {
        const error = new Error("Preparation candidate exceeded retained source record limit");
        this.fail(error);
        throw error;
      }
    }
  }
  writeRawCaptureBytes(bytes: Buffer): void {
    this.current.encoder!.reset();
    this.append(bytes);
    for (const record of iterateSessionCaptureRecords(bytes, 0, { strict: true })) {
      if (record.kind === "parser-bootstrap") this.current.bootstrapHash = createHash("sha256").update(record.payload).digest("hex");
      const start = this.sourceBytes;
      const timestamp = record.kind === "frame" && "frameTimeMs" in record ? record.frameTimeMs : undefined;
      const wireLength = record.kind === "frame"
        ? encodeFrameLength(record.frame.length, timestamp).length + record.frame.length
        : record.endOffset - record.offset;
      this.sourceBytes += wireLength; this.sourceRecordCount++; this.current.records++;
      if (this.current.records === 1) this.current.sourceStart = start;
      this.current.sourceEnd = this.sourceBytes;
      if (record.kind === "frame") {
        this.current.firstTimestamp ??= timestamp;
        this.current.lastTimestamp = timestamp;
      }
    }
  }
  writeSegmentBoundary(): void { this.writeRawCaptureBytes(encodeSegmentBoundaryFrame()); }
  requestFullCheckpoint(): void { this.current.encoder!.requestCheckpoint(); }
  getCurrentByteOffset(): number { return this.sourceBytes; }
  flush(): void { this.writer.flush(); }

  stop(): Promise<void> {
    if (!this.stopTask) this.stopTask = this.stopImpl();
    return this.stopTask;
  }
  private async stopImpl(): Promise<void> {
    this.closing = true;
    try { await this.ready; } catch (error) { this.fail(error); }
    await this.startupTask;
    this.writer.flush();
    try { await this.writer.close(); } catch (error) { this.fail(error); }
    if (!this.failure) {
      if (!this.publicationTask) this.schedulePublication();
      if (this.publicationTask) await this.publicationTask;
      if ([...this.parts.values()].some((part) => part.owner && !part.owner.abandoned && (!part.owner.finalized || !part.owner.binding))) {
        this.fail(new Error("Direct capture stopped with unresolved ownership or lap binding"));
      }
    }
    this.lastFrame = null;
    if (this.failure) throw this.failure;
    this.sealed = true;
  }

  private rotate(window: NonNullable<DetectorOwnershipTransition["window"]>, locator: ParserReplayLocator | null, ordinal: number): void {
    const plan = locator ? materializeParserInitializationPlan(locator) : null;
    if (!plan) throw new Error(`Parser initialization unavailable at source offset ${window.startOffset}`);
    // Manifest ordinals count all source records, including parser priming; ownership ordinal remains native.
    const logicalSourceOrdinal = this.current.firstOrdinal + this.current.records;
    const rotated = this.writer.rotate();
    const next = this.part(rotated.current, logicalSourceOrdinal, window.startOffset!, "lap");
    this.parts.set(next.info.id, next); this.current = next; next.encoder!.requestCheckpoint();
    const header = Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame()]);
    next.prefixBytes = header.length; this.append(header);
    if (plan.anchorPayload.length) {
      const bootstrap = encodeParserBootstrapFrame(this.gameId, plan.anchorPayload);
      next.bootstrapHash = createHash("sha256").update(plan.anchorPayload).digest("hex");
      next.prefixBytes += bootstrap.length; this.append(bootstrap);
      if (plan.precedingRecords.length) {
        const contextStart = encodeSegmentContextFrame(); next.prefixBytes += contextStart.length; this.append(contextStart);
        for (const record of plan.precedingRecords) {
          const bytes = Buffer.concat([encodeFrameLength(record.frame.length, record.timestampMs), record.frame]);
          next.prefixBytes += bytes.length; this.append(bytes);
        }
        const end = encodeSegmentContextEndFrame(); next.prefixBytes += end.length; this.append(end);
      }
    }
    if (this.lastFrame) {
      const boundaryLocalOffset = next.localOffset;
      const encoded = next.encoder!.encode(this.lastFrame.frame, boundaryLocalOffset);
      const boundary = Buffer.concat([encodeFrameLength(encoded.length, this.lastFrame.timestamp), encoded]);
      next.owner = { startOrdinal: ordinal, count: 1, trailing: 0, finalized: false, abandoned: false, ownedByteOffset: boundaryLocalOffset };
      next.records = 1; next.sourceStart = this.lastFrame.start; next.sourceEnd = this.lastFrame.end;
      next.firstTimestamp = this.lastFrame.timestamp; next.lastTimestamp = this.lastFrame.timestamp;
      this.lastFrame = { ...this.lastFrame, localOffset: boundaryLocalOffset };
      this.append(boundary);
    }
  }
  private appendStoredFrame(frame: FrameRef): void {
    const localOffset = this.current.localOffset;
    const encoded = this.current.encoder!.encode(frame.frame, localOffset);
    this.append(Buffer.concat([encodeFrameLength(encoded.length, frame.timestamp), encoded]));
    this.current.records++;
    this.current.sourceEnd = frame.end;
    this.current.lastTimestamp = frame.timestamp;
    this.current.owner!.count++;
    this.lastFrame = { ...frame, localOffset };
  }
  private part(info: PreopenedFileInfo, ordinal: number, sourceStart: number, kind: Part["kind"]): Part {
    return { info, encoder: new SparseCaptureEncoder(this.gameId), localOffset: 0, prefixBytes: 0, records: 0, firstOrdinal: ordinal, sourceStart, sourceEnd: sourceStart, kind };
  }
  private append(bytes: Buffer): void { this.writer.appendOwned(bytes); this.current.localOffset += bytes.length; }
  private ordinalAt(offset: number): number | null { return this.lastFrame?.start === offset ? this.lastFrame.ordinal : null; }

  private closed(info: PreopenedFileInfo): void {
    const part = this.parts.get(info.id);
    if (!part || this.failure) return;
    part.closed = true;
    part.encoder = null;
    this.schedulePublication();
  }
  private buildManifestSnapshot(): Manifest {
    const chunks: Chunk[] = [];
    let sourceEnd = META_FRAME_BYTES;
    let recordEnd = 0;
    for (const part of this.parts.values()) {
      if (!part.closed) break;
      if (part.owner && !part.owner.abandoned && (!part.owner.finalized || !part.owner.binding)) break;
      const owner = part.owner && !part.owner.abandoned ? part.owner : undefined;
      const binding = owner?.binding;
      const id = part.chunkId ?? randomUUID();
      part.chunkId = id;
      const chunk = Schema.decodeSync(ChunkSchema)({
        id, kind: binding ? "lap" : "auxiliary",
        ...(binding ? { lapId: String(binding.lapId), lapNumber: binding.lapNumber } : {}),
        path: basename(part.info.path), byteLength: part.info.byteLength, firstOrdinal: part.firstOrdinal,
        recordCount: part.records, sourceStart: part.firstOrdinal, sourceEnd: part.firstOrdinal + part.records,
        sourceByteStart: part.sourceStart, sourceByteEnd: part.sourceEnd, sourceRecordByteOffset: part.prefixBytes,
        ...(part.firstTimestamp === undefined ? {} : { firstTimestamp: part.firstTimestamp }),
        ...(part.lastTimestamp === undefined ? {} : { lastTimestamp: part.lastTimestamp }),
        ...(binding && owner ? { ownedFrameByteOffset: owner.ownedByteOffset, ownedFrameCount: owner.count, trailingContextFrameCount: owner.trailing } : {}),
        ...(part.bootstrapHash ? { parserBootstrapHash: part.bootstrapHash } : {}),
      });
      chunks.push(chunk);
      sourceEnd = part.sourceEnd;
      recordEnd = part.firstOrdinal + part.records;
    }
    this.manifest = Schema.decodeSync(ManifestSchema)({
      version: 3, gameId: this.gameId, sourceRevision: this.manifestRevision,
      sourceByteLength: sourceEnd, sourceRecordCount: recordEnd,
      sourceCoordinates: "native-wire-v1", chunks,
    });
    return this.manifest;
  }
  private schedulePublication(): void {
    if (this.failure || this.sealed) return;
    this.publicationRequested = true;
    if (this.publicationTask) return;
    this.publicationTask = Promise.resolve().then(async () => {
      await this.ready;
      await this.startupTask;
      while (this.publicationRequested && !this.failure) {
        this.publicationRequested = false;
        const snapshot = this.buildManifestSnapshot();
        await this.persistManifest(snapshot);
        this.persistedManifest = snapshot;
        await this.publishReady(snapshot);
      }
    }).catch((error) => this.fail(error)).finally(() => {
      this.publicationTask = null;
      if (this.publicationRequested && !this.failure) this.schedulePublication();
    });
  }
  private async publishReady(snapshot: Manifest): Promise<void> {
    if (this.sessionId === null || this.persistedManifest !== snapshot) return;
    await this.sourceRegistered;
    for (const chunk of snapshot.chunks) {
      if (chunk.kind !== "lap" || chunk.lapId === undefined || chunk.ownedFrameCount === undefined) continue;
      const part = [...this.parts.values()].find((candidate) => basename(candidate.info.path) === chunk.path);
      const binding = part?.owner?.binding;
      if (!binding || this.publishedLapIds.has(binding.lapId)) continue;
      if (String(binding.lapId) !== chunk.lapId || chunk.ownedFrameCount !== binding.frameCount ||
          chunk.lapNumber !== binding.lapNumber) throw new Error(`Persisted lap ${binding.lapId} disagrees with direct capture ownership`);
      await db.transaction(async (tx) => {
        const updated = await tx.update(laps).set({
          captureChunkId: chunk.id, sourceFrameStart: part!.owner!.startOrdinal, sourceFrameCount: chunk.ownedFrameCount,
        }).where(and(
          eq(laps.id, binding.lapId), eq(laps.sessionId, this.sessionId!),
          eq(laps.rawByteOffset, binding.startByteOffset), eq(laps.rawFrameCount, binding.frameCount),
        )).run();
        if (updated.rowsAffected !== 1) throw new Error(`Lap ${binding.lapId} changed during direct capture publication`);
        const sessionUpdated = await tx.update(sessions).set({
          rawFile: this.manifestPath, captureManifestFile: this.manifestPath,
          captureLayoutVersion: 1, captureArchiveFile: null,
        }).where(eq(sessions.id, this.sessionId!)).run();
        if (sessionUpdated.rowsAffected !== 1) throw new Error(`Session ${this.sessionId} changed during direct capture publication`);
      });
      this.publishedLapIds.add(binding.lapId);
      this.notify({ type: "lap-capture-ready", sessionId: this.sessionId, lapId: binding.lapId });
    }
  }
  private async persistManifest(snapshot: Manifest): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.manifestPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { flag: "wx" });
      const handle = await open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.manifestPath);
      const parent = await open(dirname(this.manifestPath), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export class DirectSessionRecorderAdapter extends SparseSessionRecorderAdapter {
  private directCapture: DirectCaptureRecording | null = null;
  private readonly directOwnership: SessionOwnership;
  private readonly directOptions: DirectCaptureRecordingOptions;
  private directEpoch = 0;
  constructor(ownership: SessionOwnership = "mine", options: DirectCaptureRecordingOptions = {}) {
    super(ownership, {}, "offline");
    this.directOwnership = ownership; this.directOptions = options;
  }
  override get active(): boolean { return this.directCapture?.active ?? false; }
  override get path(): string | null { return this.directCapture?.path ?? null; }
  override get epoch(): number { return this.directEpoch; }
  override get sourceOrdinal(): number | undefined { return this.directCapture?.sourceOrdinal; }
  override get workerRecorder(): null { return null; }
  override get supportsLiveSplitting(): false { return false; }
  get capture(): DirectCaptureRecording | null { return this.directCapture; }
  get ready(): Promise<void> { return this.directCapture?.ready ?? Promise.resolve(); }
  override start(gameId: GameId): void {
    const directory = resolve(resolveRecordingGameDirectory(gameId, this.directOwnership), `${timestampForFilename()}-${randomUUID()}`);
    this.directCapture = new DirectCaptureRecording(gameId, directory, join(directory, "capture-manifest.json"), this.directOptions);
    this.directEpoch++;
  }
  attachSession(sessionId: number, sourceRegistered: Promise<void>, notify: (event: Record<string, unknown>) => void): void { this.directCapture?.attachSession(sessionId, sourceRegistered, notify); }
  detachCapture(): DirectCaptureRecording | null { const capture = this.directCapture; this.directCapture = null; return capture; }
  bindLap(binding: PersistedLapBinding): void { this.directCapture?.bindLap(binding); }
  invalidateLap(lapId: number): void { this.directCapture?.invalidateLap(lapId); }
  processTransitions(transitions: readonly DetectorOwnershipTransition[], locator: ParserReplayLocator | null): void { this.directCapture?.processTransitions(transitions, locator); }
  override writeMetaFrame(): void { this.directCapture?.writeMetaFrame(); }
  override writeRecord(buf: Buffer, frameTimeMs?: number): void { this.directCapture?.writeRecord(buf, frameTimeMs); }
  override writeRawCaptureBytes(buf: Buffer): void { this.directCapture?.writeRawCaptureBytes(buf); }
  override writeSegmentBoundary(): void { this.directCapture?.writeSegmentBoundary(); }
  override requestFullCheckpoint(): void { this.directCapture?.requestFullCheckpoint(); }
  override getCurrentByteOffset(): number { return this.directCapture?.getCurrentByteOffset() ?? 0; }
  override flush(): void { this.directCapture?.flush(); }
  override stop(): Promise<void> { const capture = this.directCapture; this.directCapture = null; return capture?.stop() ?? Promise.resolve(); }
}
