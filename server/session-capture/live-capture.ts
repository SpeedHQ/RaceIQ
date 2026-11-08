import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { LiveArchiveMemberSchema, type LiveArchiveMember } from "@raceiq/capture-splitting";
import type { WorkerSessionRecorder, WorkerDurabilityAcknowledgement } from "@raceiq/capture-formats/session/worker-recorder";
import { META_FRAME_BYTES } from "@raceiq/capture-formats/session/framing";
import type { GameId } from "@raceiq/shared/games/ids";
import type { DetectorOwnershipTransition, DetectorOwnershipWindow } from "@raceiq/telemetry-core/processor/ordinal-engine";
import { materializeParserInitializationPlan, type ParserReplayLocator } from "../games/packet-dispatch";
import type { PersistedLapBinding } from "../telemetry/pipeline-ports";
import { beginLiveCapture, bindLiveCaptureSourceIdentity, commitLiveCaptureMember, persistLiveCaptureProgress, setLiveCaptureStatus, type LiveCaptureIdentity, type LiveCaptureWindow } from "../db/live-capture-queries";
import { registerActiveLiveCapture } from "./live-recovery";
import { sealLiveCaptureMetadata } from "./live-seal";

const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MemberReadySchema = Schema.Struct({
  type: Schema.Literal("member-ready"), captureEpoch: Schema.String, attempt: Schema.String,
  candidateId: Schema.String, ownershipRevision: Schema.Natural,
  ownershipJournalSequence: Schema.optional(Schema.Natural), ownershipSourceByteEnd: Schema.optional(Schema.Natural),
  member: LiveArchiveMemberSchema,
  nativeDigest: Schema.String,
  parserReplayVerified: Schema.Boolean,
  parserReplayEvidence: Schema.optional(Schema.Struct({
    sourceFrameCount: Schema.Natural, parsedFrameCount: Schema.Natural, nullFrameCount: Schema.Natural,
    orderedTelemetryDigest: Schema.optional(Schema.String),
  })),
});
const CandidateDiscardedSchema = Schema.Struct({
  type: Schema.Literal("candidate-discarded"), captureEpoch: Schema.String, candidateId: Schema.String,
});
interface Candidate {
  id: string;
  startByteOffset: number;
  preparationOnly: boolean;
  holdForResolution?: boolean;
  window?: DetectorOwnershipWindow;
  binding?: PersistedLapBinding;
  journalSequence?: number;
  observationByteEnd?: number;
}

/** Host DB boundary. Ingress methods only reserve bounded metadata and post controls. */
export class LiveCaptureSession {
  readonly identity: LiveCaptureIdentity;
  readonly archivePath: string;
  private readonly candidates = new Map<number, Candidate>();
  private readonly bindings = new Map<number, PersistedLapBinding>();
  private readonly readyLaps = new Set<number>();
  isLapReady(lapId: number): boolean { return this.readyLaps.has(lapId); }
  private readonly journal: Array<{ sequence: number; sourceByteEnd: number; payload: unknown; byteCost: number }> = [];
  private journalSequence = 0;
  private journalBytes = 0;
  private processedByteEnd = 0;
  private watermarkTimer: ReturnType<typeof setTimeout> | null = null;
  private durable: WorkerDurabilityAcknowledgement | null = null;
  private sourceFileIdentity: { device: string; inode: string } | null = null;
  private persistence: Promise<void> | null = null;
  private progressDirty = false;
  private failure: Error | null = null;
  private closing = false;
  private sealed = false;
  private metadataSealed = false;
  get isSealed(): boolean { return this.metadataSealed; }
  get hasFailed(): boolean { return this.failure !== null; }
  private readonly started: Promise<void>;
  private readonly sealedResult = Promise.withResolvers<void>();
  private readonly detachDurability: () => void;
  private readonly detachFailure: () => void;
  private readonly detachActive: () => void;
  readonly sessionId: number;
  readonly gameId: GameId;
  private readonly recorder: WorkerSessionRecorder;
  private readonly notify: (event: Record<string, unknown>) => void;

