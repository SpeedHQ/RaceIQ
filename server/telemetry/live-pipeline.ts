export type PacketSourceReference = Buffer | { rawOffset: number };
import { isAbsolute } from "node:path";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import type { ILapDetector, LapDetectorCallbacks, LapIndexPacket } from "../lap-detection/types";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { type DbAdapter, type WsAdapter, type SessionRecorderAdapter, RealDbAdapter, SparseSessionRecorderAdapter } from "./pipeline-ports";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import type { SessionState } from "../lap-detection/types";
import { SectorTracker } from "../live-strategy/sector-tracker";
import { PitTracker } from "../live-strategy/pit-tracker";
import { feedCalibrationPosition, resetLiveCalibration } from "../tracks/calibration";
import { getTrackOutlineByOrdinal } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { getTrackBoundariesByOrdinal } from "@raceiq/game-catalogs/racing/tracks/geometry/extracted";
import type { TrackBoundary } from "@raceiq/shared/racing/tracks/geometry/types";
import { getServerGame } from "../games/registry";
import { normalizeTelemetryPacket } from "@raceiq/telemetry-core/telemetry/normalization";
import { getRecorderEngine, getRecordingEngineKind } from "../runtime/recorder-engine";
import { detectLiveIssues } from "../ai/tune-issues";
import { persistRecordedLapFollowups } from "../lap-analysis/recorded-lap";
import { encodeFrameLength, encodeSegmentContextEndFrame, encodeSegmentContextFrame } from "../session-capture/framing";
import { applyFrameTime } from "../session-capture/frame-time";
import { wsManager } from "../runtime/websocket-manager";
import { withSessionCaptureMaintenanceLock } from "../session-capture/cleanup";
import { unpack } from "msgpackr";
import type { RecorderEngine, RecorderEvent } from "../runtime/recorder-engine";
import { attachRecordingEventConsumer, type RecordingLifecycleEvent } from "./recording-events";
import { deriveRecordedLap } from "../lap-analysis/recorded-lap";
import { notifyDriverProfileLap } from "../driver-profile/lap-notifier";
import { updateSessionSource } from "../db/session-queries";
import { materializeRecordedLapRecipe } from "../session-capture/import-results";
import { reconcileSessionResult } from "../race-results/reconcile";


