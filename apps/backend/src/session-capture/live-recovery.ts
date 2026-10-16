import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { createLiveCaptureWorker } from "./live-worker-factory";
import { Schema } from "effect";
import { and, asc, eq, gte, gt, isNull, lte, notExists, or, sql } from "drizzle-orm";
import {
  LiveMemberReadyMessageSchema, LiveReplayAckSchema, LiveArchiveMemberSchema,
} from "@raceiq/capture-splitting";
import type { GameId, LiveParserPlan } from "@raceiq/capture-splitting";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { encodeParserBootstrapFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame, iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";
import { db } from "@raceiq/backend-core/db/index";
import { liveCaptures, liveCaptureJournal, liveCaptureMembers, laps, sessions } from "@raceiq/backend-core/db/schema";
import { commitLiveCaptureMember, persistLiveCaptureProgress, type LiveCaptureIdentity, type LiveMemberVerification } from "@raceiq/backend-core/db/live-capture-queries";
import { sealLiveCaptureMetadata } from "@raceiq/backend-core/session-capture/live-seal";
import { findReplayCheckpoint, MAX_CHECKPOINT_FRAMES, readSourceRange } from "./live-source-reader";

const REPLAY_BATCH_BYTES = 1024 * 1024;
const REPLAY_QUEUE_BYTES = 2 * 1024 * 1024;
const REPLAY_UNRESOLVED_BYTES = 8 * 1024 * 1024;
const RECOVERY_JOURNAL_PAGE = 1;
const MAX_RECOVERY_JOURNAL_BYTES = 16 * 1024 * 1024;
type CandidateEntry = { kind: "candidate"; candidateId: string; lapNumber: number; preparationOnly: boolean; holdForResolution?: boolean; startByteOffset: number; parserPlan: { gameId: GameId; sequence: number; anchorSequence: number; anchorPayload: string; precedingRecords: ReadonlyArray<{ sequence: number; frame: string; timestampMs?: number }> } };
type WindowEntry = { kind: "window"; revision: number; lapId: number; startByteOffset: number; frameCount: number; trailingContextFrameCount?: number };
type ReplayRecord = { sequence: number; kind: "frame" | "raw" | "segment-boundary"; offset: number; endOffset: number; sourceOffset: number; sourceEndOffset: number; bytes: Uint8Array; frameTimeMs?: number };
type PendingWindow = { journalSequence: number; sourceByteEnd: number; candidate: CandidateEntry; window: WindowEntry; lapNumber: number };
type ReplayControl = { sourceByteEnd: number; kind: "candidate"; candidate: CandidateEntry } |
  { sourceByteEnd: number; kind: "candidate-promote"; candidateId: string; lapNumber: number } |
  { sourceByteEnd: number; kind: "candidate-discard"; candidateId: string } |
  { sourceByteEnd: number; kind: "window"; item: PendingWindow };
const CandidatePlanSchema = Schema.Struct({
  gameId: Schema.Literals(["fm-2023", "f1-2025", "acc", "ac-evo", "lmu", "iracing"]),
  sequence: Schema.Number, anchorSequence: Schema.Number, anchorPayload: Schema.String,
  precedingRecords: Schema.Array(Schema.Struct({ sequence: Schema.Number, frame: Schema.String, timestampMs: Schema.optional(Schema.Number) })),
});
const RecoveryEntrySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("candidate"), candidateId: Schema.String, lapNumber: Schema.Number,
    preparationOnly: Schema.Boolean, holdForResolution: Schema.optional(Schema.Boolean), startByteOffset: Schema.Number, parserPlan: CandidatePlanSchema }),
  Schema.Struct({ kind: Schema.Literal("window"), revision: Schema.Number, lapId: Schema.Number,
    startByteOffset: Schema.Number, frameCount: Schema.Number, trailingContextFrameCount: Schema.optional(Schema.Number) }),
  Schema.Struct({ kind: Schema.Literal("candidate-promote"), candidateId: Schema.String, lapNumber: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("candidate-discard"), candidateId: Schema.String, startByteOffset: Schema.Number }),
]);
const CandidateDiscardedSchema = Schema.Struct({
  type: Schema.Literal("candidate-discarded"), captureEpoch: Schema.String, candidateId: Schema.String,
});