  constructor(
    sessionId: number,
    gameId: GameId,
    recorder: WorkerSessionRecorder,
    notify: (event: Record<string, unknown>) => void,
    sourceRegistered?: Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.gameId = gameId;
    this.recorder = recorder;
    this.notify = notify;
    if (!recorder.path) throw new Error("Cannot attach live capture before source path reservation");
    const captureEpoch = randomUUID();
    this.identity = { sessionId, captureEpoch, attempt: randomUUID() };
    this.archivePath = join(dirname(recorder.path), `session-${sessionId}`, `live-${captureEpoch}`, "capture.bin.gz");
    this.detachActive = registerActiveLiveCapture(captureEpoch);
    const sourcePath = recorder.path;
    this.started = sourceRegistered
      ? sourceRegistered.then(() => beginLiveCapture({ ...this.identity, sourcePath, archivePath: this.archivePath }))
      : beginLiveCapture({ ...this.identity, sourcePath, archivePath: this.archivePath });
    void this.started.then(() => {
      if (!this.failure) this.notify({ type: "recording-started", sessionId: this.sessionId, gameId: this.gameId, captureEpoch: this.identity.captureEpoch });
    }).catch((error) => this.fail(error));
    void this.sealedResult.promise.catch(() => {});
    this.detachDurability = recorder.onDurableAcknowledgement((ack) => {
      this.durable = ack;
      this.schedulePersistence();
    });
    this.detachFailure = recorder.onFailure((error) => this.fail(error));
    recorder.worker.on("message", this.onWorkerMessage);
    try {
      this.control("start-live", { ...this.identity, archivePath: this.archivePath, sourcePath,
        maxQueuedBytes: MAX_METADATA_BYTES, maxUnresolvedBytes: MAX_METADATA_BYTES }, 1024);
    } catch (error) { this.fail(error); this.dispose(); }
  }

  /** Persisted identity binding never creates or changes source ownership. */
  bindLap(binding: PersistedLapBinding): void {
    if (binding.sessionId !== this.sessionId || this.failure) return;
    if (this.bindings.size >= 128 && !this.bindings.has(binding.startByteOffset)) {
      this.fail(new Error("Live lap binding budget exhausted")); return;
    }
    this.bindings.set(binding.startByteOffset, binding);
    const candidate = this.candidates.get(binding.startByteOffset);
    if (candidate) {
      candidate.binding = binding;
      this.finalizeBoundCandidate(candidate);
    }
  }

  invalidateLap(lapId: number): void {
    this.readyLaps.delete(lapId);
    for (const [offset, binding] of this.bindings) {
      if (binding.lapId !== lapId) continue;
      this.bindings.delete(offset);
      const candidate = this.candidates.get(offset);
      if (candidate?.binding?.lapId !== lapId) continue;
      candidate.binding = undefined;
      if (candidate.journalSequence !== undefined) this.fail(new Error(`Lap ${lapId} was deleted during publication`));
    }
  }