interface RustLiveSession {
  captureId: string;
  sessionId: number;
  gameId: GameId;
  carOrdinal: number;
  trackOrdinal: number;
  carPI: number;
  rawFile: string;
  sessionUID?: string;
  carId?: string;
  trackId?: string;
  bestLapTime: number;
}
interface RustSessionLap {
  lapId: number;
  captureId: string;
  provisional: boolean;
}

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
  private _recordingSession: { sessionId: number; gameId: GameId } | null = null;
  private _continuingSegment = false;
  private _pendingSessionContextFrames: Buffer[] = [];
  private _expectCompleteLapStart = false;
  private _onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
  private _finalizedResultSessions = new Set<number>();
  private _resultFinalizations = new Map<number, Promise<void>>();
  private _calibrationBoundary: TrackBoundary | null = null;
  private _ingressBarrier: Promise<void> | null = null;
  private _activePacketProcessing = new Set<Promise<void>>();
  private _rustSessions = new Map<string, RustLiveSession>();
  private _rustLapIds = new Map<string, RustSessionLap>();
  private _rustSession: RustLiveSession | null = null;
  private _lastRustFrameSequence = 0n;
  private _ignoredCaptureIds = new Set<string>();

  get lapDetector(): ILapDetector | null {
    return this._lapDetector;
  }
  get currentSession(): SessionState | null {
    const current = this._rustSession;
    if (current) return {
      sessionId: current.sessionId,
      gameId: current.gameId,
      carOrdinal: current.carOrdinal,
      trackOrdinal: current.trackOrdinal,
      carPI: current.carPI,
      sessionUID: current.sessionUID,
      carId: current.carId,
      trackId: current.trackId,
      bestLapTime: current.bestLapTime,
    };
    return this._lapDetector?.session ?? null;

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
    return this._rustSession !== null || this.recorder.active;
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
      onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
    },
  ) {
    this.db = db;
    this.ws = ws;
    this.recorder = options?.recorder ?? new SparseSessionRecorderAdapter();
    this._bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
    this._skipHistorySeeding = options?.skipHistorySeeding ?? false;
    this._skipDevState = options?.skipDevState ?? false;
    this._onSessionFinalized = options?.onSessionFinalized;
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

  private _reconcileRecordedSession(session: { sessionId: number; gameId: GameId }): Promise<void> {
    if (this._finalizedResultSessions.has(session.sessionId)) {
      return Promise.resolve();
    }
    const pending = this._resultFinalizations.get(session.sessionId);
    if (pending) return pending;
    const finalization = (async () => {
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
    await withSessionCaptureMaintenanceLock(async () => {
      if (session && this._recordingSession?.sessionId === session.sessionId) {
        this._recordingSession = null;
      }
      await this.recorder.stop();
    });
    // Reconciliation parses and hashes complete capture. Run only after recorder
    // closes; doing this after every lap blocks shared-memory polling and corrupts
    // following lap's opening frames.
    if (session) await this._reconcileRecordedSession(session);
  }

  private _buildCallbacks(): LapDetectorCallbacks {
    return {
      onSessionStart: async (session) => {
        const previousSession = this._recordingSession;
        const continuing = this._continuingSegment && previousSession !== null && previousSession.sessionId === session.sessionId && previousSession.gameId === session.gameId;
        this._continuingSegment = false;
        if (!continuing) {
          await withSessionCaptureMaintenanceLock(async () => {
            this._recordingSession = null;
            await this.recorder.stop();
            this.recorder.start(session.gameId);
            this.recorder.writeMetaFrame();
            this._recordingSession = {
              sessionId: session.sessionId,
              gameId: session.gameId,
            };
            if (this.recorder.path) {
              await this.db.updateSessionRawFile(
                session.sessionId, this.recorder.path, this._lapDetector?.detectorId ?? LAP_DETECTOR_ID,
                this.recorder instanceof SparseSessionRecorderAdapter,
              );
            }
          });
          if (previousSession) {
            void this._reconcileRecordedSession(previousSession).catch((error) => {
              console.error(`[Race Results] Failed to reconcile session ${previousSession.sessionId}:`, error);
            });
          }
        }

        resetLiveCalibration(session.trackOrdinal);
        this._calibrationBoundary = getTrackBoundariesByOrdinal(session.trackOrdinal, session.gameId);

        await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
        this.pitTracker.reset();
        const adapter = getServerGame(session.gameId);
        this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
        this.pitTracker.setTireWearAvailable(resolveAnalysisTelemetry(adapter).tireWearRate.source !== "unavailable");
        if (!this._skipHistorySeeding) {
          await this.pitTracker.seedFromHistory(session.trackOrdinal, session.carOrdinal, session.carPI, session.gameId, adapter.runtime.pit);
          await this._seedSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
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

        // Append to in-memory list and broadcast
        const session = this._lapDetector?.session ?? null;
        if (session) {
          this._sessionLaps.push({
            id: event.lapId,
            sessionId: session.sessionId,
            lapNumber: event.lapNumber,
            lapTime: event.lapTime,
            isValid: event.isValid,
            createdAt: new Date().toISOString(),
            gameId: session.gameId,
            carOrdinal: session.carOrdinal,
            trackOrdinal: session.trackOrdinal,
            sectorTimes: event.sectors ?? undefined,
          });
          if (this._sessionLaps.length > CURRENT_SESSION_LAP_SNAPSHOT_LIMIT) {
            this._sessionLaps.splice(0, this._sessionLaps.length - CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
          }
          this._broadcastSessionLaps();
        }
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
    await this._lapDetector?.flushIncompleteLap?.();
  }
  /** Persist a replaceable snapshot without ending the active session. */
  async snapshotIncompleteLap(): Promise<void> {
    await this._lapDetector?.snapshotIncompleteLap?.();
  }

  /** Finalize detector, durable capture, then authoritative session result. */
  async finalizeCurrentSession(): Promise<void> {
    await this._withIngressPaused(async () => {
      const session = this._recordingSession;
      await this._lapDetector?.finalizeCurrentSession?.();
      await this._finishRecordedSession(session);
    });
  }

  /** Detect game-specific stale finalization and finish its durable capture. */
  async flushStaleSession(): Promise<void> {
    await this._withIngressPaused(async () => {
      const session = this._recordingSession;
      await this._lapDetector?.flushStaleLap?.();
      if (session && !this._lapDetector?.session) {
        await this._finishRecordedSession(session);
      }
    });
  }
  /** Seed in-memory session laps from DB (called once on session start). */
  private async _seedSessionLaps(sessionId: number, trackOrdinal: number, carOrdinal: number, gameId: GameId): Promise<void> {
    try {
      const allLaps = await this.db.getLaps(gameId, CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
      const sessionLaps = allLaps.filter((l) => l.sessionId === sessionId && l.trackOrdinal === trackOrdinal && l.carOrdinal === carOrdinal).sort((a, b) => a.id - b.id);
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
  async consumeRustRecordingEvent(event: RecordingLifecycleEvent): Promise<void> {
    if (this._ignoredCaptureIds.has(event.captureId)) return;
    const data = event.data as Record<string, unknown>;
    if (event.kind === "SESSION_STARTED") {
      const gameId = data.gameId as GameId;
      const carOrdinal = Number(data.carOrdinal);
      const trackOrdinal = Number(data.trackOrdinal);
      const carPI = Number(data.carPI ?? 0);
      if (!getServerGame(gameId) || ![carOrdinal, trackOrdinal, carPI].every(Number.isSafeInteger)) throw new Error("Invalid Rust session identity");
      if (typeof data.rawFile !== "string" || !isAbsolute(data.rawFile)) throw new Error("Invalid Rust capture path");
      const identity = typeof data.carId === "string" && typeof data.trackId === "string" ? { carId: data.carId, trackId: data.trackId } : undefined;
      const sessionId = await this.db.insertSession(carOrdinal, trackOrdinal, gameId, typeof data.sessionType === "string" ? data.sessionType : undefined, undefined, undefined, identity);
      await this.db.updateSessionRawFile(sessionId, data.rawFile, typeof data.detectorVersion === "string" ? data.detectorVersion : "rust-recorder_v1", data.sparse === true);
      if (typeof data.source === "string") await updateSessionSource(sessionId, data.source);
      const session: RustLiveSession = { captureId: event.captureId, sessionId, gameId, carOrdinal, trackOrdinal, carPI, rawFile: data.rawFile, sessionUID: typeof data.sessionUID === "string" ? data.sessionUID : undefined, carId: identity?.carId, trackId: identity?.trackId, bestLapTime: Number(data.bestLapTime ?? 0) };
      this._rustSessions.set(event.captureId, session);
      this._rustSession = session;
      this._lapDetector = null;
      this._lapDetectorGameId = null;
      resetLiveCalibration(trackOrdinal);
      this._calibrationBoundary = getTrackBoundariesByOrdinal(trackOrdinal, gameId);
      const adapter = getServerGame(gameId);
      await this.sectorTracker.reset(trackOrdinal, gameId, carOrdinal);
      this.pitTracker.reset();
      this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
      this.pitTracker.setTireWearAvailable(resolveAnalysisTelemetry(adapter).tireWearRate.source !== "unavailable");
      if (!this._skipHistorySeeding) {
        await this.pitTracker.seedFromHistory(trackOrdinal, carOrdinal, carPI, gameId, adapter.runtime.pit);
        await this._seedSessionLaps(sessionId, trackOrdinal, carOrdinal, gameId);
      } else this._sessionLaps = [];
      this._broadcastSessionLaps();
      return;
    }
    const session = this._rustSessions.get(event.captureId);
    if (!session) throw new Error(`Rust ${event.kind} arrived before SESSION_STARTED`);
    if (event.kind === "SESSION_IDENTITY_UPDATED") {
      const carOrdinal = Number(data.carOrdinal);
      const trackOrdinal = Number(data.trackOrdinal);
      if (!Number.isSafeInteger(carOrdinal) || !Number.isSafeInteger(trackOrdinal)) throw new Error("Invalid Rust session identity update");
      const identity = typeof data.carId === "string" && typeof data.trackId === "string" ? { carId: data.carId, trackId: data.trackId } : undefined;
      await this.db.updateSessionCarTrack(session.sessionId, carOrdinal, trackOrdinal, identity);
      session.carOrdinal = carOrdinal;
      session.trackOrdinal = trackOrdinal;
      session.carId = identity?.carId ?? session.carId;
      session.trackId = identity?.trackId ?? session.trackId;
      return;
    }
    if (event.kind === "LAP_RECORDED") {
      const lapKey = data.lapKey;
      const lapNumber = Number(data.lapNumber);
      const lapTime = Number(data.lapTime);
      const rawOffset = data.rawByteOffset;
      const rawFrameCount = Number(data.rawFrameCount);
      if (typeof lapKey !== "string" || !Number.isSafeInteger(lapNumber) || !Number.isFinite(lapTime) || typeof rawOffset !== "string" || !/^(0|[1-9]\d*)$/.test(rawOffset) || !Number.isSafeInteger(rawFrameCount) || rawFrameCount < 0 || typeof data.isValid !== "boolean") throw new Error("Invalid Rust lap descriptor");
      const rawOffsetBig = BigInt(rawOffset);
      if (rawOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Rust lap offset exceeds safe integer range");
      const offset = Number(rawOffsetBig);
      if (data.analysisRecipe === undefined) throw new Error("Rust LAP_RECORDED omitted analysis recipe");
      const packets = await materializeRecordedLapRecipe(event.captureId, session.gameId, typeof data.rawFile === "string" ? data.rawFile : session.rawFile, data.analysisRecipe, { carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal }, true);
      const derived = await deriveRecordedLap({ db: this.db, gameId: session.gameId, trackOrdinal: session.trackOrdinal, packets, lapTime, isValid: data.isValid });
      const tune = await this.db.getTuneAssignment(session.gameId, session.carOrdinal, session.trackOrdinal);
      const sectors = Array.isArray(data.sectors) ? data.sectors as number[] : derived.sectors;
      if (sectors !== null && sectors !== undefined && (!Array.isArray(sectors) || sectors.some((sector) => !Number.isFinite(sector)))) throw new Error("Invalid Rust sector results");
      const lapId = await this.db.insertLap(session.sessionId, lapNumber, lapTime, data.isValid, offset, rawFrameCount, null, tune?.tuneId ?? null, typeof data.invalidReason === "string" ? data.invalidReason : null, sectors);
      await persistRecordedLapFollowups(this.db, lapId, packets);
      const provisional = data.provisional === true;
      this._rustLapIds.set(`${event.captureId}:${lapKey}`, { lapId, captureId: event.captureId, provisional });
      if (data.isValid && Number(data.sessionBestLapTime) > 0) session.bestLapTime = Number(data.sessionBestLapTime);
      if (!provisional && data.isValid) {
        this.sectorTracker.updateRefLap(packets, lapTime, sectors);
        if (getServerGame(session.gameId).runtime.pit.useDistanceBasedWearCurves && packets.length) this.pitTracker.updateWearCurves(packets, packets[0]!.DistanceTraveled);
      }
      this.ws.broadcastNotification({ type: "lap-saved", lapId, lapNumber, lapTime, isValid: data.isValid, sectors, estimatedBestLapTime: session.bestLapTime });
      this._sessionLaps.push({ id: lapId, sessionId: session.sessionId, lapNumber, lapTime, isValid: data.isValid, createdAt: new Date().toISOString(), gameId: session.gameId, carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal, sectorTimes: sectors ?? undefined });
      if (this._sessionLaps.length > CURRENT_SESSION_LAP_SNAPSHOT_LIMIT) this._sessionLaps.splice(0, this._sessionLaps.length - CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
      this._broadcastSessionLaps();
      notifyDriverProfileLap(session.gameId);
      return;
    }
    if (event.kind === "LAP_RETRACTED") {
      if (typeof data.lapKey !== "string") throw new Error("Rust LAP_RETRACTED missing lapKey");
      const key = `${event.captureId}:${data.lapKey}`;
      const lap = this._rustLapIds.get(key);
      if (lap?.provisional) {
        await this.db.deleteLap(lap.lapId);
        this._rustLapIds.delete(key);
        this._sessionLaps = this._sessionLaps.filter((item) => item.id !== lap.lapId);
        this._broadcastSessionLaps();
      }
      return;
    }
    if (event.kind === "RECORDING_COMPLETED") {
      await this._reconcileRecordedSession({ sessionId: session.sessionId, gameId: session.gameId });
      this._rustSessions.delete(event.captureId);
      if (this._rustSession?.captureId === event.captureId) this._rustSession = null;
      return;
    }
    return;
  }

  async processRustLiveFrame(event: Extract<RecorderEvent, { type: "live-frame" }>): Promise<void> {
    const value = unpack(event.payload) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Rust live-frame envelope");
    const envelope = value as Record<string, unknown>;
    if (typeof envelope.captureId !== "string" || envelope.packet === null || typeof envelope.packet !== "object") throw new Error("Invalid Rust live-frame envelope");
    const session = this._rustSessions.get(envelope.captureId);
    if (!session) return;
    if (this._lastRustFrameSequence !== 0n && event.sequence !== this._lastRustFrameSequence + 1n) {
      await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
      this.pitTracker.reset();
    }
    this._lastRustFrameSequence = event.sequence;
    const packet = envelope.packet as TelemetryPacket;
    packet.gameId = session.gameId;
    const frameTimeMs = Number(event.hostFrameTimeMs);
    if (!Number.isSafeInteger(frameTimeMs)) throw new Error("Rust frame timestamp exceeds safe integer range");
    applyFrameTime(packet, frameTimeMs);
    const adapter = getServerGame(session.gameId);
    if (this.ws.wantsDevTelemetry) this.ws.stageDevTelemetry(structuredClone(packet));
    normalizeTelemetryPacket(packet, adapter.coordSystem === "standard-xyz", adapter.runtime.normSuspensionTravelMm);
    const bestLap = Number(envelope.sessionBestLapTime ?? session.bestLapTime);
    if (adapter.runtime.bestLapFromSession && bestLap > 0) packet.BestLap = bestLap;
    const sectors = this.sectorTracker.feed(packet);
    const pit = this.pitTracker.feed(packet, this.sectorTracker.getTrackLength(), this.sectorTracker.getLapDistStart());
    const liveIssues = this._liveIssuesEnabled ? detectLiveIssues(packet, this.sectorTracker.getTrackLength()) : undefined;
    const projection = this.projector.project({ packet, sessionId: session.sessionId, sectors, pit, liveIssues, receivedAtMs: Date.now() });
    this.ws.publishTelemetry({ packet, sectors, pit, liveIssues, projection });
  }

  async resetBunLiveState(): Promise<void> {
    await this._withIngressPaused(async () => {
      const trackOrdinal = this._rustSession?.trackOrdinal ?? this._lapDetector?.session?.trackOrdinal;
      await this._lapDetector?.finalizeCurrentSession?.();
      await this._finishRecordedSession(this._recordingSession);
      this._lapDetector = null;
      this._lapDetectorGameId = null;
      this._recordingSession = null;
      this._rustSession = null;
      this._rustSessions.clear();
      this._rustLapIds.clear();
      this._sessionLaps = [];
      this._pendingSessionContextFrames = [];
      this._continuingSegment = false;
      this._totalProcessed = 0;
      this.projector = new LiveTelemetryProjector();
      this.sectorTracker = new SectorTracker();
      if (trackOrdinal !== undefined) resetLiveCalibration(trackOrdinal);
      this._broadcastSessionLaps();
    });
  }


  /**
   * Shared telemetry processing pipeline used by every telemetry source.
   *
   * Capture and tracking stay full-rate; WebSocket publication has its own cadence.
   * Stages: record sourceFrame → optional native dev copy → normalize → detector/sector/pit/BestLap → project → publish.
   */
  async processPacket(packet: TelemetryPacket, source?: PacketSourceReference, frameTimeMs?: number): Promise<void> {
    if (getRecordingEngineKind() === "rust") throw new Error("Bun packet ingress is disabled while Rust recorder is selected");
    while (this._ingressBarrier) await this._ingressBarrier;
    const processing = this._processPacket(packet, source, frameTimeMs);
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

    let rawByteOffset: number | undefined;
    const epochBefore = this.recorder.epoch;
    if (source && this.recorder.active) {
      if (Buffer.isBuffer(source)) {
        rawByteOffset = this.recorder.getCurrentByteOffset();
        this.recorder.writeRecord(source, frameTimeMs);
      } else {
        rawByteOffset = source.rawOffset;
      }
    }

    const adapter = getServerGame(packet.gameId);
    if (this.ws.wantsDevTelemetry) {
      this.ws.stageDevTelemetry(structuredClone(packet));
    }

    normalizeTelemetryPacket(packet, adapter.coordSystem === "standard-xyz", adapter.runtime.normSuspensionTravelMm);

    const detector = this._getOrCreateDetector(packet.gameId);
    await detector.feed(packet, rawByteOffset);

    // If feed rotates the session, write the triggering source into the new recorder
    // and patch the detector offset to the canonical source position.
    if (source && this.recorder.active && this.recorder.epoch !== epochBefore) {
      if (Buffer.isBuffer(source)) {
        if (this._pendingSessionContextFrames.length > 0) {
          for (const contextFrame of this._pendingSessionContextFrames) {
            this.recorder.writeRawCaptureBytes(contextFrame);
          }
          this._pendingSessionContextFrames = [];
        }
        const firstOffset = this.recorder.getCurrentByteOffset();
        this.recorder.writeRecord(source, frameTimeMs);
        detector.setCurrentLapByteOffset?.(firstOffset);
      } else {
        detector.setCurrentLapByteOffset?.(source.rawOffset);
      }
    }

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
      if (session?.trackOrdinal) {
        const outline = getTrackOutlineByOrdinal(session.trackOrdinal, session.gameId);
        if (outline) {
          const trackLength = this.sectorTracker.getTrackLength();
          const normalizedProgress =
            Number.isFinite(packet.DistanceTraveled) && Number.isFinite(trackLength) && trackLength > 0
              ? (((packet.DistanceTraveled % trackLength) + trackLength) % trackLength) / trackLength
              : undefined;
          feedCalibrationPosition(session.trackOrdinal, { x: packet.PositionX, z: packet.PositionZ }, packet.LapNumber, outline, normalizedProgress, this._calibrationBoundary ?? undefined);
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
    if (getRecordingEngineKind() === "rust") throw new Error("Bun lap-index ingestion is disabled while Rust recorder is selected");
    this._totalProcessed++;
    let rawByteOffset: number | undefined;
    const epochBefore = this.recorder.epoch;
    if (source && this.recorder.active) {
      if (Buffer.isBuffer(source)) {
        rawByteOffset = this.recorder.getCurrentByteOffset();
        this.recorder.writeRecord(source, frameTimeMs);
      } else {
        rawByteOffset = source.rawOffset;
      }
    }
    const adapter = getServerGame(packet.gameId);
    const telemetryPacket = packet as unknown as TelemetryPacket;
    normalizeTelemetryPacket(telemetryPacket, adapter.coordSystem === "standard-xyz", adapter.runtime.normSuspensionTravelMm);
    const detector = this._getOrCreateDetector(packet.gameId);
    await detector.feed(telemetryPacket, rawByteOffset);
    if (source && this.recorder.active && this.recorder.epoch !== epochBefore) {
      if (Buffer.isBuffer(source)) {
        if (this._pendingSessionContextFrames.length > 0) {
          for (const contextFrame of this._pendingSessionContextFrames) {
            this.recorder.writeRawCaptureBytes(contextFrame);
          }
          this._pendingSessionContextFrames = [];
        }
        const firstOffset = this.recorder.getCurrentByteOffset();
        this.recorder.writeRecord(source, frameTimeMs);
        detector.setCurrentLapByteOffset?.(firstOffset);
      } else {
        detector.setCurrentLapByteOffset?.(source.rawOffset);
      }
    }
  }

  async flushSessionRecorder(): Promise<void> {
    await withSessionCaptureMaintenanceLock(() => this.recorder.stop());
  }

  /**
   * Preserve parser context in imported captures without feeding its stale
   * telemetry values through the lap detector.
   */
  recordSessionContextFrame(sourceFrame: Buffer, completeLapStart = false, frameTimeMs?: number): void {
    if (getRecordingEngineKind() === "rust") throw new Error("Bun capture context writes are disabled while Rust recorder is selected");
    this._expectCompleteLapStart = completeLapStart;
    const contextRecord = Buffer.concat([encodeSegmentContextFrame(), encodeFrameLength(sourceFrame.length, frameTimeMs), sourceFrame, encodeSegmentContextEndFrame()]);
    if (this.recorder.active) {
      this.recorder.writeRawCaptureBytes(contextRecord);
      return;
    }
    this._pendingSessionContextFrames.push(contextRecord);
  }

  /**
   * Drop in-memory ownership of a session deleted through the API.
   * Next packet creates a fresh DB session and capture without restarting game source.
   */
  async recoverDeletedSessions(sessionIds: readonly number[]): Promise<boolean> {
    return this._withIngressPaused(async () => {
      const rustSession = this._rustSession;
      if (rustSession && sessionIds.includes(rustSession.sessionId)) {
        const engine = getRecorderEngine();
        if (!engine) throw new Error("Cannot forget active Rust session: recorder is not registered");
        await engine.request("forget-session", { captureId: rustSession.captureId });
        this._ignoredCaptureIds.add(rustSession.captureId);
        this._rustSessions.delete(rustSession.captureId);
        for (const key of this._rustLapIds.keys()) {
          if (key.startsWith(`${rustSession.captureId}:`)) this._rustLapIds.delete(key);
        }
        this._rustSession = null;
        this._sessionLaps = [];
        this._broadcastSessionLaps();
        return true;
      }
      const activeSessionId = this._lapDetector?.session?.sessionId;
      if (activeSessionId === undefined || !sessionIds.includes(activeSessionId)) return false;

      this._lapDetector = null;
      this._lapDetectorGameId = null;
      this._recordingSession = null;
      this._continuingSegment = false;
      this._pendingSessionContextFrames = [];
      this._sessionLaps = [];
      await withSessionCaptureMaintenanceLock(() => this.recorder.stop());
      this._broadcastSessionLaps();
      return true;
    });
  }

  /** Start next offline capture segment without rotating canonical session. */
  beginSessionSegment(): void {
    if (!this.recorder.active || !this._recordingSession) {
      throw new Error("Cannot begin import segment before a session has started");
    }
    this.recorder.writeSegmentBoundary();
    this._lapDetector = null;
    this._lapDetectorGameId = null;
    this._continuingSegment = true;
  }

  /** Flush buffered writes to disk without closing. */
  flushSessionRecorderBuffer(): void {
    this.recorder.flush();
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

// Wire session laps provider so WS manager can send laps on client connect
wsManager.setSessionLapsProvider(() => _default.sessionLaps);
export const processPacket = (packet: TelemetryPacket, source?: PacketSourceReference, frameTimeMs?: number) => _default.processPacket(packet, source, frameTimeMs);
export function attachRustEngine(engine: RecorderEngine): () => Promise<void> {
  const attachment = attachRecordingEventConsumer(engine, {
    consume: (event) => _default.consumeRustRecordingEvent(event),
    onLiveFrame: (event) => _default.processRustLiveFrame(event),
  });
  return async () => {
    await attachment.detach();
    await _default.resetBunLiveState();
  };
}

export function finalizeResetBunLiveState(): Promise<void> {
  return _default.resetBunLiveState();
}

/** Returns the current lap detector (may be null before the first packet is processed). */
export const lapDetector = {
  get session() {
    return _default.currentSession;
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
