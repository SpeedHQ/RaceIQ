export type PacketSourceReference = Buffer | { rawOffset: number };
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import {
  type DbAdapter,
  type WsAdapter,
  type SessionRecorderAdapter,
  RealDbAdapter,
  RealSessionRecorderAdapter,
} from "./pipeline-ports";
import { LiveTelemetryProjector } from "./live-projector";
import type { ILapDetector, LapDetectorCallbacks } from "../lap-detection/types";
import { SectorTracker } from "../live-strategy/sector-tracker";
import { PitTracker } from "../live-strategy/pit-tracker";
import { feedCalibrationPosition, resetLiveCalibration } from "../tracks/calibration";
import { getTrackOutlineByOrdinal } from "../../shared/racing/tracks/recording/outlines";
import { getTrackBoundariesByOrdinal } from "../../shared/racing/tracks/geometry/extracted";
import type { TrackBoundary } from "../../shared/racing/tracks/geometry/types";
import { getServerGame } from "../games/registry";
import { normalizeTelemetryPacket } from "./normalization";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import { detectCorners } from "../lap-analysis/corners"
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { symptomsToIssues, detectLiveIssues } from "../ai/tune-issues";
import { reconcileSessionResult } from "../race-results/reconcile";
import { wsManager } from "../runtime/websocket-manager";
import { withSessionCaptureMaintenanceLock } from "../session-capture/cleanup";

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
  /** Issues computed in onLapComplete (has packets, no lapId yet), consumed in
   *  onLapSaved (has lapId/lapNumber, no packets) to build the "lap-issues" push. */
  private _pendingLapIssues: TuneIssue[] | null = null;
  private _recordingSession: { sessionId: number; gameId: GameId } | null = null;
  private _onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
  private _finalizedResultSessions = new Set<number>();
  private _lapReconciliations = new Map<number, Promise<void>>();
  private _resultFinalizations = new Map<number, Promise<void>>();
  private _calibrationBoundary: TrackBoundary | null = null;

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
    return this.recorder.active;
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
    this.recorder = options?.recorder ?? new RealSessionRecorderAdapter();
    this._bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
    this._skipHistorySeeding = options?.skipHistorySeeding ?? false;
    this._skipDevState = options?.skipDevState ?? false;
    this._onSessionFinalized = options?.onSessionFinalized;
  }

  private _scheduleLapReconciliation(sessionId: number, gameId: GameId): void {
    const reconcile = this._onSessionFinalized;
    if (!reconcile) return;
    const previous = this._lapReconciliations.get(sessionId) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous
      .catch(() => {})
      .then(() => reconcile(sessionId, gameId))
      .catch((error) => {
        console.error(`[Race Results] Failed to reconcile session ${sessionId}:`, error);
      })
      .finally(() => {
        if (this._lapReconciliations.get(sessionId) === current) {
          this._lapReconciliations.delete(sessionId);
        }
      });
    this._lapReconciliations.set(sessionId, current);
  }

  private async _drainLapReconciliations(sessionId: number): Promise<void> {
    await this._lapReconciliations.get(sessionId);
  }

  private _reconcileRecordedSession(
    session: { sessionId: number; gameId: GameId },
  ): Promise<void> {
    if (this._finalizedResultSessions.has(session.sessionId)) {
      return Promise.resolve();
    }
    const pending = this._resultFinalizations.get(session.sessionId);
    if (pending) return pending;
    const finalization = (async () => {
      await this._drainLapReconciliations(session.sessionId);
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

  private async _finishRecordedSession(
    session = this._recordingSession,
  ): Promise<void> {
    await withSessionCaptureMaintenanceLock(async () => {
      if (session && this._recordingSession?.sessionId === session.sessionId) {
        this._recordingSession = null;
      }
      await this.recorder.stop();
    });
    if (session) await this._reconcileRecordedSession(session);
  }

  private _buildCallbacks(): LapDetectorCallbacks {
    return {
      onSessionStart: async (session) => {
        const previousSession = this._recordingSession;
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
              session.sessionId,
              this.recorder.path,
              this._lapDetector?.detectorId ?? LAP_DETECTOR_ID,
            );
          }
        });
        if (previousSession) {
          void this._reconcileRecordedSession(previousSession).catch((error) => {
            console.error(
              `[Race Results] Failed to reconcile session ${previousSession.sessionId}:`,
              error,
            );
          });
        }

        resetLiveCalibration(session.trackOrdinal);
        this._calibrationBoundary = getTrackBoundariesByOrdinal(session.trackOrdinal, session.gameId);

        await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
        this.pitTracker.reset();
        const adapter = getServerGame(session.gameId);
        this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
        if (!this._skipHistorySeeding) {
          await this.pitTracker.seedFromHistory(
            session.trackOrdinal,
            session.carOrdinal,
            session.carPI,
            session.gameId,
            adapter.runtime.pit,
          );
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

          // Live Tuning Dashboard per-lap issue feed. Computed here (packets are
          // available) but pushed from onLapSaved (lapId/lapNumber are available
          // there) — onLapComplete always fires synchronously before onLapSaved
          // for the same lap, so this hand-off is safe.
          try {
            const corners = detectCorners(event.packets);
            const symptoms = telemetryToSymptoms(event.packets, corners);
            this._pendingLapIssues = symptomsToIssues(symptoms);
          } catch {
            this._pendingLapIssues = null;
          }
        } else {
          this._pendingLapIssues = null;
        }
      },

      onLapSaved: (event) => {
        this.ws.broadcastNotification({ type: "lap-saved", ...event });

        // Flush the per-lap issue feed computed in onLapComplete, now that we
        // have lapId/lapNumber to stamp on it.
        if (this._pendingLapIssues) {
          const issues = this._pendingLapIssues.map((i) => ({ ...i, lapNumber: event.lapNumber }));
          this._pendingLapIssues = null;
          this.ws.broadcastNotification({ type: "lap-issues", lapId: event.lapId, lapNumber: event.lapNumber, issues });
        }

        // Append to in-memory list and broadcast
        const session = this._lapDetector?.session ?? null;
        if (session) {
          this._scheduleLapReconciliation(session.sessionId, session.gameId);
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
            this._sessionLaps.splice(
              0,
              this._sessionLaps.length - CURRENT_SESSION_LAP_SNAPSHOT_LIMIT,
            );
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

  /** Finalize detector, durable capture, then authoritative session result. */
  async finalizeCurrentSession(): Promise<void> {
    const session = this._recordingSession;
    await this._lapDetector?.finalizeCurrentSession?.();
    await this._finishRecordedSession(session);
  }

  /** Detect game-specific stale finalization and finish its durable capture. */
  async flushStaleSession(): Promise<void> {
    const session = this._recordingSession;
    await this._lapDetector?.flushStaleLap?.();
    if (session && !this._lapDetector?.session) {
      await this._finishRecordedSession(session);
    }
  }

  /** Seed in-memory session laps from DB (called once on session start). */
  private async _seedSessionLaps(
    sessionId: number,
    trackOrdinal: number,
    carOrdinal: number,
    gameId: GameId
  ): Promise<void> {
    try {
      const allLaps = await this.db.getLaps(gameId, CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
      const sessionLaps = allLaps
        .filter(
          (l) => l.sessionId === sessionId && l.trackOrdinal === trackOrdinal && l.carOrdinal === carOrdinal,
        )
        .sort((a, b) => a.id - b.id);
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
   * Stages: normalize coords → lap detection → track calibration (~10Hz) → WebSocket broadcast (30Hz)
   * Stages: record sourceFrame → optional native dev copy → normalize → detector/sector/pit/BestLap → project → publish.
   */
  async processPacket(packet: TelemetryPacket, source?: PacketSourceReference): Promise<void> {
    this._totalProcessed++;

    let rawByteOffset: number | undefined;
    const epochBefore = this.recorder.epoch;
    if (source && this.recorder.active) {
      if (Buffer.isBuffer(source)) {
        rawByteOffset = this.recorder.getCurrentByteOffset();
        this.recorder.writeRecord(source);
      } else {
        rawByteOffset = source.rawOffset;
      }
    }

    const adapter = getServerGame(packet.gameId);
    if (this.ws.wantsDevTelemetry) {
      this.ws.stageDevTelemetry(structuredClone(packet));
    }

    normalizeTelemetryPacket(
      packet,
      adapter.coordSystem === "standard-xyz",
      adapter.runtime.normSuspensionTravelMm,
    );

    const detector = this._getOrCreateDetector(packet.gameId);
    await detector.feed(packet, rawByteOffset);

    if (source && this.recorder.active && this.recorder.epoch !== epochBefore) {
      if (Buffer.isBuffer(source)) {
        const firstOffset = this.recorder.getCurrentByteOffset();
        this.recorder.writeRecord(source);
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

    const pit = this.pitTracker.feed(
      packet,
      this.sectorTracker.getTrackLength(),
      this.sectorTracker.getLapDistStart()
    );

    // Collect calibration positions for adapters that require track-outline alignment.
    if (this._totalProcessed % 6 === 0 && adapter.runtime.requiresTrackCalibration) {
      const session = detector.session;
      if (session?.trackOrdinal) {
        const outline = getTrackOutlineByOrdinal(session.trackOrdinal, session.gameId);
        if (outline) {
          const trackLength = this.sectorTracker.getTrackLength();
          const normalizedProgress = Number.isFinite(packet.DistanceTraveled) &&
            Number.isFinite(trackLength) && trackLength > 0
            ? ((packet.DistanceTraveled % trackLength) + trackLength) % trackLength / trackLength
            : undefined;
          feedCalibrationPosition(
            session.trackOrdinal,
            { x: packet.PositionX, z: packet.PositionZ },
            packet.LapNumber,
            outline,
            normalizedProgress,
            this._calibrationBoundary ?? undefined
          );
        }
      }
    }

    // Live Tuning Dashboard transient detector — gated, off by default. Stateless
    // per-packet call; skipped entirely (no cost) unless the client opted in.
    const liveIssues = this._liveIssuesEnabled
      ? detectLiveIssues(packet, this.sectorTracker.getTrackLength())
      : undefined;

    const projection = this.projector.project({
      packet,
      sessionId: detector.session?.sessionId,
      sectors,
      pit,
      liveIssues,
      receivedAtMs: Date.now(),
    });
    this.ws.publishTelemetry({ packet, sectors, pit, liveIssues, projection });

    if (!this._skipDevState) {
      this.ws.broadcastDevState({
        lapDetector: detector.getDebugState?.() ?? {},
        sectorTracker: this.sectorTracker.getDebugState(),
        pitTracker: this.pitTracker.getDebugState(),
      });
    }
  }

  async flushSessionRecorder(): Promise<void> {
    await withSessionCaptureMaintenanceLock(() => this.recorder.stop());
  }

  /** Flush buffered writes to disk without closing. */
  flushSessionRecorderBuffer(): void {
    this.recorder.flush();
  }
}

// Module-level pipeline used by live runtime callers.
const _defaultWs: WsAdapter = {
  get wantsDevTelemetry() { return wsManager.wantsDevTelemetry; },
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
      console.error(
        `[Race Results] Failed to reconcile session ${sessionId}:`,
        error,
      );
    }
  },
});

// Wire session laps provider so WS manager can send laps on client connect
wsManager.setSessionLapsProvider(() => _default.sessionLaps);
export const processPacket = (packet: TelemetryPacket, source?: PacketSourceReference) =>
  _default.processPacket(packet, source);

/** Returns the current lap detector (may be null before the first packet is processed). */
export const lapDetector = {
  get session() { return _default.lapDetector?.session ?? null; },
  get fuelHistory() { return _default.lapDetector?.fuelHistory ?? []; },
  get tireWearHistory() { return _default.lapDetector?.tireWearHistory ?? []; },
  async finalizeCurrentSession() { await _default.finalizeCurrentSession(); },
};


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