  processTransitions(
    transitions: readonly DetectorOwnershipTransition[],
    locator: ParserReplayLocator | null | undefined,
    processedByteEnd: number,
  ): void {
    if (this.failure || this.closing) return;
    try {
      this.processedByteEnd = Math.max(this.processedByteEnd, processedByteEnd);
      for (const transition of transitions) {
        const window = transition.window;
        if ((transition.kind === "window-start" || transition.kind === "candidate-start") && window?.startOffset !== null && window?.startOffset !== undefined) {
          if (transition.kind === "window-start") {
            for (const candidate of this.candidates.values()) {
              if (candidate.preparationOnly && candidate.startByteOffset < window.startOffset) candidate.holdForResolution = false;
            }
          }
          if (!this.candidates.has(window.startOffset)) {
            if (transition.kind === "candidate-start") {
              for (const [offset, candidate] of this.candidates) {
                if (candidate.preparationOnly && !candidate.window && !candidate.holdForResolution) this.candidates.delete(offset);
              }
            }
            const plan = locator ? materializeParserInitializationPlan(locator) : null;
            if (!plan) throw new Error(`Parser initialization exceeds capture budget at source offset ${window.startOffset}`);
            if (this.candidates.size >= 4) throw new Error("Live unresolved candidate budget exhausted");
            const candidate: Candidate = { id: `${this.identity.captureEpoch}:${window.startOffset}`, startByteOffset: window.startOffset, preparationOnly: transition.kind === "candidate-start", holdForResolution: window.holdForResolution, binding: this.bindings.get(window.startOffset) };
            this.candidates.set(window.startOffset, candidate);
            const byteCost = plan.anchorPayload.byteLength + plan.precedingRecords.reduce((sum, record) => sum + record.frame.byteLength + 32, 0) + 512;
            this.control("candidate-start", { candidateId: candidate.id, lapNumber: window.lapNumber, startByteOffset: window.startOffset, preparationOnly: candidate.preparationOnly, parserPlan: plan }, byteCost);
            const persistedPlan = { ...plan, anchorPayload: Buffer.from(plan.anchorPayload).toString("base64"), precedingRecords: plan.precedingRecords.map((record) => ({ ...record, frame: record.frame.toString("base64") })) };
            this.addJournal(window.startOffset, { kind: "candidate", candidateId: candidate.id, lapNumber: window.lapNumber,
              startByteOffset: window.startOffset, preparationOnly: candidate.preparationOnly,
              holdForResolution: candidate.holdForResolution, parserPlan: persistedPlan });
          }
          const existing = this.candidates.get(window.startOffset);
          if (transition.kind === "window-start" && existing?.preparationOnly) {
            existing.preparationOnly = false;
            existing.holdForResolution = false;
            this.control("candidate-promote", { candidateId: existing.id, lapNumber: window.lapNumber }, 128);
            this.addJournal(window.startOffset, { kind: "candidate-promote", candidateId: existing.id, lapNumber: window.lapNumber });
          }
        } else if (transition.kind === "window-abandoned" && window?.startOffset !== null && window?.startOffset !== undefined) {
          const candidate = this.candidates.get(window.startOffset);
          if (candidate) {
            if (candidate.window || candidate.binding || this.bindings.has(window.startOffset)) throw new Error("Abandoned ownership already has a persisted lap");
            this.control("candidate-discard", { candidateId: candidate.id }, 128);
            this.addJournal(this.processedByteEnd, { kind: "candidate-discard", candidateId: candidate.id, startByteOffset: candidate.startByteOffset });
            this.candidates.delete(window.startOffset);
          }
        } else if ((transition.kind === "window-finalized" || transition.kind === "final-incomplete") && window?.startOffset !== null && window?.startOffset !== undefined && window.frameCount > 0) {
          const candidate = this.candidates.get(window.startOffset);
          if (!candidate) {
            throw new Error(`Authoritative window has no prepared initialization at ${window.startOffset}`);
          }
          candidate.window = window;
          candidate.binding ??= this.bindings.get(window.startOffset);
          candidate.observationByteEnd = this.processedByteEnd;
          this.control("ownership-finalized", {
            candidateId: candidate.id, revision: window.revision, ownershipSourceByteEnd: candidate.observationByteEnd,
            window: { lapId: candidate.id, lapNumber: window.lapNumber, startByteOffset: candidate.startByteOffset,
              frameCount: window.frameCount, trailingContextFrameCount: window.trailingContextFrameCount },
          }, 512);
          this.finalizeBoundCandidate(candidate);
        }
      }
      if (!this.watermarkTimer) this.watermarkTimer = setTimeout(() => this.flushWatermark(), 8);
    } catch (error) { this.fail(error); }
  }

  private finalizeBoundCandidate(candidate: Candidate): void {
    const { window, binding } = candidate;
    if (!window || !binding || candidate.journalSequence !== undefined) return;
    if (window.frameCount !== binding.frameCount || window.lapNumber !== binding.lapNumber) {
      this.fail(new Error(`Persisted lap ${binding.lapId} disagrees with authoritative ownership`)); return;
    }
    const payload: LiveCaptureWindow = { kind: "window", revision: window.revision, lapId: binding.lapId,
      startByteOffset: candidate.startByteOffset, frameCount: window.frameCount,
      trailingContextFrameCount: window.trailingContextFrameCount };
    const sourceByteEnd = candidate.observationByteEnd ?? this.processedByteEnd;
    candidate.journalSequence = this.addJournal(sourceByteEnd, payload);
    this.control("lap-binding", {
      candidateId: candidate.id, lapId: String(binding.lapId),
      ownershipJournalSequence: candidate.journalSequence, ownershipSourceByteEnd: sourceByteEnd,
    }, 256);
    this.candidates.delete(candidate.startByteOffset);
    this.bindings.delete(candidate.startByteOffset);
  }

  private addJournal(sourceByteEnd: number, payload: unknown): number {
    const byteCost = Buffer.byteLength(JSON.stringify(payload));
    if (this.journalBytes + byteCost > MAX_METADATA_BYTES) throw new Error("Live recovery metadata byte budget exhausted");
    const sequence = ++this.journalSequence;
    this.journal.push({ sequence, sourceByteEnd, payload, byteCost });
    this.journalBytes += byteCost;
    this.schedulePersistence();
    return sequence;
  }

