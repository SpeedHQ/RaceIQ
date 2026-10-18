import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { serialize } from "node:v8";
import { LiveWorkJournal } from "./live-work-journal";
import type { MessagePort } from "node:worker_threads";
import { Schema } from "effect";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { LiveCaptureEventSchema, LiveMemberReadyMessageSchema, LiveReplayAckSchema, LiveReplayBatchSchema, type LiveCaptureEvent, type LiveParserPlan, type LiveReplayBatch } from "./protocol";
import { LiveArchiveMemberSchema, type GameId, type LapWindow, type LiveArchiveMember } from "./contract";
import { FileStreamingSplitterHost } from "./streaming-host";
import { decodeEncodedSourceEvent, type LiveParserReplayEvidence, type StreamingMemberStage, type StreamingSplitterHost } from "./streaming";
import { StreamingCaptureSplitter } from "./streaming-state";

export type LiveWorkerPort = Pick<MessagePort, "postMessage" | "on" | "off">;
export interface LiveWorkerOptions {
  readonly gameId: GameId;
  readonly sourceRecord?: (record: SessionCaptureRecord) => void;
  readonly waitForSourcePrefix?: (sourceByteOffset: number) => Promise<void>;
  readonly readCanonicalBatch?: (sourcePath: string, startOffset: number, endOffset: number, maxBytes: number, maxRecords: number) => Promise<{ records: SessionCaptureRecord[]; nextOffset: number }>;
  readonly closeSourceReader?: () => Promise<void>;
  readonly candidateStart?: (candidateId: string, lapNumber: number, startByteOffset: number, plan: LiveParserPlan, preparationOnly: boolean) => Uint8Array | null;
  readonly bindCandidate?: (candidateId: string, lapId: string) => void;
  readonly finalizeWindow?: (lap: LapWindow) => void;
  readonly replayEvidence?: (lap: LapWindow) => LiveParserReplayEvidence | undefined;
  readonly replayParser?: (stage: StreamingMemberStage, lap: LapWindow, evidence?: LiveParserReplayEvidence) => Promise<void>;
  readonly promoteCandidate?: (candidateId: string) => void;
  readonly discardCandidate?: (candidateId: string) => void;
}
const STATEFUL_GAME_IDS = new Set<GameId>(["ac-evo", "f1-2025", "iracing"]);
const MAX_LIVE_REPLAY_BATCH_RECORDS = 256;

const MessageTypeSchema = Schema.Struct({ type: Schema.String });
const MessagePayloadSchema = Schema.Record(Schema.String, Schema.Unknown);
const SharedWorkerMessageSchema = Schema.Union([
  LiveCaptureEventSchema,
  LiveReplayBatchSchema,
  Schema.Struct({
    type: Schema.Literal("batch"),
    records: Schema.Array(Schema.Struct({ sourceEvent: Schema.optional(MessagePayloadSchema) })),
  }),
  Schema.Struct({
    type: Schema.Literal("capture-control"), sequence: Schema.Number, typeName: Schema.String,
    bytes: Schema.Number, payload: MessagePayloadSchema,
  }),
]);