function toReplayRecord(record: SessionCaptureRecord, sequence: number): ReplayRecord {
  const common = { sequence, offset: record.offset, endOffset: record.endOffset, sourceOffset: record.offset, sourceEndOffset: record.endOffset };
  if (record.kind === "frame") return { ...common, kind: "frame", bytes: Buffer.from(record.frame), ...(record.frameTimeMs === undefined ? {} : { frameTimeMs: record.frameTimeMs }) };
  if (record.kind === "segment-boundary") return { ...common, kind: "segment-boundary", bytes: new Uint8Array() };
  const bytes = record.kind === "segment-context" ? encodeSegmentContextFrame()
    : record.kind === "segment-context-end" ? encodeSegmentContextEndFrame()
      : encodeParserBootstrapFrame(record.gameId, record.payload);
  return { ...common, kind: "raw", bytes };
}

/** Replay durable journaled windows and bounded source suffix. Called by backend runtime registration. */
export async function replayLiveCaptureTail(captureEpoch: string): Promise<void> {
  const row = await db.select({ capture: liveCaptures, gameId: sessions.gameId }).from(liveCaptures)
    .innerJoin(sessions, eq(sessions.id, liveCaptures.sessionId)).where(eq(liveCaptures.captureEpoch, captureEpoch)).get();
  if (!row || row.capture.status !== "recovering") throw new Error("Live capture is not eligible for restart replay");
  const capture = row.capture;
  if (!capture.sourcePath.endsWith(".bin")) throw new Error("Restart replay requires an uncompressed canonical live source");
  const lastMemberRow = capture.generation === 0 ? null : await db.select({
    descriptor: liveCaptureMembers.descriptor, generation: liveCaptureMembers.generation,
  }).from(liveCaptureMembers).where(and(eq(liveCaptureMembers.captureEpoch, captureEpoch),
    eq(liveCaptureMembers.generation, capture.generation))).get();
  if ((capture.generation > 0) !== Boolean(lastMemberRow)) throw new Error("Live committed prefix generation is inconsistent");
  const lastMember = lastMemberRow ? Schema.decodeUnknownSync(LiveArchiveMemberSchema)(JSON.parse(lastMemberRow.descriptor)) : null;
  if (lastMember && lastMember.generation !== capture.generation) throw new Error("Live committed descriptor generation is inconsistent");
  const replayOffset = lastMember?.sourceByteEnd ?? 0;
  const replayOrdinal = lastMember?.sourceEnd ?? 0;
  if (replayOffset > capture.metadataDurableWatermark || replayOrdinal > capture.sourceRecordCount) {
    throw new Error("Live committed prefix metadata is inconsistent");
  }
  const candidates = new Map<string, CandidateEntry>();
  const candidateWindows = new Map<string, PendingWindow>();
  const candidateReservations = new Map<string, number>();
  let retainedCandidateBytes = 0;
  const releaseCandidate = (candidateId: string) => {
    retainedCandidateBytes -= candidateReservations.get(candidateId) ?? 0;
    candidateReservations.delete(candidateId);
  };
  async function* journalControls(): AsyncGenerator<ReplayControl> {
    const effectiveStart = sql<number>`coalesce(cast(json_extract(${liveCaptureJournal.payload}, '$.startByteOffset') as integer), ${liveCaptureJournal.sourceByteEnd})`;
    const payloadBytes = sql<number>`length(cast(${liveCaptureJournal.payload} as blob))`;
    let cursorStart = -1, cursorSequence = 0;
    while (true) {
      const page = await db.select({
        sequence: liveCaptureJournal.sequence, sourceByteEnd: liveCaptureJournal.sourceByteEnd, effectiveStart, payloadBytes,
        payload: sql<string>`case when ${payloadBytes} <= ${MAX_RECOVERY_JOURNAL_BYTES} then ${liveCaptureJournal.payload} else null end`,
      }).from(liveCaptureJournal).where(and(eq(liveCaptureJournal.captureEpoch, captureEpoch),
        gte(liveCaptureJournal.sourceByteEnd, replayOffset),
        or(gt(effectiveStart, cursorStart), and(eq(effectiveStart, cursorStart), gt(liveCaptureJournal.sequence, cursorSequence)))))
        .orderBy(asc(effectiveStart), asc(liveCaptureJournal.sequence)).limit(RECOVERY_JOURNAL_PAGE).all();
      if (!page.length) return;
      for (const entry of page) {
        if (typeof entry.payload !== "string" || entry.payloadBytes > MAX_RECOVERY_JOURNAL_BYTES) throw new Error("Live recovery journal entry exceeds bounded replay capacity");
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > capture.durableSequence ||
            !Number.isSafeInteger(entry.sourceByteEnd) || entry.sourceByteEnd < replayOffset || entry.sourceByteEnd > capture.metadataDurableWatermark ||
            !Number.isSafeInteger(entry.effectiveStart) || entry.effectiveStart < 0 || entry.effectiveStart > entry.sourceByteEnd) {
          throw new Error("Live ownership journal lies outside durable metadata");
        }
        cursorStart = entry.effectiveStart; cursorSequence = entry.sequence;
        const decoded = Schema.decodeUnknownSync(RecoveryEntrySchema)(JSON.parse(entry.payload));
        if (decoded.kind === "candidate") {
          const payload: CandidateEntry = decoded;
          if (!payload.candidateId || candidates.has(payload.candidateId) || candidateWindows.has(payload.candidateId) ||
              !Number.isSafeInteger(payload.startByteOffset) || payload.startByteOffset !== entry.sourceByteEnd ||
              !Number.isSafeInteger(payload.lapNumber)) throw new Error("Malformed live candidate journal entry");
          if (candidateReservations.size >= 4 || retainedCandidateBytes + entry.payloadBytes > MAX_RECOVERY_JOURNAL_BYTES) throw new Error("Live recovery active candidate budget exhausted");
          candidateReservations.set(payload.candidateId, entry.payloadBytes);
          retainedCandidateBytes += entry.payloadBytes;
          candidates.set(payload.candidateId, payload);
          yield { sourceByteEnd: payload.startByteOffset, kind: "candidate", candidate: payload };
        } else if (decoded.kind === "candidate-promote") {
          const candidate = candidates.get(decoded.candidateId);
          if (!candidate || !candidate.preparationOnly || entry.sourceByteEnd !== candidate.startByteOffset ||
              !Number.isSafeInteger(decoded.lapNumber)) throw new Error("Live candidate promotion cannot be restored");
          candidate.preparationOnly = false; candidate.lapNumber = decoded.lapNumber;
          yield { sourceByteEnd: candidate.startByteOffset, kind: "candidate-promote", candidateId: decoded.candidateId, lapNumber: decoded.lapNumber };
        } else if (decoded.kind === "candidate-discard") {
          const candidate = candidates.get(decoded.candidateId);
          if (!candidate && decoded.startByteOffset < replayOffset) continue;
          if (!candidate || candidate.startByteOffset !== decoded.startByteOffset || candidateWindows.has(decoded.candidateId)) throw new Error("Abandoned ownership conflicts with a persisted window");
          yield { sourceByteEnd: decoded.startByteOffset, kind: "candidate-discard", candidateId: decoded.candidateId };
          candidates.delete(decoded.candidateId); releaseCandidate(decoded.candidateId);
        } else {
          const payload = decoded;
          const lap = await db.select({ lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount })
            .from(laps).where(and(eq(laps.id, payload.lapId), eq(laps.sessionId, capture.sessionId))).get();
          let candidate: CandidateEntry | undefined;
          for (const value of candidates.values()) if (value.startByteOffset === payload.startByteOffset) { candidate = value; break; }
          if (!candidate && payload.startByteOffset < replayOffset) {
            const committedRow = await db.select({ descriptor: liveCaptureMembers.descriptor }).from(liveCaptureMembers)
              .where(and(eq(liveCaptureMembers.captureEpoch, captureEpoch), eq(liveCaptureMembers.lapId, payload.lapId))).get();
            if (committedRow) {
              const committed = Schema.decodeUnknownSync(LiveArchiveMemberSchema)(JSON.parse(committedRow.descriptor));
              const normalized = committed.ownedFrameCount !== undefined &&
                committed.ownedFrameCount + (committed.trailingContextFrameCount ?? 0) === payload.frameCount;
              if (!lap || committed.kind !== "lap" || committed.lapId !== String(payload.lapId) ||
                  committed.sourceByteStart !== payload.startByteOffset || lap.rawByteOffset !== payload.startByteOffset ||
                  lap.rawFrameCount !== payload.frameCount || (committed.ownedFrameCount !== payload.frameCount && !normalized)) {
                throw new Error("Committed recovery member differs from delayed ownership window");
              }
              continue;
            }
          }
          if (!candidate || candidateWindows.has(candidate.candidateId) || !lap ||
              !Number.isSafeInteger(payload.frameCount) || payload.frameCount < 1 || !Number.isSafeInteger(payload.revision) ||
              lap.rawByteOffset !== payload.startByteOffset || lap.rawFrameCount !== payload.frameCount) throw new Error("Live ownership journal cannot restore candidate/window identity");
          const item: PendingWindow = { journalSequence: entry.sequence, sourceByteEnd: entry.sourceByteEnd, candidate, window: payload, lapNumber: lap.lapNumber };
          candidateWindows.set(candidate.candidateId, item);
          candidates.delete(candidate.candidateId);
          yield { sourceByteEnd: payload.startByteOffset, kind: "window", item };
        }
      }
    }
  }
  const attempt = randomUUID();
  const rotated = await db.update(liveCaptures).set({ attempt, status: "recording", error: null }).where(and(
    eq(liveCaptures.captureEpoch, captureEpoch), eq(liveCaptures.attempt, capture.attempt), eq(liveCaptures.status, "recovering"),
  )).run();
  if (rotated.rowsAffected !== 1) throw new Error("Live restart attempt was fenced");
  const identity: LiveCaptureIdentity = { sessionId: capture.sessionId, captureEpoch, attempt };
  let metadataWatermark = capture.metadataDurableWatermark;
  const advanceAuxiliaryWatermark = async (sourceByteEnd: number) => {
    if (sourceByteEnd <= metadataWatermark) return;
    const unbound = await db.select({ id: laps.id }).from(laps)
      .where(and(eq(laps.sessionId, capture.sessionId), isNull(laps.captureChunkId))).limit(1).get();
    if (unbound) throw new Error("Durable source tail has a persisted lap without authoritative ownership");
    if (!await persistLiveCaptureProgress(identity, {
      sequence: capture.durableSequence, sourceByteLength: capture.sourceByteLength, sourceRecordCount: capture.sourceRecordCount,
      sourceDurableWatermark: capture.sourceDurableWatermark, metadataDurableWatermark: sourceByteEnd,
    }, [])) throw new Error("Auxiliary tail disposition was fenced");
    metadataWatermark = sourceByteEnd;
  };
  const worker = createLiveCaptureWorker(GameIdSchema.parse(row.gameId));
  let sequence = 0;
  const controlAcks = new Map<number, (error?: Error) => void>();
  const controlApplied = new Map<number, (error?: Error) => void>();
  const replayAcks = new Map<number, (error?: Error) => void>();
  const memberCommits = new Set<Promise<void>>();
  let startResolve!: () => void;
  let sealResolve!: () => void;
  let failReject!: (error: Error) => void;
  const started = new Promise<void>((resolve) => { startResolve = resolve; });
  const sealed = new Promise<void>((resolve) => { sealResolve = resolve; });
  const failed = new Promise<never>((_, reject) => { failReject = reject; });
  const sendControl = async (typeName: string, payload: Record<string, unknown>): Promise<void> => {
    const current = ++sequence;
    await Promise.race([new Promise<void>((resolve, reject) => {
      controlAcks.set(current, (error) => {
        if (error) reject(error);
      });
      controlApplied.set(current, (error) => error ? reject(error) : resolve());
      worker.postMessage({ type: "capture-control", sequence: current, typeName, bytes: 512, payload: { ...payload, captureEpoch } });
    }), failed]);
  };
  const commitMessage = async (input: unknown): Promise<void> => {
    const message = Schema.decodeUnknownSync(LiveMemberReadyMessageSchema)(input);
    if (message.captureEpoch !== captureEpoch || message.attempt !== attempt) throw new Error("Recovery member identity mismatch");
    const pending = message.member.kind === "lap" ? candidateWindows.get(message.candidateId) : undefined;
    if (message.member.kind === "lap" && (!pending ||
      message.ownershipJournalSequence !== pending.journalSequence ||
      message.ownershipSourceByteEnd !== pending.sourceByteEnd)) {
      throw new Error("Recovery worker ownership journal coordinates differ from restored window");
    }
    const verification: LiveMemberVerification = {
      nativeDigest: message.nativeDigest,
      parserReplayVerified: message.parserReplayVerified,
      ...(message.parserReplayEvidence ? { parserReplayEvidence: message.parserReplayEvidence } : {}),
    };
    if (message.member.kind === "auxiliary") await advanceAuxiliaryWatermark(message.member.sourceByteEnd);
    const accepted = await commitLiveCaptureMember({ identity, priorGeneration: message.member.generation - 1,
      member: message.member, verification, ownershipRevision: message.ownershipRevision,
      ...(pending ? { ownershipJournalSequence: pending.journalSequence,
        expectedWindow: { lapId: pending.window.lapId, startByteOffset: pending.window.startByteOffset, frameCount: pending.window.frameCount } } : {}) });
    worker.postMessage({ type: "commit-result", captureEpoch, candidateId: message.candidateId, accepted,
      generation: message.member.generation, error: accepted ? undefined : "Recovery publication fence rejected" });
    if (!accepted) throw new Error("Recovery publication fence rejected");
    if (pending) { candidateWindows.delete(message.candidateId); releaseCandidate(message.candidateId); }
  };
  const onMessage = (message: Record<string, unknown>) => {
    if (message.type === "live-started") startResolve();
    else if (message.type === "live-sealed") sealResolve();
    else if (message.type === "candidate-discarded") {
      const disposed = Schema.decodeUnknownSync(CandidateDiscardedSchema)(message);
      candidates.delete(disposed.candidateId);
      releaseCandidate(disposed.candidateId);
    }
    else if (message.type === "live-failed") failReject(new Error(String(message.message ?? "Live replay worker failed")));
    else if ((message.type === "capture-control-ack" || message.type === "live-control-applied") && typeof message.sequence === "number") {
      const acks = message.type === "capture-control-ack" ? controlAcks : controlApplied;
      acks.get(message.sequence)?.(message.error ? new Error(String(message.error)) : undefined);
      acks.delete(message.sequence);
    } else if (message.type === "live-replay-ack" && typeof message.sequence === "number") {
      const ack = Schema.decodeUnknownSync(LiveReplayAckSchema)(message);
      replayAcks.get(ack.sequence)?.(ack.error ? new Error(ack.error) : undefined);
      replayAcks.delete(ack.sequence);
    } else if (message.type === "member-ready") {
      const commit = commitMessage(message).catch((error) => failReject(error instanceof Error ? error : new Error(String(error))));
      memberCommits.add(commit);
      void commit.finally(() => memberCommits.delete(commit));
    }
  };
  worker.on("message", onMessage);
  worker.on("error", failReject);
  worker.postMessage({ type: "start-live", captureEpoch, attempt, sessionId: capture.sessionId,
    archivePath: capture.archivePath, sourcePath: capture.sourcePath,
    maxQueuedBytes: REPLAY_QUEUE_BYTES, maxUnresolvedBytes: REPLAY_UNRESOLVED_BYTES,
    resume: { generation: capture.generation, sourceOrdinal: replayOrdinal, sourceByteOffset: replayOffset,
      committedArchiveLength: capture.committedArchiveLength } });
  let sourceHandle: FileHandle | null = null;
  try {
    await Promise.race([started, failed]);
    sourceHandle = await open(capture.sourcePath, "r");
    const sourceInfo = await sourceHandle.stat({ bigint: true });
    if (!sourceInfo.isFile() || String(sourceInfo.dev) !== capture.sourceDevice || String(sourceInfo.ino) !== capture.sourceInode ||
        sourceInfo.size < BigInt(capture.sourceDurableWatermark)) {
      throw new Error("Live restart source identity or durable length changed");
    }
    const unowned = await db.select({ id: laps.id }).from(laps).where(and(
      eq(laps.sessionId, capture.sessionId), isNull(laps.captureChunkId),
      notExists(db.select({ sequence: liveCaptureJournal.sequence }).from(liveCaptureJournal).where(and(
        eq(liveCaptureJournal.captureEpoch, captureEpoch),
        lte(liveCaptureJournal.sequence, capture.durableSequence),
        lte(liveCaptureJournal.sourceByteEnd, capture.metadataDurableWatermark),
        sql`json_extract(${liveCaptureJournal.payload}, '$.kind') = 'window'`,
        sql`cast(json_extract(${liveCaptureJournal.payload}, '$.lapId') as integer) = ${laps.id}`,
        sql`json_extract(${liveCaptureJournal.payload}, '$.startByteOffset') = ${laps.rawByteOffset}`,
        sql`json_extract(${liveCaptureJournal.payload}, '$.frameCount') = ${laps.rawFrameCount}`,
      ))),
    )).limit(1).get();
    if (unowned) throw new Error("Durable source tail has a persisted lap without authoritative ownership");
    const checkpoint = await findReplayCheckpoint(sourceHandle, replayOffset, capture.sourceDurableWatermark);
    if (replayOffset > checkpoint) {
      let checkpointFrames = 0;
      for await (const record of iterateSessionCaptureRecordsAsync(
        readSourceRange(sourceHandle, checkpoint, replayOffset), { strict: true })) {
        if (record.kind === "frame" && ++checkpointFrames > MAX_CHECKPOINT_FRAMES) {
          throw new Error("Sparse source checkpoint exceeds bounded replay frame scan");
        }
      }
    }
    const controls = journalControls();
    let nextControl = await controls.next();
    let batch: ReplayRecord[] = [];
    let batchBytes = 0;
    let batchEnd = replayOffset;
    let replayedRecordCount = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const last = batch[batch.length - 1]!;
      await Promise.race([new Promise<void>((resolve, reject) => {
        replayAcks.set(last.sequence, (error) => error ? reject(error) : resolve());
        worker.postMessage({ type: "live-replay-batch", captureEpoch, records: batch, bytes: batchBytes,
          sourceDurableSequence: capture.durableSequence, sourceByteEnd: batchEnd });
      }), failed]);
      batch = []; batchBytes = 0;
    };
    const restoreCandidate = async (candidate: CandidateEntry) => {
      const plan = candidate.parserPlan;
      const parserPlan: LiveParserPlan = { gameId: plan.gameId, sequence: plan.sequence, anchorSequence: plan.anchorSequence,
        anchorPayload: Buffer.from(plan.anchorPayload, "base64"), precedingRecords: plan.precedingRecords.map((record) => ({
          sequence: record.sequence, frame: Buffer.from(record.frame, "base64"), ...(record.timestampMs === undefined ? {} : { timestampMs: record.timestampMs }),
        })) };
      await flush();
      await sendControl("candidate-start", { candidateId: candidate.candidateId, lapNumber: candidate.lapNumber,
        startByteOffset: candidate.startByteOffset, preparationOnly: candidate.preparationOnly, parserPlan });
    };
    const applyControl = async (control: ReplayControl) => {
      await flush();
      if (control.kind === "candidate") return restoreCandidate(control.candidate);
      if (control.kind === "candidate-promote") {
        await sendControl("candidate-promote", { candidateId: control.candidateId, lapNumber: control.lapNumber });
        return;
      }
      if (control.kind === "candidate-discard") {
        await sendControl("candidate-discard", { candidateId: control.candidateId });
        return;
      }
      const { item } = control;
      if (item.candidate.preparationOnly) {
        // A finalized prepared window selects its trimmed start, including when its tentative
        // prefix is already committed and therefore absent from this restart's candidate set.
        for (const [candidateId, candidate] of candidates) {
          if (candidate.lapNumber === item.lapNumber && candidate.startByteOffset <= item.window.startByteOffset) {
            await sendControl("candidate-discard", { candidateId });
            candidates.delete(candidateId);
            releaseCandidate(candidateId);
          }
        }
        await sendControl("candidate-promote", { candidateId: item.candidate.candidateId, lapNumber: item.lapNumber });
        item.candidate.preparationOnly = false;
      }
      await sendControl("lap-binding", {
        candidateId: item.candidate.candidateId,
        lapId: String(item.window.lapId),
        ownershipJournalSequence: item.journalSequence,
        ownershipSourceByteEnd: item.sourceByteEnd,
      });
      await sendControl("ownership-finalized", {
        candidateId: item.candidate.candidateId,
        revision: item.window.revision,
        ownershipJournalSequence: item.journalSequence,
        ownershipSourceByteEnd: item.sourceByteEnd,
        window: {
          lapId: String(item.window.lapId),
          lapNumber: item.lapNumber,
          startByteOffset: item.window.startByteOffset,
          frameCount: item.window.frameCount,
          trailingContextFrameCount: item.window.trailingContextFrameCount,
        },
      });
    };
    if (capture.sourceDurableWatermark > checkpoint) {
      for await (const localRecord of iterateSessionCaptureRecordsAsync(
        readSourceRange(sourceHandle, checkpoint, capture.sourceDurableWatermark), { strict: true })) {
        const record = { ...localRecord, offset: localRecord.offset + checkpoint, endOffset: localRecord.endOffset + checkpoint };
        if (record.endOffset <= replayOffset) continue;
        if (record.offset < replayOffset) throw new Error("Committed source cursor is not record-aligned");
        replayedRecordCount++;
        while (!nextControl.done && nextControl.value.sourceByteEnd <= record.offset) {
          await applyControl(nextControl.value);
          nextControl = await controls.next();
        }
        const item = toReplayRecord(record, ++sequence);
        const byteCost = item.bytes.byteLength;
        if (byteCost > REPLAY_BATCH_BYTES) throw new Error("Single source record exceeds bounded replay batch");
        if (batch.length >= 256 || batchBytes + byteCost > REPLAY_BATCH_BYTES) await flush();
        batch.push(item); batchBytes += byteCost; batchEnd = record.endOffset;
      }
    }
    while (!nextControl.done) {
      if (nextControl.value.sourceByteEnd > capture.metadataDurableWatermark) throw new Error("Journaled live control lies beyond replay watermark");
      await applyControl(nextControl.value);
      nextControl = await controls.next();
    }
    await flush();
    if (replayedRecordCount + replayOrdinal !== capture.sourceRecordCount) throw new Error("Replay source record count differs from durable canonical prefix");
    await db.update(liveCaptures).set({ status: "finalizing", error: null }).where(and(eq(liveCaptures.captureEpoch, captureEpoch), eq(liveCaptures.attempt, attempt))).run();
    await sendControl("close-live", { sourceByteOffset: batchEnd });
    await Promise.race([sealed, failed]);
    await Promise.all(memberCommits);
    if (candidateWindows.size > 0) throw new Error("Recovery left journaled ownership windows unpublished");
    await advanceAuxiliaryWatermark(capture.sourceDurableWatermark);
    await sealLiveCaptureMetadata(identity);
  } catch (error) {
    await db.update(liveCaptures).set({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      .where(and(eq(liveCaptures.captureEpoch, captureEpoch), eq(liveCaptures.attempt, attempt))).run();
    throw error;
  } finally {
    worker.off("message", onMessage);
    await worker.terminate();
    if (sourceHandle) await sourceHandle.close();
  }
}