  private control(type: string, payload: Record<string, unknown>, byteCost: number): void {
    this.recorder.postOrderedControl(type, { ...payload, captureEpoch: this.identity.captureEpoch }, byteCost);
  }

  private flushWatermark(): void {
    clearTimeout(this.watermarkTimer ?? undefined);
    this.watermarkTimer = null;
    if (this.failure) return;
    try {
      let sourceByteOffset = this.processedByteEnd;
      for (const candidate of this.candidates.values()) {
        if (candidate.holdForResolution && candidate.preparationOnly) sourceByteOffset = Math.min(sourceByteOffset, candidate.startByteOffset);
      }
      this.control("watermark", { sourceByteOffset }, 128);
    } catch (error) { this.fail(error); }
  }

  private schedulePersistence(): void {
    this.progressDirty = true;
    if (this.persistence || !this.durable || this.failure) return;
    const persistence = (async () => {
      await this.started;
      while (this.progressDirty && !this.failure) {
        this.progressDirty = false;
        const durable = this.durable!;
        if (!durable.fileDev || !durable.fileIno) continue;
        const metadataEnd = Math.min(this.processedByteEnd, durable.sourceByteLength);
        if (this.sourceFileIdentity) {
          if (this.sourceFileIdentity.device !== durable.fileDev || this.sourceFileIdentity.inode !== durable.fileIno) {
            throw new Error("Live capture source identity fence changed");
          }
        } else {
          if (!await bindLiveCaptureSourceIdentity(this.identity, durable.fileDev, durable.fileIno)) throw new Error("Live capture source identity fence changed");
          this.sourceFileIdentity = { device: durable.fileDev, inode: durable.fileIno };
        }
        let count = 0;
        while (count < this.journal.length && this.journal[count]!.sourceByteEnd <= metadataEnd) count++;
        const entries = this.journal.slice(0, count);
        const sequence = entries.at(-1)?.sequence ?? this.persistedJournalSequence;
        if (!await persistLiveCaptureProgress(this.identity, { sequence, sourceByteLength: durable.sourceByteLength,
          sourceRecordCount: durable.sourceRecordCount, sourceDurableWatermark: durable.sourceByteLength, metadataDurableWatermark: metadataEnd }, entries)) throw new Error("Live capture durability fence changed");
        this.persistedJournalSequence = sequence;
        this.journal.splice(0, count);
        for (const entry of entries) this.journalBytes -= entry.byteCost;
      }
    })();
    this.persistence = persistence;
    void persistence.catch((error) => this.fail(error)).finally(() => {
      if (this.persistence === persistence) this.persistence = null;
      if (this.progressDirty && !this.failure) this.schedulePersistence();
    });
  }
  private persistedJournalSequence = 0;

  private readonly onWorkerMessage = (input: unknown): void => {
    if (typeof input !== "object" || input === null || !("type" in input)) return;
    if (input.type === "member-ready") {
      let message: typeof MemberReadySchema.Type;
      try { message = Schema.decodeUnknownSync(MemberReadySchema)(input); }
      catch (error) { this.fail(error); return; }
      if (message.captureEpoch !== this.identity.captureEpoch || message.attempt !== this.identity.attempt) { this.fail(new Error("Live member worker identity mismatch")); return; }
      void this.commitMember(message.candidateId, message.ownershipRevision, message.member, message).catch((error) => {
        this.recorder.worker.postMessage({ type: "commit-result", captureEpoch: this.identity.captureEpoch, candidateId: message.candidateId, accepted: false, error: String(error) });
        this.fail(error);
      });
    } else if (input.type === "candidate-discarded") {
      let message: typeof CandidateDiscardedSchema.Type;
      try { message = Schema.decodeUnknownSync(CandidateDiscardedSchema)(input); }
      catch (error) { this.fail(error); return; }
      if (message.captureEpoch !== this.identity.captureEpoch) { this.fail(new Error("Live candidate discard belongs to another capture epoch")); return; }
      const candidate = [...this.candidates.entries()].find(([, value]) => value.id === message.candidateId);
      if (candidate) {
        this.candidates.delete(candidate[0]);
        this.bindings.delete(candidate[0]);
      }
    } else if (input.type === "live-failed") {
      this.fail(new Error("message" in input ? String(input.message) : "Live splitter failed"));
    } else if (input.type === "live-sealed") {
      this.sealed = true;
      this.sealedResult.resolve();
    }
  };