/** Register ordered splitter controls on a worker that also owns source writes. */
export function registerLiveSplitterWorker(port: LiveWorkerPort, options: LiveWorkerOptions): () => void {
  let splitter: StreamingCaptureSplitter | null = null;
  let captureEpoch: string | null = null;
  let attempt: string | null = null;
  let lastSequence = -1;
  let ownershipRevision = 0;
  let committedGeneration = 0;
  let serial = Promise.resolve();
  let workJournal: LiveWorkJournal<LiveCaptureEvent> | null = null;
  const journalReady = Promise.withResolvers<LiveWorkJournal<LiveCaptureEvent>>();
  void journalReady.promise.catch(() => {});
  let pendingControlBytes = 0;
  let pendingControlRecords = 0;
  const queueControl = (event: LiveCaptureEvent): Promise<void> => {
    const payload = serialize(event);
    if (payload.byteLength > 4 * 1024 * 1024 || pendingControlBytes + payload.byteLength + 4 > 8 * 1024 * 1024 || pendingControlRecords >= 1024) {
      return Promise.reject(new Error("Live control journal reservation exhausted"));
    }
    pendingControlBytes += payload.byteLength + 4;
    pendingControlRecords++;
    return journalReady.promise.then((journal) => journal.appendSerialized(payload)).finally(() => {
      pendingControlBytes -= payload.byteLength + 4;
      pendingControlRecords--;
    });
  };
  let journalPump: Promise<void> | null = null;
  const nativeCache: Array<{ record: SessionCaptureRecord; bytes: number }> = [];
  const MAX_NATIVE_CACHE_BYTES = 8 * 1024 * 1024;
  const MAX_NATIVE_CACHE_RECORDS = 1024;
  let nativeCacheBytes = 0;
  let cacheMiss = false;
  let cacheMissThrough = 0;
  let sourceCursor = 0;
  let lastSourceEnd = 0;
  let sourcePath = "";
  const cacheSourceEvent = (event: Extract<LiveCaptureEvent, { type: "source" }>): void => {
    const records = decodeEncodedSourceEvent(event);
    for (const record of records) {
      if (record.offset < lastSourceEnd || record.endOffset <= record.offset) throw new Error("Live source cache records are unordered");
      lastSourceEnd = record.endOffset;
    }
    if (cacheMiss) {
      cacheMissThrough = records.at(-1)?.endOffset ?? cacheMissThrough;
      return;
    }
    const additions = records.map((record) => ({
      record,
      bytes: (record.kind === "frame" ? record.frame.byteLength : record.kind === "parser-bootstrap" ? record.payload.byteLength : 16) + 64,
    }));
    const addedBytes = additions.reduce((sum, item) => sum + item.bytes, 0);
    if (nativeCache.length + additions.length > MAX_NATIVE_CACHE_RECORDS || nativeCacheBytes + addedBytes > MAX_NATIVE_CACHE_BYTES) {
      cacheMiss = true;
      cacheMissThrough = event.endOffset;
      nativeCache.length = 0;
      nativeCacheBytes = 0;
      return;
    }
    nativeCache.push(...additions);
    nativeCacheBytes += addedBytes;
  };

  const feedRecords = async (records: readonly SessionCaptureRecord[]): Promise<void> => {
    for (const record of records) {
      if (!splitter!.enqueue(record)) {
        await splitter!.drain();
        if (!splitter!.enqueue(record)) throw new Error("Live splitter queue remained full after runnable drain");
      }
    }
  };

  const processThrough = async (sourceByteOffset: number): Promise<void> => {
    await ensureOwnershipResolved(sourceByteOffset);
    await ensureFinalBindings(sourceByteOffset);
    splitter!.advanceWatermark(sourceByteOffset);
    if (cacheMiss) {
      const endOffset = Math.min(sourceByteOffset, cacheMissThrough);
      if (endOffset > sourceCursor) {
        if (!options.waitForSourcePrefix || !options.readCanonicalBatch) throw new Error("Live canonical catch-up reader unavailable");
        await options.waitForSourcePrefix(endOffset);
        while (sourceCursor < endOffset) {
          const batch = await options.readCanonicalBatch(sourcePath, sourceCursor, endOffset, 8 * 1024 * 1024, 256);
          if (batch.nextOffset <= sourceCursor || batch.nextOffset > endOffset) throw new Error("Live canonical reader made invalid progress");
          await feedRecords(batch.records);
          sourceCursor = batch.nextOffset;
        }
      }
      if (sourceByteOffset >= cacheMissThrough) {
        cacheMiss = false;
        cacheMissThrough = 0;
      }
    } else {
      while (nativeCache.length && nativeCache[0]!.record.endOffset <= sourceByteOffset) {
        const item = nativeCache.shift()!;
        nativeCacheBytes -= item.bytes;
        await feedRecords([item.record]);
        sourceCursor = item.record.endOffset;
      }
      if (!nativeCache.length) sourceCursor = Math.max(sourceCursor, sourceByteOffset);
    }
    await splitter!.drain();
  };
  const candidates = new Map<string, { lapNumber: number; startByteOffset: number; parserCheckpoint?: Uint8Array; lapId?: string; revision?: number; ownershipJournalSequence?: number; ownershipSourceByteEnd?: number; preparationOnly: boolean }>();
  const pendingCandidateCommits = new Set<string>();
  const pending = new Map<string, { resolve(value: { generation: number }): void; reject(error: Error): void }>();
  const bindingsAppliedAhead = new Set<number>();
  const ownershipAppliedAhead = new Set<number>();
  const applyBinding = (event: Extract<LiveCaptureEvent, { type: "lap-binding" }>): void => {
    const candidate = candidates.get(event.candidateId);
    if (!splitter || !candidate || event.captureEpoch !== captureEpoch) throw new Error(`Lap binding references unknown candidate ${event.candidateId}`);
    if ((candidate.lapId !== undefined && candidate.lapId !== event.lapId) ||
        (candidate.ownershipJournalSequence !== undefined && candidate.ownershipJournalSequence !== event.ownershipJournalSequence) ||
        (candidate.ownershipSourceByteEnd !== undefined && candidate.ownershipSourceByteEnd !== event.ownershipSourceByteEnd)) {
      throw new Error("Persisted lap identity changed after ownership resolution");
    }
    candidate.lapId = event.lapId;
    candidate.ownershipJournalSequence = event.ownershipJournalSequence;
    candidate.ownershipSourceByteEnd = event.ownershipSourceByteEnd;
    splitter.bindCandidate(event.candidateId, event.lapId);
    options.bindCandidate?.(event.candidateId, event.lapId);
  };
  const applyOwnership = (event: Extract<LiveCaptureEvent, { type: "ownership-finalized" }>): void => {
    ownershipRevision = event.revision;
    const candidate = candidates.get(event.candidateId);
    if (!candidate) throw new Error(`Ownership finalization references unknown candidate ${event.candidateId}`);
    if (candidate.ownershipSourceByteEnd !== undefined && candidate.ownershipSourceByteEnd !== event.ownershipSourceByteEnd) {
      throw new Error("Ownership observation changed after lap binding");
    }
    if (event.ownershipJournalSequence !== undefined) {
      if (candidate.ownershipJournalSequence !== undefined && candidate.ownershipJournalSequence !== event.ownershipJournalSequence) throw new Error("Ownership journal changed after lap binding");
      candidate.ownershipJournalSequence = event.ownershipJournalSequence;
    }
    candidate.ownershipSourceByteEnd = event.ownershipSourceByteEnd;
    candidate.revision = event.revision;
    const window = event.window.startByteOffset === candidate.startByteOffset
      ? { ...event.window, parserCheckpoint: event.window.parserCheckpoint ?? candidate.parserCheckpoint } : event.window;
    splitter!.finalizeCandidate(event.candidateId, window, event.revision);
  };
  const ensureOwnershipResolved = async (sourceByteOffset: number): Promise<void> => {
    for (const [candidateId, candidate] of candidates) {
      if (candidate.preparationOnly || candidate.revision !== undefined) continue;
      let nextStart = Infinity;
      for (const other of candidates.values()) {
        if (!other.preparationOnly && other.startByteOffset > candidate.startByteOffset && other.startByteOffset < sourceByteOffset) {
          nextStart = Math.min(nextStart, other.startByteOffset);
        }
      }
      if (nextStart === Infinity) continue;
      let hasSelectedWindow = false;
      for (const other of candidates.values()) {
        if (other.preparationOnly && other.revision !== undefined &&
            other.startByteOffset >= candidate.startByteOffset && other.startByteOffset < nextStart) {
          hasSelectedWindow = true; break;
        }
      }
      if (hasSelectedWindow) continue;
      const event = await workJournal!.findPending((value) => {
        if (value.type === "candidate-discard") return value.candidateId === candidateId;
        if (value.type !== "ownership-finalized") return false;
        if (value.candidateId === candidateId) return true;
        const selected = candidates.get(value.candidateId);
        return selected?.preparationOnly === true && selected.startByteOffset >= candidate.startByteOffset &&
          selected.startByteOffset < nextStart;
      });
      if (ownershipAppliedAhead.size >= 4) throw new Error("Live ownership lookahead budget exhausted");
      if (event.type === "ownership-finalized") applyOwnership(event);
      else if (event.type === "candidate-discard") splitter!.discardCandidate(event.candidateId);
      else throw new Error("Live journal ownership lookup returned another control");
      ownershipAppliedAhead.add(event.sequence);
    }
  };
  const ensureFinalBindings = async (sourceByteOffset: number): Promise<void> => {
    for (const [candidateId, candidate] of candidates) {
      if (candidate.revision === undefined || candidate.lapId !== undefined || candidate.startByteOffset >= sourceByteOffset) continue;
      const event = await workJournal!.findPending((value) => value.type === "lap-binding" && value.candidateId === candidateId);
      if (event.type !== "lap-binding") throw new Error("Live journal identity lookup returned another control");
      if (bindingsAppliedAhead.size >= 4) throw new Error("Live identity lookahead budget exhausted");
      applyBinding(event);
      bindingsAppliedAhead.add(event.sequence);
    }
  };
  let replayBatchByteLimit = 0;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let queuedSourceByteLimit = 0;
  const emitProgress = () => {
    if (!splitter || !captureEpoch) return;
    const progress = splitter.progress();
    const journal = workJournal?.pending;
    const checkpointBytes = Array.from(candidates.values()).reduce((sum, candidate) => sum + (candidate.parserCheckpoint?.byteLength ?? 0), 0);
    port.postMessage({
      type: "live-worker-progress", captureEpoch,
      sourceCacheBytes: nativeCacheBytes,
      sourceCacheRecords: nativeCache.length,
      queuedSourceBytes: progress.derivedQueueBytes,
      queuedSourceRecords: progress.derivedQueueRecords,
      unresolvedCandidates: progress.unresolvedCandidates,
      unresolvedSourceBytes: progress.unresolvedSourceBytes,
      checkpointBytes,
      pendingControlBytes,
      pendingControlRecords,
      unreadJournalBytes: journal?.unreadBytes ?? 0,
      sourceCacheByteLimit: MAX_NATIVE_CACHE_BYTES,
      sourceCacheRecordLimit: MAX_NATIVE_CACHE_RECORDS,
      queuedSourceByteLimit,
      pendingControlByteLimit: 8 * 1024 * 1024,
      pendingControlRecordLimit: 1024,
    });
  };
  let lastReplayDurableSequence = 0;
  let terminalError: Error | null = null;
  const stopLive = (reason: unknown, notify = true): void => {
    if (terminalError) return;
    terminalError = reason instanceof Error ? reason : new Error(String(reason));
    const error = terminalError;
    journalReady.reject(error);
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    clearInterval(progressTimer ?? undefined);
    progressTimer = null;
    if (notify) port.postMessage({ type: "live-failed", captureEpoch, message: error.message });
    // Defer cleanup so an onError callback can safely re-enter abort after the
    // splitter has installed its terminal cleanup promise.
    const stopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([splitter?.abort(error), workJournal?.close()]);
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      try { await options.closeSourceReader?.(); } catch (cleanupError) { errors.push(cleanupError); }
      if (errors.length) throw new AggregateError(errors, "Live splitter cleanup failed");
    });
    void stopping.catch((cleanupError) => {
      port.postMessage({ type: "live-failed", captureEpoch, message: String(cleanupError) });
    });
  };

  const handle = async (event: LiveCaptureEvent): Promise<void> => {
    if (terminalError) throw terminalError;
    if (event.type === "commit-result") {
      if (event.captureEpoch !== captureEpoch) throw new Error("Live commit result belongs to another capture epoch");
      const waiting = pending.get(event.candidateId);
      if (!waiting) throw new Error(`Unexpected live commit result: ${event.candidateId}`);
      pending.delete(event.candidateId);
      if (event.accepted && event.generation !== undefined) waiting.resolve({ generation: event.generation });
      else waiting.reject(new Error(event.error ?? "Live member commit rejected or omitted generation"));
      if (pendingCandidateCommits.delete(event.candidateId)) candidates.delete(event.candidateId);
      return;
    }
    if (event.type === "start-live") {
      if (splitter) throw new Error("Live splitter already started");
      sourcePath = event.sourcePath;
      sourceCursor = event.resume?.sourceByteOffset ?? 0;
      lastSourceEnd = sourceCursor;
      nativeCache.length = 0;
      nativeCacheBytes = 0;
      cacheMiss = false;
      cacheMissThrough = 0;
      replayBatchByteLimit = event.maxQueuedBytes;
      const fileHost = new FileStreamingSplitterHost({
        archivePath: event.archivePath,
        ...(event.resume ? { initialCommittedLength: event.resume.committedArchiveLength } : {}),
        maxQueuedBytes: event.maxQueuedBytes,
        maxUnresolvedBytes: event.maxUnresolvedBytes,
        commit: async (descriptor) => {
          if (terminalError) throw terminalError;
          const candidateEntry = descriptor.lap ? [...candidates.entries()].find(([candidateId, candidate]) =>
            candidate.lapId === descriptor.lap!.lapId || candidateId === descriptor.lap!.lapId) : undefined;
          const candidateId = candidateEntry?.[0] ?? descriptor.lap?.lapId ?? descriptor.id;
          if (descriptor.lap && !candidateEntry?.[1].lapId) throw new Error(`Lap ${descriptor.lap.lapId} has no persisted binding`);
          const nextGeneration = committedGeneration + 1;
          const entryName = `${String(nextGeneration).padStart(6, "0")}-${descriptor.kind === "lap" ? `lap-${descriptor.lap?.lapNumber}` : "aux"}.bin`;
          const lapId = candidateEntry?.[1].lapId ?? descriptor.lap?.lapId;
          const member: LiveArchiveMember = Schema.decodeUnknownSync(LiveArchiveMemberSchema)({
            id: entryName,
            kind: descriptor.kind,
            ...(descriptor.kind === "lap" ? {
              lapId,
              lapNumber: descriptor.lap?.lapNumber,
              ownedFrameCount: descriptor.ownedFrameCount,
              trailingContextFrameCount: descriptor.trailingContextFrameCount,
            } : {}),
            entryName,
            memberOffset: descriptor.memberOffset,
            compressedByteLength: descriptor.compressedByteLength,
            byteLength: descriptor.byteLength,
            firstOrdinal: descriptor.firstOrdinal,
            recordCount: descriptor.recordCount,
            sourceStart: descriptor.sourceStart,
            sourceEnd: descriptor.sourceEnd,
            sourceByteStart: descriptor.sourceByteStart,
            sourceByteEnd: descriptor.sourceByteEnd,
            ...(descriptor.firstTimestamp === undefined ? {} : { firstTimestamp: descriptor.firstTimestamp }),
            ...(descriptor.lastTimestamp === undefined ? {} : { lastTimestamp: descriptor.lastTimestamp }),
            ...(descriptor.ownedFrameByteOffset === undefined ? {} : { ownedFrameByteOffset: descriptor.ownedFrameByteOffset }),
            ...(descriptor.parserBootstrapHash ? { parserBootstrapHash: descriptor.parserBootstrapHash } : {}),
            generation: nextGeneration,
          });
          const revision = candidateEntry?.[1].revision ?? ownershipRevision;
          const evidence = descriptor.parserReplayEvidence;
          const parserReplayVerified = descriptor.kind === "lap" && descriptor.parserReplayVerified === true;
          if (descriptor.kind === "lap" && !parserReplayVerified) throw new Error("Lap member lacks successful parser replay");
          if (descriptor.kind === "lap" && !evidence) throw new Error("Lap member lacks parser replay evidence");
          const ownershipJournalSequence = descriptor.kind === "lap" ? candidateEntry?.[1].ownershipJournalSequence : undefined;
          const ownershipSourceByteEnd = descriptor.kind === "lap" ? candidateEntry?.[1].ownershipSourceByteEnd : undefined;
          if (descriptor.kind === "lap" && (ownershipJournalSequence === undefined || ownershipSourceByteEnd === undefined)) {
            throw new Error("Lap member lacks durable ownership journal coordinates");
          }
          const message = Schema.decodeUnknownSync(LiveMemberReadyMessageSchema)({
            type: "member-ready", captureEpoch, attempt, candidateId, ownershipRevision: revision,
            ...(ownershipJournalSequence === undefined ? {} : { ownershipJournalSequence }),
            ...(ownershipSourceByteEnd === undefined ? {} : { ownershipSourceByteEnd }), member,
            nativeDigest: descriptor.nativeDigest,
            parserReplayVerified,
            ...(evidence ? { parserReplayEvidence: evidence } : {}),
          });
          const acknowledgement = await new Promise<{ generation: number }>((resolve, reject) => {
            if (descriptor.kind === "lap") pendingCandidateCommits.add(candidateId);
            pending.set(candidateId, { resolve, reject });
            port.postMessage(message);
          });
          if (acknowledgement.generation !== nextGeneration) throw new Error("Committed generation differs from staged member generation");
          committedGeneration = acknowledgement.generation;
          return acknowledgement;
        },
      });
      const host: StreamingSplitterHost = {
        maxQueuedBytes: fileHost.maxQueuedBytes,
        maxUnresolvedBytes: fileHost.maxUnresolvedBytes,
        auxiliaryMemberBytes: fileHost.auxiliaryMemberBytes,
        createStage: (kind, id) => fileHost.createStage(kind, id),
        createPositionSpool: () => fileHost.createPositionSpool(),
        dispose: () => fileHost.dispose(),
        finalizeWindow: options.finalizeWindow,
        discardCandidate: (candidateId) => {
          candidates.delete(candidateId);
          if (!options.discardCandidate) throw new Error("Live parser candidate discard callback unavailable");
          options.discardCandidate(candidateId);
          port.postMessage({ type: "candidate-discarded", captureEpoch, candidateId });
        },
        ...(options.replayParser ? { replayParser: options.replayParser } : {}),
        ...(options.replayEvidence ? { replayEvidence: options.replayEvidence } : {}),
      };
      splitter = new StreamingCaptureSplitter({
        gameId: options.gameId, host, sourceRecord: options.sourceRecord, onError: stopLive,
      });
      if (event.resume) {
        splitter.resume(event.resume.generation, event.resume.sourceOrdinal, event.resume.sourceByteOffset);
        committedGeneration = event.resume.generation;
      }
      queuedSourceByteLimit = event.maxQueuedBytes;
      workJournal = await LiveWorkJournal.create(join(dirname(event.archivePath), `.live-controls-${randomUUID()}`), {
        maxPendingBytes: 8 * 1024 * 1024, maxPendingRecords: 1024, maxRecordBytes: 4 * 1024 * 1024,
      });
      if (terminalError) {
        await workJournal.close();
        throw terminalError;
      }
      journalReady.resolve(workJournal);
      progressTimer = setInterval(emitProgress, 250);
      journalPump = (async () => {
        for await (const control of workJournal!.readAvailable()) {
          let latestControl = control;
          let coalescedSequences: number[] | undefined;
          if (control.type === "watermark") {
            let watermark = control;
            // Adjacent progress fences share ownership. Do not cross a candidate, binding, or close control:
            // lookahead must still see those controls when canonical catch-up resolves late ownership.
            await workJournal!.consumeAvailableWhile(
              (next) => next.type === "watermark" && next.captureEpoch === control.captureEpoch &&
                next.sourceByteOffset >= watermark.sourceByteOffset,
              (next) => {
                if (next.type !== "watermark") throw new Error("Live progress coalescing consumed another control");
                (coalescedSequences ??= []).push(next.sequence);
                watermark = next;
              },
              64,
            );
            latestControl = watermark;
          }
          const job = serial.then(() => handle(latestControl));
          serial = job.catch(stopLive);
          await job;
          if ("sequence" in control) port.postMessage({ type: "live-control-applied", captureEpoch, sequence: control.sequence });
          if (coalescedSequences) {
            for (const sequence of coalescedSequences) port.postMessage({ type: "live-control-applied", captureEpoch, sequence });
          }
          if (control.type === "close-live") break;
        }
        await workJournal?.close();
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        emitProgress();
        if (terminalError) throw terminalError;
        port.postMessage({ type: "live-sealed", captureEpoch, generation: committedGeneration });
      })();
      void journalPump.catch(stopLive);
      port.postMessage({ type: "live-started", captureEpoch });
      return;
    }
    if (!splitter || event.captureEpoch !== captureEpoch) throw new Error("Live splitter is not started for capture epoch");
    if (event.type === "source") {
      if (cacheMiss) {
        cacheMissThrough = Math.max(cacheMissThrough, event.endOffset);
        lastSourceEnd = Math.max(lastSourceEnd, event.endOffset);
        return;
      }
      if (event.bytes.byteLength > MAX_NATIVE_CACHE_BYTES || nativeCacheBytes + event.bytes.byteLength + 64 > MAX_NATIVE_CACHE_BYTES) {
        cacheMiss = true;
        cacheMissThrough = event.endOffset;
        nativeCache.length = 0;
        nativeCacheBytes = 0;
        lastSourceEnd = Math.max(lastSourceEnd, event.endOffset);
        return;
      }
      cacheSourceEvent(event);
    } else if (event.type === "candidate-start") {
      const parserCheckpoint = options.candidateStart?.(
        event.candidateId, event.lapNumber, event.startByteOffset, event.parserPlan, event.preparationOnly,
      );
      if (parserCheckpoint === null || parserCheckpoint === undefined ||
        (STATEFUL_GAME_IDS.has(options.gameId) && parserCheckpoint.byteLength === 0)) {
        throw new Error(`Parser initialization unavailable for candidate ${event.candidateId}`);
      }
      const ownedCheckpoint = Uint8Array.from(parserCheckpoint);
      splitter.startCandidate(event.candidateId, event.lapNumber, event.startByteOffset, ownedCheckpoint, event.preparationOnly);
      candidates.set(event.candidateId, {
        lapNumber: event.lapNumber,
        startByteOffset: event.startByteOffset,
        preparationOnly: event.preparationOnly,
        ...(ownedCheckpoint.byteLength ? { parserCheckpoint: ownedCheckpoint } : {}),
      });
      if (candidates.size > 4) throw new Error("Live worker candidate budget exceeded");
    } else if (event.type === "candidate-promote") {
      const candidate = candidates.get(event.candidateId);
      if (!candidate || !candidate.preparationOnly) throw new Error(`Candidate promotion references unknown preparation candidate ${event.candidateId}`);
      if (!options.promoteCandidate) throw new Error("Live parser candidate promotion callback unavailable");
      splitter.promoteCandidate(event.candidateId, event.lapNumber);
      options.promoteCandidate(event.candidateId);
      candidate.preparationOnly = false;
      candidate.lapNumber = event.lapNumber;
    } else if (event.type === "candidate-discard") {
      if (!ownershipAppliedAhead.delete(event.sequence)) splitter.discardCandidate(event.candidateId);
    } else if (event.type === "lap-binding") {
      if (!bindingsAppliedAhead.delete(event.sequence)) applyBinding(event);
    } else if (event.type === "ownership-finalized") {
      if (!ownershipAppliedAhead.delete(event.sequence)) applyOwnership(event);
    } else if (event.type === "watermark") {
      await processThrough(event.sourceByteOffset);
      emitProgress();
    } else if (event.type === "close-live") {
      await processThrough(event.sourceByteOffset);
      await splitter.close();
      await options.closeSourceReader?.();
    }
  };

  const dispatch = (event: LiveCaptureEvent): Promise<void> => {
    if (terminalError) return Promise.reject(terminalError);
    if (event.type === "start-live") {
      if (captureEpoch && captureEpoch !== event.captureEpoch) throw new Error("Live worker cannot change capture epoch");
      captureEpoch = event.captureEpoch;
      attempt = event.attempt;
      const job = serial.then(() => handle(event));
      serial = job.catch((error) => {
        journalReady.reject(error);
        stopLive(error);
      });
      return job;
    }
    if (event.type === "commit-result") return handle(event);
    if ("sequence" in event) {
      if (event.sequence <= lastSequence) return Promise.reject(new Error("Live event sequence is not increasing"));
      lastSequence = event.sequence;
    }
    if (event.type === "source") return handle(event);
    return queueControl(event);
  };
  const parseEvent = (value: unknown): LiveCaptureEvent | null => {
    try { return Schema.decodeUnknownSync(LiveCaptureEventSchema)(value); }
    catch { return null; }
  };
  const listener = (input: unknown) => {
    let message: typeof SharedWorkerMessageSchema.Type;
    try { message = Schema.decodeUnknownSync(SharedWorkerMessageSchema)(input); }
    catch (error) {
      let type: string;
      try { type = Schema.decodeUnknownSync(MessageTypeSchema)(input).type; } catch { return; }
      // Source-writer start/sync/close messages belong to the other shared-worker listener.
      if (type === "batch" || type === "capture-control" || type === "live-replay-batch") {
        port.postMessage({ type: "live-failed", captureEpoch, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === "live-replay-batch") {
      const batch: LiveReplayBatch = message;
      const job = serial.then(async () => {
        if (batch.captureEpoch !== captureEpoch || !splitter) throw new Error("Replay batch belongs to another capture epoch");
        if (batch.sourceDurableSequence < lastReplayDurableSequence) throw new Error("Replay durability sequence moved backwards");
        if (!batch.records.length || batch.records.length > MAX_LIVE_REPLAY_BATCH_RECORDS ||
          batch.bytes > replayBatchByteLimit) throw new Error("Replay batch exceeds configured byte budget");
        const payloadBytes = batch.records.reduce((sum, record) => sum + record.bytes.byteLength, 0);
        if (payloadBytes !== batch.bytes) throw new Error("Replay batch byte reservation mismatch");
        let previousSequence = lastSequence;
        let previousSourceEnd = -1;
        for (const record of batch.records) {
          if (record.sequence <= previousSequence || record.sourceEndOffset < record.sourceOffset ||
            (previousSourceEnd >= 0 && record.sourceOffset < previousSourceEnd)) {
            throw new Error("Replay batch records are unordered");
          }
          previousSequence = record.sequence;
          previousSourceEnd = record.sourceEndOffset;
        }
        const lastRecord = batch.records[batch.records.length - 1]!;
        if (batch.sourceByteEnd < lastRecord.sourceEndOffset) throw new Error("Replay batch source end precedes final record");
        for (const record of batch.records) {
          const event = Schema.decodeUnknownSync(LiveCaptureEventSchema)({
            type: "source", captureEpoch: batch.captureEpoch, ...record,
          });
          await handle(event);
        }
        lastSequence = previousSequence;
        await processThrough(batch.sourceByteEnd);
        lastReplayDurableSequence = batch.sourceDurableSequence;
      });
      serial = job.catch((error) => {
        port.postMessage({ type: "live-failed", captureEpoch, message: error instanceof Error ? error.message : String(error) });
      });
      void job.then(
        () => port.postMessage(Schema.decodeUnknownSync(LiveReplayAckSchema)({
          type: "live-replay-ack", captureEpoch: batch.captureEpoch,
          sequence: batch.records[batch.records.length - 1]!.sequence,
          bytes: batch.bytes, sourceDurableSequence: batch.sourceDurableSequence,
          sourceByteEnd: batch.sourceByteEnd, acceptedRecordCount: batch.records.length,
        })),
        (error) => port.postMessage(Schema.decodeUnknownSync(LiveReplayAckSchema)({
          type: "live-replay-ack", captureEpoch: batch.captureEpoch,
          sequence: batch.records[batch.records.length - 1]?.sequence ?? 0,
          bytes: batch.bytes, sourceDurableSequence: batch.sourceDurableSequence,
          sourceByteEnd: batch.sourceByteEnd, acceptedRecordCount: 0,
          error: error instanceof Error ? error.message : String(error),
        })),
      );
      return;
    }
    if (message.type === "batch") {
      for (const record of message.records) {
        if (!record.sourceEvent) continue;
        const event = parseEvent({ type: "source", captureEpoch, ...record.sourceEvent });
        if (!event) {
          stopLive(new Error("Invalid canonical source event"));
          return;
        }
        void dispatch(event).catch(stopLive);
      }
      return;
    }
    if (message.type === "capture-control") {
      const sequence = message.sequence;
      const bytes = message.bytes;
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(bytes) || bytes < 0) {
        stopLive(new Error("Invalid ordered live control envelope"));
        return;
      }
      const payload = message.payload;
      const event = parseEvent({
        ...payload,
        type: message.typeName,
        sequence,
        captureEpoch: payload.captureEpoch ?? captureEpoch,
      });
      if (!event) {
        port.postMessage({ type: "capture-control-ack", sequence, bytes, error: "Invalid live control" });
        return;
      }
      void dispatch(event).then(
        () => port.postMessage({ type: "capture-control-ack", sequence, bytes }),
        (error) => port.postMessage({ type: "capture-control-ack", sequence, bytes, error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    void dispatch(message).catch(stopLive);
  };
  port.on("message", listener);
  return () => {
    port.off("message", listener);
    stopLive(new Error("Live splitter worker stopped"), false);
  };
}
