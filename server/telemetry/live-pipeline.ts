export type PacketSourceReference = Buffer | { rawOffset: number };
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { type DbAdapter, type WsAdapter, type SessionRecorderAdapter, RealDbAdapter, SparseSessionRecorderAdapter } from "./pipeline-ports";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import type { ILapDetector, LapDetectorCallbacks } from "../lap-detection/types";
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
import { materializeParserInitializationPlan, subscribeParserSource, type ParserSourceInput, type ParserReplayLocator } from "../games/packet-dispatch";
import type { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";
import { LiveCaptureSession } from "../session-capture/live-capture";

import { DashboardCaptureObservation } from "../session-capture/dashboard-observation";
import { markDashboardCaptureCheckpoint, publishObservedDashboardCaptureFacts } from "../session-capture/dashboard-processor";
type CaptureObservationEntry = { observation: DashboardCaptureObservation; rawFile: string | null };
type RecordingSession = { sessionId: number; gameId: GameId; liveCapture?: LiveCaptureSession };
type CapturedParserSource = {
  parserSequence: number; epoch: number; locator: ParserReplayLocator | null;
  rawOffset?: number; rawEndOffset?: number; rawOrdinal?: number;
};
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
  private readonly _parserSourceFrames = new WeakMap<Buffer, CapturedParserSource>();
  private _latestSource: CapturedParserSource | null = null;
  private _processingSource: CapturedParserSource | null = null;
  private readonly _retiringCaptures = new Set<Promise<void>>();
  private _processingNativeFrame: Buffer | null = null;
  private _processingTimestamp: number | undefined;

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

  /** True while a session is being recorded (session recorder is open). */
  get isSessionActive(): boolean {
    return this.recorder.active && !this._recordingSession?.liveCapture?.hasFailed;
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
      onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
    },
  ) {
    this.db = db;
    this.ws = ws;
    this.recorder = options?.recorder ?? new SparseSessionRecorderAdapter();
    this._bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
    this._skipHistorySeeding = options?.skipHistorySeeding ?? false;
    this._skipDevState = options?.skipDevState ?? false;
    this._enqueueSessionCaptureSplits = options?.enqueueSessionCaptureSplits ?? true;
    this._onSessionFinalized = options?.onSessionFinalized;
    if (db instanceof RealDbAdapter) {
      db.subscribeLapBindings((binding) => {
        if (binding.sessionId === this._recordingSession?.sessionId) this._recordingSession.liveCapture?.bindLap(binding);
        else this._retiringSessions.get(binding.sessionId)?.liveCapture?.bindLap(binding);
      });
      db.subscribeLapWriteFailures((sessionId, error) => {
        const session = sessionId === this._recordingSession?.sessionId ? this._recordingSession : this._retiringSessions.get(sessionId);
        session?.liveCapture?.fail(error);
      });
      db.subscribeLapInvalidations((lapId) => {
        this._recordingSession?.liveCapture?.invalidateLap(lapId);
        for (const session of this._retiringSessions.values()) session.liveCapture?.invalidateLap(lapId);
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
    const reference: CapturedParserSource = { parserSequence: input.sequence, epoch: this.recorder.epoch, locator: input.locator };
    this._parserSourceFrames.set(input.frame, reference);
    if (!this.recorder.active || this._recordingSession?.gameId !== input.gameId || this._recordingSession.liveCapture?.hasFailed) return;
    try {
      reference.rawOffset = this.recorder.getCurrentByteOffset();
      this.recorder.writeRecord(input.frame, input.timestampMs);
      reference.rawEndOffset = this.recorder.getCurrentByteOffset();
      if (this.recorder instanceof SparseSessionRecorderAdapter) {
        reference.rawOrdinal = this.recorder.sourceOrdinal;
      }
      this._latestSource = reference;
    } catch (error) {
      this.ws.broadcastNotification({
        type: "recording-failed",
        sessionId: this._recordingSession?.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
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
      return await operation();
    } finally {
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
        if (this._enqueueSessionCaptureSplits && !session.liveCapture?.isSealed) {
          await enqueueSessionCaptureSplit(session.sessionId);
        }
      } catch (error) {
        console.error(`[CaptureSplit] Failed to enqueue closed session ${session.sessionId}:`, error);
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
    if (!session?.liveCapture) {
      await withSessionCaptureMaintenanceLock(async () => {
        if (session && this._recordingSession?.sessionId === session.sessionId) this._recordingSession = null;
        await this.recorder.stop();
      });
    } else {
      this._drainOwnership(session);
      if (!(this.recorder instanceof SparseSessionRecorderAdapter)) throw new Error("Live capture lost its worker recorder");
      const source = this.recorder.detachRecorder();
      this._recordingSession = null;
      if (source) {
        this._retiringSessions.set(session.sessionId, session);
        try { await this._finishLiveSource(session, source); }
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
    session?.liveCapture?.processTransitions(transitions, source?.locator,
      source?.rawEndOffset ?? this.recorder.getCurrentByteOffset());
  }

  private async _finishLiveSource(session: RecordingSession, source: WorkerSessionRecorder): Promise<void> {
    const capture = session.liveCapture!;
    try {
      if (this.db instanceof RealDbAdapter) await this.db.drainLapWrites(session.sessionId);
      await capture.close();
      await source.stop();
      await capture.sealMetadata();
    } catch (error) {
      capture.fail(error);
      await source.stop().catch((failure) => console.error("[LiveCapture] Failed to drain canonical source:", failure));
      throw error;
    } finally {
      try { await source.worker.terminate(); }
      finally { capture.dispose(); }
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
    if (entry) entry.observation.observe(packet, source, frameTimeMs);
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
          await withSessionCaptureMaintenanceLock(async () => {
            if (previousSession?.liveCapture && this.recorder instanceof SparseSessionRecorderAdapter) {
              if (this._retiringCaptures.size >= 2) throw new Error("Live finalization worker budget exhausted");
              this._drainOwnership(previousSession);
              const source = this.recorder.detachRecorder();
              if (source) {
                this._retiringSessions.set(previousSession.sessionId, previousSession);
                const retirement = this._finishLiveSource(previousSession, source).then(async () => {
                  await this.finalizeDashboardCaptureFacts([previousSession.sessionId]);
                  await this._reconcileRecordedSession(previousSession);
                });
                this._retiringCaptures.add(retirement);
                void retirement.catch((error) => console.error("[LiveCapture] Retired capture failed:", error));
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
              if (this._enqueueSessionCaptureSplits && this.db instanceof RealDbAdapter &&
                  this.recorder instanceof SparseSessionRecorderAdapter && this.recorder.supportsLiveSplitting && this.recorder.workerRecorder) {
                recording.liveCapture = new LiveCaptureSession(session.sessionId, session.gameId, this.recorder.workerRecorder,
                  (event) => {
                    this.ws.broadcastNotification(event);
                    if (event.type === "lap-capture-ready") {
                      const lap = this._sessionLaps.find((entry) => entry.id === event.lapId && entry.sessionId === event.sessionId);
                      if (lap) { lap.standaloneCaptureReady = true; this._broadcastSessionLaps(); }
                    }
                  }, registration);
              }
              this._writeProcessingTrigger();
              await registration;
              await markDashboardCaptureCheckpoint(session.sessionId, false);
            }
          });
          if (previousSession && !previousSession.liveCapture) {
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
        if (event.isValid) {
          this.sectorTracker.updateRefLap(event.packets, event.lapTime, event.sectors);
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
          createdAt: new Date().toISOString(),
          gameId: session.gameId,
          carId: session.carId,
          trackId: session.trackId,
          sectorTimes: event.sectors ?? undefined,
          standaloneCaptureReady: recording.liveCapture?.isLapReady(event.lapId),
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
    await this._finishRecordedSession(session);
    await Promise.all(this._retiringCaptures);
  }

  /** Detect game-specific stale finalization and finish its durable capture. */
  async flushStaleSession(): Promise<void> {
    await this._withIngressPaused(async () => {
      const session = this._recordingSession;
      this._observeSourceTail();
      await this._lapDetector?.flushStaleLap?.();
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

  /**
   * Shared telemetry processing pipeline used by every telemetry source.
   *
   * Capture and tracking stay full-rate; WebSocket publication has its own cadence.
   * Stages: record sourceFrame → optional native dev copy → normalize → detector/sector/pit/BestLap → project → publish.
   */
  async processPacket(packet: TelemetryPacket, source?: PacketSourceReference, frameTimeMs?: number): Promise<void> {
    while (this._ingressBarrier) await this._ingressBarrier;
    const reservedBytes = 16 * 1024 + (Buffer.isBuffer(source) ? source.length + (this._parserSourceFrames.get(source)?.locator?.byteCost ?? 0) : 0);
    if (this._queuedPacketBytes + reservedBytes > 8 * 1024 * 1024) {
      const error = new Error("Recording detector queue capacity exhausted");
      this.ws.broadcastNotification({ type: "recording-failed", sessionId: this._recordingSession?.sessionId, error: error.message });
      this._recordingSession?.liveCapture?.fail(error);
      throw error;
    }
    this._queuedPacketBytes += reservedBytes;
    const previous = this._packetQueue;
    let release!: () => void;
    this._packetQueue = new Promise<void>((resolve) => { release = resolve; });
    const processing = (async () => {
      await previous;
      try {
        await this._processPacket(packet, source, frameTimeMs);
      } catch (error) {
        this._recordingSession?.liveCapture?.fail(error);
        throw error;
      } finally {
        this._processingNativeFrame = null;
        this._processingSource = null;
        this._processingTimestamp = undefined;
        this._queuedPacketBytes -= reservedBytes;
        release();
      }
    })();
    this._activePacketProcessing.add(processing);
    try {
      await processing;
    } finally {
      this._activePacketProcessing.delete(processing);
    }
  }

  private async _processPacket(packet: TelemetryPacket, source: PacketSourceReference | undefined, frameTimeMs?: number): Promise<void> {
    applyFrameTime(packet, frameTimeMs);
    this._totalProcessed++;
    if (this._lapDetector && this._lapDetectorGameId !== packet.gameId) {
      this._observeSourceTail();
      await this._lapDetector.finalizeCurrentSession?.();
      this._drainOwnership();
    }
    const detector = this._getOrCreateDetector(packet.gameId);
    this._processingNativeFrame = Buffer.isBuffer(source) ? source : null;
    this._processingTimestamp = frameTimeMs;
    this._processingSource = Buffer.isBuffer(source) ? this._parserSourceFrames.get(source) ?? null : null;

    let rawByteOffset: number | undefined;
    const epochBefore = this.recorder.epoch;
    if (source && this.recorder.active && !this._recordingSession?.liveCapture?.hasFailed) {
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

    const rawOrdinal = !this._recordingSession?.liveCapture?.hasFailed && Buffer.isBuffer(source)
      ? this._parserSourceFrames.get(source)?.rawOrdinal
        ?? (this.recorder instanceof SparseSessionRecorderAdapter ? this.recorder.sourceOrdinal : undefined)
      : undefined;
    if (rawByteOffset !== undefined && rawOrdinal !== undefined) {
      const end = this._processingSource?.rawEndOffset ?? this.recorder.getCurrentByteOffset();
      detector.observeSourceRecord?.(rawByteOffset, end, rawOrdinal);
      if (detector.shouldCheckpointBeforeWrite(packet)) this.recorder.requestFullCheckpoint?.();
    }
    await detector.feed(packet, rawByteOffset, rawOrdinal);

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
      if (this._recordingSession?.liveCapture) await this._finalizeCurrentSession();
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
      const capture = this._recordingSession?.liveCapture;
      capture?.fail(new Error("Live session was deleted"));

      this._lapDetector = null;
      this._lapDetectorGameId = null;
      this._recordingSession = null;
      for (const sessionId of sessionIds) this._dashboardCaptureObservations.delete(sessionId);
      this._continuingSegment = false;
      this._pendingSessionContextFrames = [];
      this._sessionLaps = [];
      try { await withSessionCaptureMaintenanceLock(() => this.recorder.stop()); }
      finally { capture?.dispose(); }
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
    this._lapDetectorGameId = null;
    this._continuingSegment = true;
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
const _default = new LiveTelemetryPipeline(new RealDbAdapter(), _defaultWs, {
  onSessionFinalized: async (sessionId, gameId) => {
    try {
      await reconcileSessionResult(sessionId, gameId);
    } catch (error) {
      console.error(`[Race Results] Failed to reconcile session ${sessionId}:`, error);
    }
  },
});
subscribeParserSource((input) => _default.captureParserSource(input));

// Wire session laps provider so WS manager can send laps on client connect
wsManager.setSessionLapsProvider(() => _default.sessionLaps);
export const processPacket = (packet: TelemetryPacket, source?: PacketSourceReference, frameTimeMs?: number) => _default.processPacket(packet, source, frameTimeMs);

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

// Periodic check: flush stale laps when packets stop (e.g. race ended, game
// closed). `.unref()` so bun test's event loop can exit once the tests are
// done — without it every test that transitively imports this module hangs
// the runner waiting for a never-arriving interval tick.
const _maintenanceInterval = setInterval(() => {
  void _default.flushStaleSession().catch((error) => {
    console.error("[Live Telemetry] Stale session finalization failed:", error);
  });
}, 5_000);
_maintenanceInterval.unref?.();

/** Stop the module-level maintenance interval. Call in test/bench contexts to allow clean exit. */
export function stopMaintenanceTasks(): void {
  clearInterval(_maintenanceInterval);
}

/** True while a session is actively being recorded. */
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