  private async commitMember(candidateId: string, revision: number, member: LiveArchiveMember, verification: typeof MemberReadySchema.Type): Promise<void> {
    await this.started;
    if (this.failure) throw this.failure;
    const ownershipSourceByteEnd = verification.ownershipSourceByteEnd ?? member.sourceByteEnd;
    await this.waitForDurability(ownershipSourceByteEnd);
    const expected = member.kind === "lap" ? {
      lapId: Number(member.lapId),
      startByteOffset: member.sourceByteStart,
      frameCount: member.ownedFrameCount!,
    } : undefined;
    if (member.kind === "lap" && (verification.ownershipJournalSequence === undefined || verification.ownershipSourceByteEnd === undefined)) {
      throw new Error("Live member lacks durable ownership journal coordinates");
    }
    const accepted = await commitLiveCaptureMember({ identity: this.identity, priorGeneration: member.generation - 1,
      member, verification, ownershipRevision: revision,
      ...(verification.ownershipJournalSequence === undefined ? {} : { ownershipJournalSequence: verification.ownershipJournalSequence }),
      ...(expected ? { expectedWindow: expected } : {}) });
    this.recorder.worker.postMessage({ type: "commit-result", captureEpoch: this.identity.captureEpoch, candidateId, accepted, generation: member.generation });
    if (!accepted) throw new Error("Live member publication fence rejected");
    if (expected) {
      this.readyLaps.add(expected.lapId);
      if (this.readyLaps.size > 500) this.readyLaps.delete(this.readyLaps.values().next().value!);
      this.candidates.delete(member.sourceByteStart);
      this.bindings.delete(member.sourceByteStart);
      this.notify({ type: "lap-capture-ready", sessionId: this.sessionId, lapId: expected.lapId, captureEpoch: this.identity.captureEpoch, generation: member.generation });
    }
  }

  private async waitForDurability(sourceByteEnd: number): Promise<void> {
    if ((this.durable?.sourceByteLength ?? 0) < sourceByteEnd) {
      this.durable = await this.recorder.requestSync();
      if (this.durable.sourceByteLength < sourceByteEnd) throw new Error("Source sync did not cover the published member");
    }
    this.schedulePersistence();
    while (this.persistence) await this.persistence;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closing) { await this.sealedResult.promise; return; }
    this.closing = true;
    const sourceByteEnd = this.recorder.getCurrentByteOffset();
    this.processedByteEnd = this.recorder.recordCount === 0 && sourceByteEnd <= META_FRAME_BYTES ? 0 : sourceByteEnd;
    this.flushWatermark();
    await this.started;
    await setLiveCaptureStatus(this.identity, "finalizing");
    this.notify({ type: "recording-finalizing", sessionId: this.sessionId, captureEpoch: this.identity.captureEpoch });
    await this.waitForDurability(this.processedByteEnd);
    this.control("close-live", { sourceByteOffset: this.processedByteEnd }, 128);
    await this.sealedResult.promise;
    if (!this.sealed) throw new Error("Live capture worker did not seal");
  }

  async sealMetadata(): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.sealed) throw new Error("Cannot seal metadata before live worker completion");
    await this.waitForDurability(this.processedByteEnd);
    await sealLiveCaptureMetadata(this.identity);
    this.metadataSealed = true;
    this.notify({ type: "recording-sealed", sessionId: this.sessionId, captureEpoch: this.identity.captureEpoch });
  }

  fail(reason: unknown): void {
    if (this.failure) return;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    clearTimeout(this.watermarkTimer ?? undefined);
    this.watermarkTimer = null;
    this.sealedResult.reject(this.failure);
    this.notify({ type: "recording-failed", sessionId: this.sessionId, captureEpoch: this.identity.captureEpoch, error: this.failure.message });
    void this.started.then(() => setLiveCaptureStatus(this.identity, "failed", this.failure!.message)).catch((error) => console.error("[LiveCapture] Failed to persist capture failure:", error));
  }

  dispose(): void {
    clearTimeout(this.watermarkTimer ?? undefined);
    this.detachDurability();
    this.detachFailure();
    this.detachActive();
    this.recorder.worker.off("message", this.onWorkerMessage);
  }
}
