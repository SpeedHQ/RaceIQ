export type PacketSourceReference = Buffer | { rawOffset: number };
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { type DbAdapter, type WsAdapter, type SessionRecorderAdapter, RealDbAdapter, SparseSessionRecorderAdapter } from "./pipeline-ports";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import type { ILapDetector, LapDetectorCallbacks } from "../lap-detection/types";
import { isPaceLap } from "@raceiq/shared/racing/lap-classification";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { SectorTracker } from "../live-strategy/sector-tracker";
import { PitTracker } from "../live-strategy/pit-tracker";
import { feedCalibrationPosition, resetLiveCalibration } from "../tracks/calibration";
import { getTrackOutlineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { getTrackBoundariesById } from "@raceiq/game-catalogs/racing/tracks/geometry/extracted";
import type { TrackBoundary } from "@raceiq/shared/racing/tracks/geometry/types";
import { getServerGame } from "../games/registry";
import { normalizeTelemetryPacket } from "@raceiq/telemetry-core/telemetry/normalization";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import { detectLiveIssues } from "../ai/tune-issues";
import { reconcileSessionResult } from "../race-results/reconcile";
import { encodeFrameLength, encodeParserBootstrapFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame } from "@raceiq/capture-formats/session/framing";
import { applyFrameTime } from "../session-capture/frame-time";
import { wsManager } from "../runtime/websocket-manager";
import { withSessionCaptureMaintenanceLock } from "../session-capture/cleanup";
import { enqueueSessionCaptureSplit } from "../db/session-queries";
import { materializeParserInitializationPlan, subscribeParserSource, subscribeParserDriverEvidenceInvalidation, type ParserSourceInput, type ParserReplayLocator } from "../games/packet-dispatch";
import { DirectSessionRecorderAdapter, type DirectCaptureRecording } from "../session-capture/direct-recorder";

import { DashboardCaptureObservation } from "../session-capture/dashboard-observation";
import { markDashboardCaptureCheckpoint, publishObservedDashboardCaptureFacts } from "../session-capture/dashboard-processor";
import { NativeAttributionTracker, NativeBindingCandidateCache, nativeDriverBindings, getNativeSourceClock, nativeDriverEvidenceMaxAgeMs } from "../lap-detection/native-attribution";
import type { DriverActorBinding, NativeDriverActor } from "@raceiq/shared/driver-attribution";
type CaptureObservationEntry = { observation: DashboardCaptureObservation; rawFile: string | null };
type RecordingSession = { sessionId: number; gameId: GameId; directCapture?: DirectCaptureRecording };
type CapturedParserSource = {
  parserSequence: number; epoch: number; locator: ParserReplayLocator | null;
  rawOffset?: number; rawEndOffset?: number; rawOrdinal?: number;
  pendingDirect?: boolean;
  timestampMs?: number;
};
type PendingDirectSource = { input: ParserSourceInput; reference: CapturedParserSource; bytes: number };
const CURRENT_SESSION_LAP_SNAPSHOT_LIMIT = 500;

export class LiveTelemetryPipeline {
  private sectorTracker = new SectorTracker();
  private pitTracker = new PitTracker();
  private _lapDetector: ILapDetector | null = null;
  private _lapDetectorGameId: GameId | null = null;
  private _totalProcessed = 0;
  private db: DbAdapter;
  private ws: WsAdapter;
  private recorder: SessionRecorderAdapter;
  private _bypassPacketRateFilter: boolean;
  private _skipHistorySeeding: boolean;
  private _skipDevState: boolean;
  private projector = new LiveTelemetryProjector();
  private _sessionLaps: LapMeta[] = [];
  /** Live Tuning Dashboard: gates the per-packet transient issue detector.
   *  Off by default — client opts in via `POST /api/live-analysis`. */
  private _liveIssuesEnabled = false;
  private _recordingSession: RecordingSession | null = null;
  /** Retain the paused operation's source after its recorder detaches for durability. */
  private _pausedRecordingSession: RecordingSession | null = null;
  private _dashboardCaptureObservations = new Map<number, CaptureObservationEntry>();
  private _continuingSegment = false;
  private _pendingSessionContextFrames: Buffer[] = [];
  private _expectCompleteLapStart = false;
  private _enqueueSessionCaptureSplits = true;
  private _onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
  private _finalizedResultSessions = new Set<number>();
  private _resultFinalizations = new Map<number, Promise<void>>();
  private _calibrationBoundary: TrackBoundary | null = null;
  private _ingressBarrier: Promise<void> | null = null;
  private _activePacketProcessing = new Set<Promise<void>>();
  private _packetQueue = Promise.resolve();
  private _queuedPacketBytes = 0;
  private _overloadRecovery: Promise<void> | null = null;
  private readonly _parserSourceFrames = new WeakMap<Buffer, CapturedParserSource>();
  private _latestSource: CapturedParserSource | null = null;
  private _pendingDirectSources: Array<PendingDirectSource | undefined> = [];
  private _pendingDirectHead = 0;
  private _pendingDirectBytes = 0;
  private _processingSource: CapturedParserSource | null = null;
  private readonly _retiringCaptures = new Set<Promise<void>>();
  private _processingNativeFrame: Buffer | null = null;
  private _processingTimestamp: number | undefined;
  private _attributionTracker = new NativeAttributionTracker();
  private _attributionSessionId: number | null = null;
  private _driverBindings: DriverActorBinding[] = [];
  private _driverBindingRevision = -1;
  private _bindingReadSequence = 0;
  private _bindingAppliedSequence = 0;
  private _processingDriverBindings: readonly DriverActorBinding[] = [];
  private readonly _nativeBindingCandidates: NativeBindingCandidateCache | null;
  private _processingPacket: TelemetryPacket | null = null;
  private _lastAttributionLap: number | null = null;
  private readonly _completeNativeSources = new Set<number>();
  private readonly _driverEvidenceEpochs = new Map<GameId, number>();
  private _attributionEvidenceEpoch = -1;
  private _originalSourceIntegrityComplete = true;

  /** Native OFF/replay/status suppression breaks proof even when no telemetry packet is emitted. */
  invalidateNativeDriverEvidence(gameId: GameId, timestampMs?: number): void {
    this._driverEvidenceEpochs.set(gameId, (this._driverEvidenceEpochs.get(gameId) ?? 0) + 1);
    this._nativeBindingCandidates?.invalidate(gameId, timestampMs);
    if (this._lapDetectorGameId === gameId) this._attributionTracker.sourceComplete = false;
  }

  private async _readDriverBindings(actor?: NativeDriverActor | null): Promise<DriverActorBinding[]> {
    const sequence = ++this._bindingReadSequence;
    const snapshot = await this.db.getDriverBindings(actor);
    const bindings = snapshot.revision === this._driverBindingRevision
      ? this._driverBindings : nativeDriverBindings(snapshot.bindings);
    if (sequence >= this._bindingAppliedSequence) {
      this._bindingAppliedSequence = sequence;
      this._driverBindings = bindings;
      this._driverBindingRevision = snapshot.revision;
      this._nativeBindingCandidates?.updateBindings(snapshot);
    }
    return bindings;
  }

  async refreshNativeDriverBindings(): Promise<void> {
    await this._readDriverBindings();
  }

  private async _closeNativeAttribution(): Promise<void> {
    const sessionId = this._attributionSessionId;
    if (sessionId === null) return;
    await this.db.setSessionDriverAttribution(sessionId, this._attributionTracker.stints);
    if (this.db instanceof RealDbAdapter) {
      try { await this.db.drainLapWrites(sessionId); }
      catch (error) {
        this._originalSourceIntegrityComplete = false;
        console.error(`[NativeAttribution] Incomplete source ${sessionId}:`, error);
        this.ws.broadcastNotification({ type: "recording-failed", sessionId,
          error: "Native capture could not be fully saved; original activity remains incomplete" });
      }
    }
    const observation = this._dashboardCaptureObservations.get(sessionId)?.observation;
    if (this.db instanceof RealDbAdapter && observation) {
      const capture = this._recordingSession?.sessionId === sessionId
        ? this._recordingSession.directCapture : this._retiringSessions.get(sessionId)?.directCapture;
      // Recorded native originals retain the manifest's actual revision. A
      // recording-off original has only its observed native packet-pass revision.
      this.db.setOriginalActivitySourceRevision(sessionId, capture?.sourceRevision ?? observation.toFacts().captureRevision);
    }
    if (this._originalSourceIntegrityComplete && observation) {
      // Recording can stop while native detection continues. Its earlier file close
      // cannot complete the original, but a later genuine detector close can.
      if (this._finalizedResultSessions.has(sessionId)) await this.db.finalizeOriginalActivitySource(sessionId);
      else this._completeNativeSources.add(sessionId);
    } else if (this.db instanceof RealDbAdapter) {
      this.db.releaseSessionSourceTracking(sessionId);
    }
    this._attributionSessionId = null;
    this._attributionTracker = new NativeAttributionTracker();
    this._lastAttributionLap = null;
    this._attributionEvidenceEpoch = -1;
    this._originalSourceIntegrityComplete = true;
  }

  /** Expose the current lap detector for external readers (routes, UDP handler). */
  get lapDetector(): ILapDetector | null {
    return this._lapDetector;
  }

  /** Whether the live transient issue detector is currently active. */
  get liveIssuesEnabled(): boolean {
    return this._liveIssuesEnabled;
  }

  /** Toggled by `POST /api/live-analysis {enabled}`. */
  setLiveIssuesEnabled(enabled: boolean): void {
    this._liveIssuesEnabled = enabled;
  }

  /** Maintenance stays excluded until active and retiring capture I/O has finished. */
  get isSessionActive(): boolean {
    return this.recorder.active || this._recordingSession?.directCapture !== undefined ||
      this._retiringSessions.size > 0 || this._retiringCaptures.size > 0;
  }

  /** In-memory session laps — sent to newly connected WS clients. */
  get sessionLaps(): readonly LapMeta[] {
    return this._sessionLaps;
  }

  constructor(
    db: DbAdapter,
    ws: WsAdapter,
    options?: {
      bypassPacketRateFilter?: boolean;
      skipHistorySeeding?: boolean;
      skipDevState?: boolean;
      recorder?: SessionRecorderAdapter;
      enqueueSessionCaptureSplits?: boolean;
      nativeBindingCandidates?: NativeBindingCandidateCache;
      onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
    },
  ) {
    this.db = db;
    this.ws = ws;
    this._nativeBindingCandidates = options?.nativeBindingCandidates ?? null;
    this.recorder = options?.recorder ?? (db instanceof RealDbAdapter
      ? new DirectSessionRecorderAdapter()
      : new SparseSessionRecorderAdapter("mine", {}, "offline"));
    this._bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
    this._skipHistorySeeding = options?.skipHistorySeeding ?? false;
    this._skipDevState = options?.skipDevState ?? false;
    this._enqueueSessionCaptureSplits = options?.enqueueSessionCaptureSplits ?? true;
    this._onSessionFinalized = options?.onSessionFinalized;
    if (db instanceof RealDbAdapter) {
      db.subscribeLapBindings((binding) => {
        if (binding.sessionId === this._recordingSession?.sessionId) this._recordingSession.directCapture?.bindLap(binding);
        else this._retiringSessions.get(binding.sessionId)?.directCapture?.bindLap(binding);
      });
      db.subscribeLapWriteFailures((sessionId, error) => {
        const session = sessionId === this._recordingSession?.sessionId ? this._recordingSession : this._retiringSessions.get(sessionId);
        session?.directCapture?.fail(error);
      });
      db.subscribeLapInvalidations((lapId) => {
        this._recordingSession?.directCapture?.invalidateLap(lapId);
        for (const session of this._retiringSessions.values()) session.directCapture?.invalidateLap(lapId);
        const index = this._sessionLaps.findIndex((lap) => lap.id === lapId);
        if (index >= 0) {
          this._sessionLaps.splice(index, 1);
          this._broadcastSessionLaps();
        }
      });
    }
  }

  /** Capture recognized native input before parsing, including parser-null records. */
  captureParserSource(input: ParserSourceInput): void {
    if (this._overloadRecovery) return;
    this._nativeBindingCandidates?.observeRawSource(input.gameId, input.frame, input.timestampMs);
    const reference: CapturedParserSource = { parserSequence: input.sequence, epoch: this.recorder.epoch, locator: input.locator, timestampMs: input.timestampMs };
    this._parserSourceFrames.set(input.frame, reference);
    if (this.recorder instanceof DirectSessionRecorderAdapter && this.recorder.active && !this._recordingSession?.directCapture?.hasFailed) {
      const bytes = input.frame.byteLength + (input.locator?.byteCost ?? 0) + 128;
      if (this._pendingDirectBytes + bytes > 8 * 1024 * 1024 || this._pendingDirectSources.length - this._pendingDirectHead >= 1024) {
        const error = new Error("Direct recording source queue capacity exhausted");
        this._originalSourceIntegrityComplete = false;
        this._recordingSession?.directCapture?.fail(error);
        return;
      }
      reference.pendingDirect = true;
      this._pendingDirectSources.push({ input, reference, bytes });
      this._pendingDirectBytes += bytes;
      try {
        if (this._activePacketProcessing.size === 0 && !this._ingressBarrier) this._flushDirectSourcesThrough(reference);
      } catch (error) {
        this._originalSourceIntegrityComplete = false;
        this._recordingSession?.directCapture?.fail(error);
      }
      return;
    }
    if (!this.recorder.active || this._recordingSession?.gameId !== input.gameId || this._recordingSession.directCapture?.hasFailed) return;
    try {
      reference.rawOffset = this.recorder.getCurrentByteOffset();
      this.recorder.writeRecord(input.frame, input.timestampMs);
      reference.rawEndOffset = this.recorder.getCurrentByteOffset();
      if (this.recorder instanceof SparseSessionRecorderAdapter) {
        reference.rawOrdinal = this.recorder.sourceOrdinal;
      }
      this._latestSource = reference;
    } catch (error) {
      this._originalSourceIntegrityComplete = false;
      this._recordingSession?.directCapture?.fail(error);
      this.ws.broadcastNotification({
        type: "recording-failed",
        sessionId: this._recordingSession?.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private _consumeDirectSource(): PendingDirectSource {
    const pending = this._pendingDirectSources[this._pendingDirectHead]!;
    this._pendingDirectSources[this._pendingDirectHead++] = undefined;
    this._pendingDirectBytes -= pending.bytes;
    if (this._pendingDirectHead === this._pendingDirectSources.length) {
      this._pendingDirectSources.length = 0;
      this._pendingDirectHead = 0;
    } else if (this._pendingDirectHead >= 256 && this._pendingDirectHead * 2 >= this._pendingDirectSources.length) {
      this._pendingDirectSources.splice(0, this._pendingDirectHead);
      this._pendingDirectHead = 0;
    }
    return pending;
  }

  /** Keep future native input behind the current detector decision, not behind disk I/O. */
  private _flushDirectSourcesThrough(target?: CapturedParserSource): void {
    if (!(this.recorder instanceof DirectSessionRecorderAdapter) || !this.recorder.active || (target && !target.pendingDirect)) return;
    while (this._pendingDirectHead < this._pendingDirectSources.length) {
      const next = this._pendingDirectSources[this._pendingDirectHead]!;
      if (next.reference.pendingDirect && next.input.gameId !== this._recordingSession?.gameId) break;
      const { input, reference } = this._consumeDirectSource();
      if (reference.pendingDirect) {
        reference.pendingDirect = false;
        reference.epoch = this.recorder.epoch;
        reference.rawOffset = this.recorder.getCurrentByteOffset();
        this.recorder.writeRecord(input.frame, input.timestampMs);
        reference.rawEndOffset = this.recorder.getCurrentByteOffset();
        reference.rawOrdinal = this.recorder.sourceOrdinal;
        this._latestSource = reference;
      }
      if (reference === target) break;
    }
  }

  /** A newly started capture's original parser primer already represents these inputs. */
  private _discardDirectSourcesThrough(target: CapturedParserSource): void {
    if (!target.pendingDirect) return;
    while (this._pendingDirectHead < this._pendingDirectSources.length) {
      const { reference } = this._consumeDirectSource();
      reference.pendingDirect = false;
      if (reference === target) break;
    }
  }

  private async _withIngressPaused<T>(operation: () => Promise<T>): Promise<T> {
    while (this._ingressBarrier) await this._ingressBarrier;

    let releaseIngress!: () => void;
    const ingressBarrier = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    this._ingressBarrier = ingressBarrier;
    try {
      await Promise.allSettled([...this._activePacketProcessing]);
      this._pausedRecordingSession = this._recordingSession;
      return await operation();
    } finally {
      this._pausedRecordingSession = null;
      if (this._ingressBarrier === ingressBarrier) this._ingressBarrier = null;
      releaseIngress();
    }
  }

  private _reconcileRecordedSession(session: RecordingSession): Promise<void> {
    if (this._finalizedResultSessions.has(session.sessionId)) {
      return Promise.resolve();
    }
    const pending = this._resultFinalizations.get(session.sessionId);
    if (pending) return pending;
    const finalization = (async () => {
      try {
        if (this._enqueueSessionCaptureSplits && !session.directCapture) {
          await enqueueSessionCaptureSplit(session.sessionId);
        }
      } catch (error) {
        console.error(`[CaptureSplit] Failed to enqueue closed session ${session.sessionId}:`, error);
      }
      if (this._completeNativeSources.has(session.sessionId)) {
        await this.db.finalizeOriginalActivitySource(session.sessionId);
        this._completeNativeSources.delete(session.sessionId);
      }
      await this._onSessionFinalized?.(session.sessionId, session.gameId);
      this._finalizedResultSessions.add(session.sessionId);
    })();
    this._resultFinalizations.set(session.sessionId, finalization);
    void finalization
      .finally(() => {
        if (this._resultFinalizations.get(session.sessionId) === finalization) {
          this._resultFinalizations.delete(session.sessionId);
        }
      })
      .catch(() => {});
    return finalization;
  }

  private async _finishRecordedSession(session = this._recordingSession): Promise<void> {
    if (!session?.directCapture) {
      await withSessionCaptureMaintenanceLock(async () => {
        if (session && this._recordingSession?.sessionId === session.sessionId) this._recordingSession = null;
        await this.recorder.stop();
      });
    } else {
      this._flushDirectSourcesThrough();
      this._drainOwnership(session);
      if (!(this.recorder instanceof DirectSessionRecorderAdapter)) throw new Error("Direct capture lost its recorder");
      const source = this.recorder.detachCapture();
      this._recordingSession = null;
      if (source) {
        this._retiringSessions.set(session.sessionId, session);
        try { await this._finishDirectCapture(session, source); }
        finally { this._retiringSessions.delete(session.sessionId); }
      }
    }
    if (session) {
      await this.finalizeDashboardCaptureFacts([session.sessionId]);
      await this._reconcileRecordedSession(session);
    }
  }

  private readonly _retiringSessions = new Map<number, RecordingSession>();

  private _drainOwnership(session = this._recordingSession): void {
    const transitions = this._lapDetector?.drainOwnershipTransitions?.() ?? [];
    const source = this._processingSource;
    session?.directCapture?.processTransitions(transitions, source?.locator ?? null);
  }

  private async _finishDirectCapture(session: RecordingSession, capture: DirectCaptureRecording): Promise<void> {
    try {
      if (this.db instanceof RealDbAdapter) await this.db.drainLapWrites(session.sessionId);
      await capture.stop();
    } catch (error) {
      this._completeNativeSources.delete(session.sessionId);
      if (this.db instanceof RealDbAdapter) this.db.releaseSessionSourceTracking(session.sessionId);
      capture.fail(error);
      await capture.stop().catch((failure) => console.error("[DirectCapture] Failed to drain capture:", failure));
      throw error;
    }
  }

  private _writeProcessingTrigger(): void {
    const frame = this._processingNativeFrame;
    if (!frame || !this.recorder.active) return;
    const captured = this._parserSourceFrames.get(frame);
    if (captured?.epoch === this.recorder.epoch && captured.rawOffset !== undefined) return;
    for (const context of this._pendingSessionContextFrames) this.recorder.writeRawCaptureBytes(context);
    this._pendingSessionContextFrames = [];
    if (captured?.locator && this.recorder instanceof SparseSessionRecorderAdapter && this.recorder.sourceOrdinal === undefined) {
      const plan = materializeParserInitializationPlan(captured.locator);
      if (!plan) throw new Error("Canonical parser initialization exceeded retained source history");
      if (plan.anchorPayload.byteLength > 0) {
        const gameId = this._recordingSession!.gameId;
        this.recorder.writeRawCaptureBytes(encodeParserBootstrapFrame(gameId, plan.anchorPayload));
        if (plan.precedingRecords.length > 0) {
          this.recorder.writeRawCaptureBytes(encodeSegmentContextFrame());
          for (const preceding of plan.precedingRecords) {
            this.recorder.writeRawCaptureBytes(Buffer.concat([encodeFrameLength(preceding.frame.length, preceding.timestampMs), preceding.frame]));
          }
          this.recorder.writeRawCaptureBytes(encodeSegmentContextEndFrame());
        }
      }
    }
    const reference: CapturedParserSource = captured ?? { parserSequence: -1, epoch: this.recorder.epoch, locator: null };
    if (this.recorder instanceof DirectSessionRecorderAdapter) this._discardDirectSourcesThrough(reference);
    reference.epoch = this.recorder.epoch;
    reference.rawOffset = this.recorder.getCurrentByteOffset();
    this.recorder.writeRecord(frame, this._processingTimestamp);
    reference.rawEndOffset = this.recorder.getCurrentByteOffset();
    if (this.recorder instanceof SparseSessionRecorderAdapter) reference.rawOrdinal = this.recorder.sourceOrdinal;
    this._parserSourceFrames.set(frame, reference);
    this._processingSource = reference;
    this._latestSource = reference;
    this._lapDetector?.setCurrentLapByteOffset?.(reference.rawOffset, reference.rawOrdinal);
    if (reference.rawOrdinal !== undefined) this._lapDetector?.observeSourceRecord?.(reference.rawOffset, reference.rawEndOffset, reference.rawOrdinal);
  }

  private _observeSourceTail(): void {
    this._flushDirectSourcesThrough();
    const source = this._latestSource;
    if (source?.epoch === this.recorder.epoch && source.rawOffset !== undefined && source.rawEndOffset !== undefined && source.rawOrdinal !== undefined) {
      this._processingSource = source;
      this._lapDetector?.observeSourceRecord?.(source.rawOffset, source.rawEndOffset, source.rawOrdinal);
    }
  }

  private _observeDashboardPacket(
    sessionId: number | undefined,
    packet: TelemetryPacket,
    source: PacketSourceReference | undefined,
    frameTimeMs?: number,
  ): void {
    if (sessionId === undefined) return;
    const entry = this._dashboardCaptureObservations.get(sessionId);
    if (entry) {
      const clock = getNativeSourceClock(packet, frameTimeMs);
      entry.observation.observe(packet, source, frameTimeMs, clock ? {
        sessionId: clock.sessionId, clockDomain: clock.domain, sourceTimeMs: clock.atMs,
        stints: this._attributionTracker.stints,
      } : undefined);
    }
  }

  /** Persist packet-pass facts only after raw capture is closed and source revision checkpointed. */
  async finalizeDashboardCaptureFacts(sessionIds?: readonly number[]): Promise<void> {
    const requested = new Set(sessionIds ?? this._dashboardCaptureObservations.keys());
    const selected = new Set<number>();
    for (const id of requested) {
      const entry = this._dashboardCaptureObservations.get(id);
      if (!entry) {
        selected.add(id);
        continue;
      }
      for (const [otherId, other] of this._dashboardCaptureObservations) {
        if (entry.rawFile !== null && other.rawFile === entry.rawFile) selected.add(otherId);
      }
      selected.add(id);
    }

    const groups = new Map<string, number[]>();
    for (const id of selected) {
      const entry = this._dashboardCaptureObservations.get(id);
      const key = entry?.rawFile ? `file:${entry.rawFile}` : `session:${id}`;
      const group = groups.get(key);
      if (group) group.push(id);
      else groups.set(key, [id]);
    }

    for (const ids of groups.values()) {
      const checkpointId = ids[0]!;
      await markDashboardCaptureCheckpoint(checkpointId, false);
      let complete = true;
      for (const id of ids) {
        const entry = this._dashboardCaptureObservations.get(id);
        if (!entry) {
          complete = false;
          continue;
        }
        try {
          const published = await publishObservedDashboardCaptureFacts(id, entry.observation.toFacts());
          complete = complete && published;
        } catch (error) {
          complete = false;
          console.error(`[DashboardProcessor] Packet-pass publication failed for session ${id}:`, error);
        }
      }
      if (!complete) await markDashboardCaptureCheckpoint(checkpointId, true);
      for (const id of ids) this._dashboardCaptureObservations.delete(id);
    }
  }

  private _buildCallbacks(): LapDetectorCallbacks {
    return {
      onSessionStart: async (session) => {
        if (this._attributionSessionId !== null && this._attributionSessionId !== session.sessionId) {
          await this._closeNativeAttribution();
          if (this._processingPacket) this._attributionTracker.observe(this._processingPacket, this._processingDriverBindings, this._processingTimestamp);
        }
        this._attributionSessionId = session.sessionId;
        const previousSession = this._recordingSession;
        const previousCapture = previousSession
          ? this._dashboardCaptureObservations.get(previousSession.sessionId) ?? null
          : null;
        if (previousSession && previousSession.sessionId !== session.sessionId) {
          previousCapture?.observation.finishSegment();
        }
        const continuing = this._continuingSegment && previousSession?.sessionId === session.sessionId && previousSession.gameId === session.gameId;
        this._continuingSegment = false;
        if (!continuing) {
          if (previousSession?.directCapture && this.recorder instanceof DirectSessionRecorderAdapter) {
            while (this._retiringCaptures.size >= 2) {
              const oldestRetirement = this._retiringCaptures.values().next().value;
              if (!oldestRetirement) break;
              await oldestRetirement;
            }
          }
          await withSessionCaptureMaintenanceLock(async () => {
            if (previousSession?.directCapture && this.recorder instanceof DirectSessionRecorderAdapter) {
              if (this._retiringCaptures.size >= 2) throw new Error("Direct recording finalization budget exhausted");
              this._drainOwnership(previousSession);
              const source = this.recorder.detachCapture();
              if (source) {
                this._retiringSessions.set(previousSession.sessionId, previousSession);
                const retirement = this._finishDirectCapture(previousSession, source).then(async () => {
                  await this.finalizeDashboardCaptureFacts([previousSession.sessionId]);
                  await this._reconcileRecordedSession(previousSession);
                });
                this._retiringCaptures.add(retirement);
                void retirement.catch((error) => console.error("[DirectCapture] Retired capture failed:", error));
                void retirement.finally(() => {
                  this._retiringCaptures.delete(retirement);
                  this._retiringSessions.delete(previousSession.sessionId);
                }).catch(() => {});
              }
            } else await this.recorder.stop();
            this._recordingSession = null;
            this.recorder.start(session.gameId);
            this.recorder.writeMetaFrame();
            const recording: RecordingSession = { sessionId: session.sessionId, gameId: session.gameId };
            this._recordingSession = recording;
            const rawFile = this.recorder.path;
            this._dashboardCaptureObservations.set(session.sessionId, {
              observation: new DashboardCaptureObservation(session.gameId, session.trackId ?? null), rawFile,
            });
            if (rawFile) {
              const registration = this.db.updateSessionRawFile(
                session.sessionId, rawFile, this._lapDetector?.detectorId ?? LAP_DETECTOR_ID,
                this.recorder instanceof SparseSessionRecorderAdapter,
              );
              if (this.db instanceof RealDbAdapter && this.recorder instanceof DirectSessionRecorderAdapter && this.recorder.capture) {
                recording.directCapture = this.recorder.capture;
                recording.directCapture.attachSession(session.sessionId, registration,
                  (event) => {
                    this.ws.broadcastNotification(event);
                    if (event.type === "lap-capture-ready") {
                      const lap = this._sessionLaps.find((entry) => entry.id === event.lapId && entry.sessionId === event.sessionId);
                      if (lap) { lap.standaloneCaptureReady = true; this._broadcastSessionLaps(); }
                    }
                  });
              }
              this._writeProcessingTrigger();
              await registration;
              await recording.directCapture?.ready;
              await markDashboardCaptureCheckpoint(session.sessionId, false);
            }
          });
          if (previousSession && !previousSession.directCapture) {
            if (previousCapture && previousCapture.rawFile !== this.recorder.path) {
              await this.finalizeDashboardCaptureFacts([previousSession.sessionId]);
            }
            void this._reconcileRecordedSession(previousSession).catch((error) => {
              console.error(`[Race Results] Failed to reconcile session ${previousSession.sessionId}:`, error);
            });
          }
        }

        const trackIdentity = session.trackId;
        const carIdentity = session.carId;
        resetLiveCalibration(trackIdentity);
        this._calibrationBoundary = getTrackBoundariesById(trackIdentity, session.gameId);

        await this.sectorTracker.reset(trackIdentity, session.gameId, carIdentity);
        this.pitTracker.reset();
        const adapter = getServerGame(session.gameId);
        this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
        this.pitTracker.setTireWearAvailable(resolveAnalysisTelemetry(adapter).tireWearRate.source !== "unavailable");
        if (!this._skipHistorySeeding) {
          await this.pitTracker.seedFromHistory(trackIdentity, carIdentity, session.carPI, session.gameId, adapter.runtime.pit);
          await this._seedSessionLaps(session.sessionId, session.gameId);
        } else {
          this._sessionLaps = [];
        }
        this._broadcastSessionLaps();
      },

      onLapComplete: (event) => {
        if (event.isValid && isPaceLap(event.classification)) {
          this.sectorTracker.updateRefLap(event.packets, event.lapTime, event.sectors);
        }
        if (event.isValid) {
          // Update distance-based wear curves when enabled by the adapter.
          const session = this._lapDetector?.session ?? null;
          if (session && getServerGame(session.gameId).runtime.pit.useDistanceBasedWearCurves) {
            this.pitTracker.updateWearCurves(event.packets, event.lapDistStart);
          }
        }
      },

      onLapSaved: (event) => {
        this.ws.broadcastNotification({ type: "lap-saved", ...event });

        // Only populate the active session snapshot with laps owned by that session.
        const recording = this._recordingSession;
        if (!recording || recording.sessionId !== event.sessionId) return;
        const session = this._lapDetector?.session ?? null;
        if (!session || session.sessionId !== event.sessionId) return;
        this._sessionLaps.push({
          id: event.lapId,
          sessionId: event.sessionId,
          lapNumber: event.lapNumber,
          lapTime: event.lapTime,
          isValid: event.isValid,
          classification: event.classification,
          createdAt: new Date().toISOString(),
          gameId: session.gameId,
          carId: session.carId,
          trackId: session.trackId,
          sectorTimes: event.sectors ?? undefined,
          standaloneCaptureReady: recording.directCapture?.isLapReady(event.lapId),
        });
        if (this._sessionLaps.length > CURRENT_SESSION_LAP_SNAPSHOT_LIMIT) {
          this._sessionLaps.splice(0, this._sessionLaps.length - CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
        }
        this._broadcastSessionLaps();
      },
    };
  }

  private _getOrCreateDetector(gameId: GameId): ILapDetector {
    // Create a fresh detector if none exists, or if the game changed
    if (this._lapDetector === null || this._lapDetectorGameId !== gameId) {
      const serverAdapter = getServerGame(gameId);
      this._lapDetector = serverAdapter.createLapDetector({
        db: this.db,
        bypassPacketRateFilter: this._bypassPacketRateFilter,
        callbacks: this._buildCallbacks(),
      });
      this._lapDetectorGameId = gameId;
      if (this._expectCompleteLapStart) {
        this._lapDetector.expectCompleteLapStart?.();
        this._expectCompleteLapStart = false;
      }
    }
    return this._lapDetector;
  }

  /**
   * Flush any in-progress lap at end-of-stream as an invalid incomplete lap.
   * Called when the recording ends or a session terminates.
   */
  async flushIncompleteLap(): Promise<void> {
    await this._withIngressPaused(async () => {
      this._observeSourceTail();
      await this._lapDetector?.flushIncompleteLap?.();
      this._drainOwnership();
    });
  }
  /** Persist a replaceable snapshot without ending the active session. */
  async snapshotIncompleteLap(): Promise<void> {
    await this._withIngressPaused(async () => {
      this._observeSourceTail();
      await this._lapDetector?.snapshotIncompleteLap?.();
      this._drainOwnership();
    });
  }

  /** Finalize detector, durable capture, then authoritative session result. */
  async finalizeCurrentSession(): Promise<void> {
    await this._withIngressPaused(() => this._finalizeCurrentSession());
  }

  private async _finalizeCurrentSession(): Promise<void> {
    const session = this._recordingSession;
    this._observeSourceTail();
    await this._lapDetector?.finalizeCurrentSession?.();
    await this._closeNativeAttribution();
    await this._finishRecordedSession(session);
    await Promise.all(this._retiringCaptures);
  }

  /** Detect game-specific stale finalization and finish its durable capture. */
  async flushStaleSession(): Promise<void> {
    await this._withIngressPaused(async () => {
      const session = this._recordingSession;
      this._observeSourceTail();
      await this._lapDetector?.flushStaleLap?.();
      if (!this._lapDetector?.session) await this._closeNativeAttribution();
      this._drainOwnership();
      if (session && !this._lapDetector?.session) {
        await this._finishRecordedSession(session);
      }
    });
  }
  /** Seed in-memory session laps from DB (called once on session start). */
  private async _seedSessionLaps(sessionId: number, gameId: GameId): Promise<void> {
    try {
      const allLaps = await this.db.getLaps(gameId, CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
      const sessionLaps = allLaps.filter((l) => l.sessionId === sessionId).sort((a, b) => a.id - b.id);
      if (sessionLaps.length > CURRENT_SESSION_LAP_SNAPSHOT_LIMIT) {
        sessionLaps.splice(0, sessionLaps.length - CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
      }
      this._sessionLaps = sessionLaps;
    } catch {
      this._sessionLaps = [];
    }
  }

  /** Push in-memory session laps to all WS clients. */
  private _broadcastSessionLaps(): void {
    this.ws.broadcastNotification({ type: "session-laps", laps: this._sessionLaps });
  }

  private _recoverDetectorOverload(): Promise<void> {
    if (this._overloadRecovery) return this._overloadRecovery;
    const error = new Error("Recording detector queue capacity exhausted");
    const interruptedSession = this._ingressBarrier && !this._pausedRecordingSession?.directCapture?.isSealed
      ? this._pausedRecordingSession : null;
    // An already-running close must not attest input stranded behind its barrier.
    if (this._ingressBarrier) {
      this._originalSourceIntegrityComplete = false;
      this._attributionTracker.invalidate();
      if (interruptedSession) {
        this._completeNativeSources.delete(interruptedSession.sessionId);
        interruptedSession.directCapture?.fail(error);
      }
    }
    this._overloadRecovery = this._withIngressPaused(async () => {
      // Drain the admitted prefix first: it may have crossed session boundaries.
      // The gap belongs to the session at that prefix's tail, not its head.
      const session = this._recordingSession ?? interruptedSession;
      this._originalSourceIntegrityComplete = false;
      this._attributionTracker.invalidate();
      if (this._lapDetectorGameId) this.invalidateNativeDriverEvidence(this._lapDetectorGameId);
      if (session?.directCapture && !session.directCapture.hasFailed) session.directCapture.fail(error);
      else if (session?.directCapture?.error !== error) {
        this.ws.broadcastNotification({ type: "recording-failed", sessionId: session?.sessionId, error: error.message });
      }
      try {
        await this._finalizeCurrentSession();
      } catch (failure) {
        if (failure !== error) console.error("[Live Telemetry] Overloaded capture finalization failed:", failure);
      } finally {
        // A failed recorder still has to close its handles before fresh capture.
        if (this._recordingSession) {
          try { await this._finishRecordedSession(); }
          catch (failure) {
            if (failure !== error) console.error("[Live Telemetry] Overloaded capture closure failed:", failure);
          }
        }
        if (session) {
          this._completeNativeSources.delete(session.sessionId);
          if (this.db instanceof RealDbAdapter) this.db.releaseSessionSourceTracking(session.sessionId);
          try { await this.finalizeDashboardCaptureFacts([session.sessionId]); }
          catch (failure) { console.error("[Live Telemetry] Overloaded capture checkpoint failed:", failure); }
        }
        this._lapDetector = null;
        this._lapDetectorGameId = null;
        this._attributionSessionId = null;
        this._attributionTracker = new NativeAttributionTracker();
        this._lastAttributionLap = null;
        this._attributionEvidenceEpoch = -1;
        this._originalSourceIntegrityComplete = true;
        this._latestSource = null;
        this._pendingSessionContextFrames = [];
        this._expectCompleteLapStart = false;
        while (this._pendingDirectHead < this._pendingDirectSources.length) {
          this._consumeDirectSource().reference.pendingDirect = false;
        }
      }
    }).catch((failure) => {
      console.error("[Live Telemetry] Detector overload recovery failed:", failure);
    }).finally(() => {
      this._overloadRecovery = null;
    });
    return this._overloadRecovery;
  }

  /**
   * Shared telemetry processing pipeline used by every telemetry source.
   *
   * Capture and tracking stay full-rate; WebSocket publication has its own cadence.
   * Stages: record sourceFrame → optional native dev copy → normalize → detector/sector/pit/BestLap → project → publish.
   */
  async processPacket(packet: TelemetryPacket, source?: PacketSourceReference, frameTimeMs?: number): Promise<void> {
    if (this._overloadRecovery) return;
    frameTimeMs ??= Buffer.isBuffer(source) ? this._parserSourceFrames.get(source)?.timestampMs : undefined;
    this._nativeBindingCandidates?.observeSource(packet, getNativeSourceClock(packet, frameTimeMs), frameTimeMs);
    const evidenceEpoch = this._driverEvidenceEpochs.get(packet.gameId) ?? 0;
    // Queued historical frames must not inherit a later user confirmation.
    const bindingsAtIngress = this._driverBindingRevision >= 0 && (this._ingressBarrier ||
      this._queuedPacketBytes > 0 || (this._lapDetectorGameId && this._lapDetectorGameId !== packet.gameId))
      ? this._driverBindings : undefined;
    const reservedBytes = 16 * 1024 + (Buffer.isBuffer(source) ? source.length + (this._parserSourceFrames.get(source)?.locator?.byteCost ?? 0) : 0);
    if (this._queuedPacketBytes + reservedBytes > 8 * 1024 * 1024) {
      await this._recoverDetectorOverload();
      return;
    }
    // Waiting for lifecycle operations consumes the same budget as detector work.
    this._queuedPacketBytes += reservedBytes;
    try {
      while (this._ingressBarrier) await this._ingressBarrier;
      if (this._overloadRecovery) return;
      const previous = this._packetQueue;
      let release!: () => void;
      this._packetQueue = new Promise<void>((resolve) => { release = resolve; });
      const processing = (async () => {
        await previous;
        try {
          await this._processPacket(packet, source, frameTimeMs, evidenceEpoch, bindingsAtIngress);
        } catch (error) {
          this._recordingSession?.directCapture?.fail(error);
          this._originalSourceIntegrityComplete = false;
          this._attributionTracker.invalidate();
          throw error;
        } finally {
          this._processingNativeFrame = null;
          this._processingSource = null;
          this._processingTimestamp = undefined;
          this._processingPacket = null;
          release();
        }
      })();
      this._activePacketProcessing.add(processing);
      try {
        await processing;
      } finally {
        this._activePacketProcessing.delete(processing);
        if (this._activePacketProcessing.size === 0 && !this._ingressBarrier) this._flushDirectSourcesThrough();
      }
    } finally {
      this._queuedPacketBytes -= reservedBytes;
    }
  }

  private async _processPacket(packet: TelemetryPacket, source: PacketSourceReference | undefined, frameTimeMs?: number,
    evidenceEpoch = 0, bindingsAtIngress?: readonly DriverActorBinding[]): Promise<void> {
    frameTimeMs ??= Buffer.isBuffer(source) ? this._parserSourceFrames.get(source)?.timestampMs : undefined;
    applyFrameTime(packet, frameTimeMs);
    this._totalProcessed++;
    if (this._lapDetector && this._lapDetectorGameId !== packet.gameId) {
      this._observeSourceTail();
      await this._lapDetector.finalizeCurrentSession?.();
      await this._closeNativeAttribution();
      this._drainOwnership();
    }
    const detector = this._getOrCreateDetector(packet.gameId);
    this._processingNativeFrame = Buffer.isBuffer(source) ? source : null;
    this._processingTimestamp = frameTimeMs;
    this._processingSource = Buffer.isBuffer(source) ? this._parserSourceFrames.get(source) ?? null : null;
    this._processingPacket = packet;
    const clock = getNativeSourceClock(packet, frameTimeMs);
    const actor = packet.driverActor;
    const freshActor = packet.IsRaceOn === 1 && actor && actor.gameId === packet.gameId && clock && actor.clockDomain === clock.domain && actor.sessionId === clock.sessionId &&
      Number.isFinite(actor.observedAtMs) && actor.observedAtMs <= clock.atMs &&
      clock.atMs - actor.observedAtMs <= nativeDriverEvidenceMaxAgeMs(packet.gameId) &&
      (actor.evidenceExpiresAtMs === undefined || clock.atMs <= actor.evidenceExpiresAtMs)
      ? actor : null;
    const bindings = await this._readDriverBindings(freshActor);
    const automaticNativeRole = bindings.some((binding) => binding.gameId === packet.gameId &&
      binding.snapshot?.confirmation === "native_verified" && (binding.source === "ac-evo-shared-memory" ||
        binding.source === "lmu-shared-memory-player-scoring" || binding.source === "f1-2025-udp-local-controller"));
    this._processingDriverBindings = bindingsAtIngress && !automaticNativeRole ? bindingsAtIngress : bindings;
    if (this._attributionEvidenceEpoch !== -1 && this._attributionEvidenceEpoch !== evidenceEpoch) this._attributionTracker.invalidate();
    this._attributionEvidenceEpoch = evidenceEpoch;
    this._attributionTracker.observe(packet, this._processingDriverBindings, frameTimeMs);
    if (this._processingSource) this._flushDirectSourcesThrough(this._processingSource);

    let rawByteOffset: number | undefined;
    const epochBefore = this.recorder.epoch;
    if (source && this.recorder.active && !this._recordingSession?.directCapture?.hasFailed &&
        (!(this.recorder instanceof DirectSessionRecorderAdapter) || this._recordingSession?.gameId === packet.gameId)) {
      if (Buffer.isBuffer(source)) {
        const captured = this._parserSourceFrames.get(source);
        if (captured?.epoch === epochBefore && captured.rawOffset !== undefined) {
          rawByteOffset = captured.rawOffset;
        } else {
          rawByteOffset = this.recorder.getCurrentByteOffset();
          this.recorder.writeRecord(source, frameTimeMs);
          const reference: CapturedParserSource = captured ?? { parserSequence: -1, epoch: epochBefore, locator: null };
          reference.epoch = epochBefore;
          reference.rawOffset = rawByteOffset;
          reference.rawEndOffset = this.recorder.getCurrentByteOffset();
          reference.rawOrdinal = this.recorder instanceof SparseSessionRecorderAdapter ? this.recorder.sourceOrdinal : undefined;
          this._parserSourceFrames.set(source, reference);
          this._processingSource = reference;
          this._latestSource = reference;
          if (this.recorder instanceof SparseSessionRecorderAdapter) {
            const ordinal = this.recorder.sourceOrdinal;
            if (ordinal !== undefined) detector.observeSourceRecord?.(rawByteOffset, this.recorder.getCurrentByteOffset(), ordinal);
          }
        }
      } else {
        rawByteOffset = source.rawOffset;
      }
    }

    const adapter = getServerGame(packet.gameId);
    if (this.ws.wantsDevTelemetry) {
      this.ws.stageDevTelemetry(structuredClone(packet));
    }

    normalizeTelemetryPacket(packet, adapter.coordSystem === "standard-xyz", adapter.runtime.normSuspensionTravelMm);

    const rawOrdinal = !this._recordingSession?.directCapture?.hasFailed && Buffer.isBuffer(source)
      ? this._parserSourceFrames.get(source)?.rawOrdinal
        ?? (this.recorder instanceof SparseSessionRecorderAdapter ? this.recorder.sourceOrdinal : undefined)
      : undefined;
    if (rawByteOffset !== undefined && rawOrdinal !== undefined) {
      const end = this._processingSource?.rawEndOffset ?? this.recorder.getCurrentByteOffset();
      detector.observeSourceRecord?.(rawByteOffset, end, rawOrdinal);
      if (detector.shouldCheckpointBeforeWrite(packet)) this.recorder.requestFullCheckpoint?.();
    }
    await detector.feed(packet, rawByteOffset, rawOrdinal);
    if (detector.session && packet.LapNumber !== this._lastAttributionLap) {
      await this.db.setSessionDriverAttribution(detector.session.sessionId, this._attributionTracker.stints);
      this._lastAttributionLap = packet.LapNumber;
    }

    // If feed rotates the session, write the triggering source into the new recorder
    // and patch the detector offset to the canonical source position.
    if (source && this.recorder.active && this.recorder.epoch !== epochBefore) {
      if (Buffer.isBuffer(source)) {
        this._writeProcessingTrigger();
      } else {
        detector.setCurrentLapByteOffset?.(source.rawOffset);
      }
    }
    this._drainOwnership();

    this._observeDashboardPacket(detector.session?.sessionId, packet, source, frameTimeMs);
    const sectors = this.sectorTracker.feed(packet);

    // Prefer detector state when the adapter marks native best-lap data weak.
    const sessionBest = detector.session?.bestLapTime ?? 0;
    if (adapter.runtime.bestLapFromSession && sessionBest > 0) {
      packet.BestLap = sessionBest;
    }

    const pit = this.pitTracker.feed(packet, this.sectorTracker.getTrackLength(), this.sectorTracker.getLapDistStart());

    // Collect calibration positions for adapters that require track-outline alignment.
    if (this._totalProcessed % 6 === 0 && adapter.runtime.requiresTrackCalibration) {
      const session = detector.session;
      const trackIdentity = session?.trackId;
      if (session && trackIdentity) {
        const outline = getTrackOutlineById(trackIdentity, session.gameId);
        if (outline) {
          const trackLength = this.sectorTracker.getTrackLength();
          const normalizedProgress =
            Number.isFinite(packet.DistanceTraveled) && Number.isFinite(trackLength) && trackLength > 0
              ? (((packet.DistanceTraveled % trackLength) + trackLength) % trackLength) / trackLength
              : undefined;
          feedCalibrationPosition(trackIdentity, { x: packet.PositionX, z: packet.PositionZ }, packet.LapNumber, outline, normalizedProgress, this._calibrationBoundary ?? undefined);
        }
      }
    }

    // Live Tuning Dashboard transient detector — gated, off by default. Stateless
    // per-packet call; skipped entirely (no cost) unless the client opted in.
    const liveIssues = this._liveIssuesEnabled ? detectLiveIssues(packet, this.sectorTracker.getTrackLength()) : undefined;

    const projection = this.projector.project({
      packet,
      sessionId: detector.session?.sessionId,
      sectors,
      pit,
      liveIssues,
      receivedAtMs: Date.now(),
    });
    this.ws.publishTelemetry({ packet, sectors, pit, liveIssues, projection });

    if (!this._skipDevState && this.ws.wantsDevState) {
      this.ws.broadcastDevState({
        lapDetector: detector.getDebugState?.() ?? {},
        sectorTracker: this.sectorTracker.getDebugState(),
        pitTracker: this.pitTracker.getDebugState(),
      });
    }
  }

  /**
   * Metadata-only canonical import path. Records and feeds lap detection,
   * while avoiding live-only trackers, projection, publication, and issues.
   */
  async processLapIndexPacket(packet: LapIndexPacket, source?: PacketSourceReference, frameTimeMs?: number): Promise<void> {
    this._totalProcessed++;
    const detector = this._getOrCreateDetector(packet.gameId);
    this._processingNativeFrame = Buffer.isBuffer(source) ? source : null;
    this._processingTimestamp = frameTimeMs;
    this._processingSource = Buffer.isBuffer(source) ? this._parserSourceFrames.get(source) ?? null : null;
    try {
      let rawByteOffset: number | undefined;
      const epochBefore = this.recorder.epoch;
      if (source && this.recorder.active) {
        if (Buffer.isBuffer(source)) {
          const captured = this._parserSourceFrames.get(source);
          if (captured?.epoch === epochBefore && captured.rawOffset !== undefined) rawByteOffset = captured.rawOffset;
          else {
            if (detector.shouldCheckpointBeforeWrite(packet as TelemetryPacket)) this.recorder.requestFullCheckpoint?.();
            rawByteOffset = this.recorder.getCurrentByteOffset();
            this.recorder.writeRecord(source, frameTimeMs);
          }
        } else rawByteOffset = source.rawOffset;
      }
      const adapter = getServerGame(packet.gameId);
      const telemetryPacket = packet as unknown as TelemetryPacket;
      normalizeTelemetryPacket(telemetryPacket, adapter.coordSystem === "standard-xyz", adapter.runtime.normSuspensionTravelMm);
      const currentOrdinal = this.recorder instanceof SparseSessionRecorderAdapter ? this.recorder.sourceOrdinal : undefined;
      // Source-less import completion context is stored outside the owned window.
      // Its boundary is one native record beyond the last owned record, not that record's ordinal.
      const rawOrdinal = Buffer.isBuffer(source)
        ? this._parserSourceFrames.get(source)?.rawOrdinal ?? currentOrdinal
        : source === undefined && currentOrdinal !== undefined ? currentOrdinal + 1 : undefined;
      if (rawByteOffset !== undefined && rawOrdinal !== undefined) {
        detector.observeSourceRecord?.(rawByteOffset, this.recorder.getCurrentByteOffset(), rawOrdinal);
      }
      await detector.feed(telemetryPacket, rawByteOffset, rawOrdinal);
      if (source && this.recorder.active && this.recorder.epoch !== epochBefore) {
        if (Buffer.isBuffer(source)) this._writeProcessingTrigger();
        else detector.setCurrentLapByteOffset?.(source.rawOffset);
      }
      this._drainOwnership();
      this._observeDashboardPacket(detector.session?.sessionId, telemetryPacket, source, frameTimeMs);
    } finally {
      this._processingNativeFrame = null;
      this._processingSource = null;
      this._processingTimestamp = undefined;
    }
  }

  async flushSessionRecorder(): Promise<void> {
    await this._withIngressPaused(async () => {
      if (this._recordingSession?.directCapture) await this._finalizeCurrentSession();
      else await withSessionCaptureMaintenanceLock(() => this.recorder.stop());
    });
  }

  /**
   * Preserve parser context in imported captures without feeding its stale
   * telemetry values through the lap detector.
   */
  recordSessionContextFrame(sourceFrame: Buffer, completeLapStart = false, frameTimeMs?: number): void {
    this._expectCompleteLapStart ||= completeLapStart;
    const contextRecord = Buffer.concat([encodeSegmentContextFrame(), encodeFrameLength(sourceFrame.length, frameTimeMs), sourceFrame, encodeSegmentContextEndFrame()]);
    if (this.recorder.active) {
      this.recorder.writeRawCaptureBytes(contextRecord);
      return;
    }
    this._pendingSessionContextFrames.push(contextRecord);
  }
  recordParserBootstrap(gameId: GameId, payload: Buffer, completeLapStart = false): void {
    this._expectCompleteLapStart ||= completeLapStart;
    const record = encodeParserBootstrapFrame(gameId, payload);
    if (this.recorder.active) {
      this.recorder.writeRawCaptureBytes(record);
      return;
    }
    this._pendingSessionContextFrames.push(record);
  }

  /**
   * Preserve parser context in imported captures without feeding its stale
   * telemetry values through the lap detector.
   */

  /**
   * Drop in-memory ownership of a session deleted through the API.
   * Next packet creates a fresh DB session and capture without restarting game source.
   */
  async recoverDeletedSessions(sessionIds: readonly number[]): Promise<boolean> {
    return this._withIngressPaused(async () => {
      const activeSessionId = this._lapDetector?.session?.sessionId;
      if (activeSessionId === undefined || !sessionIds.includes(activeSessionId)) return false;
      const capture = this._recordingSession?.directCapture;
      const invalidated = new Error("Recording session was deleted");
      capture?.fail(invalidated);

      this._lapDetector = null;
      this._lapDetectorGameId = null;
      this._recordingSession = null;
      for (const sessionId of sessionIds) this._dashboardCaptureObservations.delete(sessionId);
      this._attributionSessionId = null;
      this._attributionTracker = new NativeAttributionTracker();
      this._lastAttributionLap = null;
      this._originalSourceIntegrityComplete = true;
      this._attributionEvidenceEpoch = -1;
      this._continuingSegment = false;
      this._pendingSessionContextFrames = [];
      this._sessionLaps = [];
      for (const pending of this._pendingDirectSources) if (pending) pending.reference.pendingDirect = false;
      this._pendingDirectSources.length = 0;
      this._pendingDirectHead = 0;
      this._pendingDirectBytes = 0;
      try { await withSessionCaptureMaintenanceLock(() => this.recorder.stop()); }
      catch (error) { if (error !== invalidated) throw error; }
      this._broadcastSessionLaps();
      return true;
    });
  }

  /** Start next offline capture segment without rotating canonical session. */
  beginSessionSegment(): void {
    if (!this.recorder.active || !this._recordingSession) {
      throw new Error("Cannot begin import segment before a session has started");
    }
    this._dashboardCaptureObservations.get(this._recordingSession.sessionId)?.observation.finishSegment();
    this.recorder.writeSegmentBoundary();
    this._lapDetector = null;
    this._attributionTracker.sourceComplete = false;
    this._originalSourceIntegrityComplete = false;
    this._lapDetectorGameId = null;
    this._continuingSegment = true;
    this._expectCompleteLapStart = true;
  }

  /** Treat first parsed lap after an import boundary as a complete lap. */
  expectCompleteLapStart(): void {
    this._expectCompleteLapStart = true;
  }

  /** Flush buffered writes to disk without closing. */
  flushSessionRecorderBuffer(): void {
    this.recorder.flush();
    const sessionId = this._recordingSession?.sessionId;
    if (sessionId !== undefined) {
      void markDashboardCaptureCheckpoint(sessionId, false).catch((error) => {
        console.error(`[DashboardProcessor] Capture checkpoint failed for session ${sessionId}:`, error);
      });
    }
  }
}

// Module-level pipeline used by live runtime callers.
const _defaultWs: WsAdapter = {
  get wantsDevState() {
    return wsManager.wantsDevState;
  },
  get wantsDevTelemetry() {
    return wsManager.wantsDevTelemetry;
  },
  broadcast: (packet, sectors, pit, liveIssues) => wsManager.broadcast(packet, sectors, pit, liveIssues),
  stageDevTelemetry: (packet) => wsManager.stageDevTelemetry(packet),
  publishTelemetry: ({ packet, sectors, pit, liveIssues, projection }) => {
    wsManager.broadcast(packet, sectors, pit, liveIssues);
    if (projection) wsManager.publishTelemetry(projection);
  },
  broadcastNotification: (event) => wsManager.broadcastNotification(event),
  broadcastDevState: (state) => wsManager.broadcastDevState(state),
};
const _nativeBindingCandidateCache = new NativeBindingCandidateCache();
const _defaultDb = new RealDbAdapter({ sourceOrigin: { kind: "native_capture" } });
export const nativeBindingCandidateHost = {
  sourceRevisionBuffer: _nativeBindingCandidateCache.sourceRevisionBuffer,
  listCandidates: () => _nativeBindingCandidateCache.listCandidates(),
  resolveCandidate: (candidateId: string, expectedBindingRevision: number) =>
    _nativeBindingCandidateCache.resolveCandidate(candidateId, expectedBindingRevision),
  subscribeChanges: (listener: (sourceRevision: number) => void) => _nativeBindingCandidateCache.subscribeChanges(listener),
  consumeCandidate: (candidateId: string, sourceRevision: number) => {
    _nativeBindingCandidateCache.consumeCandidate(candidateId, sourceRevision);
    _defaultDb.invalidateDriverBindingSnapshot();
    void _default.refreshNativeDriverBindings().catch((error) =>
      console.warn("[NativeBindingCandidate] Committed binding refresh failed", error));
  },
};

const _default = new LiveTelemetryPipeline(_defaultDb, _defaultWs, {
  nativeBindingCandidates: _nativeBindingCandidateCache,
  onSessionFinalized: async (sessionId, gameId) => {
    try {
      await reconcileSessionResult(sessionId, gameId);
    } catch (error) {
      console.error(`[Race Results] Failed to reconcile session ${sessionId}:`, error);
    }
  },
});
subscribeParserSource((input) => _default.captureParserSource(input));
subscribeParserDriverEvidenceInvalidation(({ gameId, timestampMs }) => _default.invalidateNativeDriverEvidence(gameId, timestampMs));

// Wire session laps provider so WS manager can send laps on client connect
wsManager.setSessionLapsProvider(() => _default.sessionLaps);
export const processPacket = (packet: TelemetryPacket, source?: PacketSourceReference, frameTimeMs?: number) => _default.processPacket(packet, source, frameTimeMs);
/** Reader-level control changes invalidate UI capabilities without discarding captured historical stints. */
export const invalidateNativeBindingCandidates = (gameId: GameId, receivedAtMs: number): void =>
  _nativeBindingCandidateCache.invalidate(gameId, receivedAtMs);

/** Returns the current lap detector (may be null before the first packet is processed). */
export const lapDetector = {
  get session() {
    return _default.lapDetector?.session ?? null;
  },
  get fuelHistory() {
    return _default.lapDetector?.fuelHistory ?? [];
  },
  get tireWearHistory() {
    return _default.lapDetector?.tireWearHistory ?? [];
  },
  async snapshotIncompleteLap() {
    await _default.snapshotIncompleteLap();
  },
  async finalizeCurrentSession() {
    await _default.finalizeCurrentSession();
  },
};

/** Reset live ownership when user deletes active session. */
export function recoverDeletedSessions(sessionIds: readonly number[]): Promise<boolean> {
  return _default.recoverDeletedSessions(sessionIds);
}

/** Toggle the Live Tuning Dashboard's per-packet transient issue detector. */
export function setLiveIssuesEnabled(enabled: boolean): void {
  _default.setLiveIssuesEnabled(enabled);
}

let _maintenanceInterval: NodeJS.Timeout | undefined;

/** Start only after runtime initialization; importing the pipeline must not start background work. */
export function startMaintenanceTasks(): void {
  if (_maintenanceInterval) return;
  _maintenanceInterval = setInterval(() => {
    void _default.flushStaleSession().catch((error) => {
      console.error("[Live Telemetry] Stale session finalization failed:", error);
    });
  }, 5_000);
  _maintenanceInterval.unref?.();
}

/** Stop the module-level maintenance interval. */
export function stopMaintenanceTasks(): void {
  clearInterval(_maintenanceInterval);
  _maintenanceInterval = undefined;
}

/** True while a session records or its capture files are still draining. */
export function isSessionActive(): boolean {
  return _default.isSessionActive;
}

/** Flush and close the active session recorder. Call on graceful shutdown. */
export async function flushSessionRecorder(): Promise<void> {
  await _default.finalizeCurrentSession();
}

/** Flush buffered writes to disk. Call periodically so lap offsets stay consistent with file size. */
export function flushSessionRecorderBuffer(): void {
  _default.flushSessionRecorderBuffer();
}
