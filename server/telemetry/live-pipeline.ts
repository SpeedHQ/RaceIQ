import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import { isEligibilityUsable } from "../../shared/racing/quality/policies";
import {
  LOCAL_PLAYER_EVIDENCE,
  type ArchiveVerification,
  type EligibilityDecision,
  type EligibilityDecisionSet,
  type EvidenceSourceKind,
  type SourceChannelProfile,
  type SourceLifecycleEvidence,
} from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { type DbAdapter, type WsAdapter, type SessionRecorderAdapter, currentTelemetryVersionIdentity, RealDbAdapter, RealSessionRecorderAdapter } from "./pipeline-ports";
import { LiveTelemetryProjector } from "./live-projector";
import type { ILapDetector, LapDetectorCallbacks } from "../lap-detection/types";
import { SectorTracker } from "../live-strategy/sector-tracker";
import { PitTracker } from "../live-strategy/pit-tracker";
import { feedCalibrationPosition } from "../tracks/calibration";
import { getTrackOutlineByOrdinal } from "../../shared/racing/tracks/recording/outlines";
import { getServerGame } from "../games/registry";
import { normalizeTelemetryPacket } from "./normalization";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import { detectCorners } from "../lap-analysis/corners";
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { symptomsToIssues, detectLiveIssues } from "../ai/tune-issues";
import { reconcileSessionResult } from "../race-results/reconcile";
import { wsManager } from "../runtime/websocket-manager";
import { withSessionCaptureMaintenanceLock } from "../session-capture/cleanup";

const CURRENT_SESSION_LAP_SNAPSHOT_LIMIT = 500;
export function resolveLapIssueEligibility(eligibility: EligibilityDecisionSet): EligibilityDecision {
  return [eligibility["normal-pace"], eligibility["corner-trace"], eligibility["transient-event"]].find((decision) => !isEligibilityUsable(decision)) ?? eligibility["transient-event"];
}

export interface LiveSourceScope {
  kind: "udp";
  gameId: GameId;
  sessionId: number;
}

interface RecordingSessionState {
  sessionId: number;
  gameId: GameId;
  detector: ILapDetector;
}

interface ClosedRecordingSession {
  session: RecordingSessionState;
  qualityAccumulator: RecordingQualityAccumulator | null;
  sourceVerification: ArchiveVerification;
  transportVerification?: ArchiveVerification;
  canonicalVerification?: ArchiveVerification;
}

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
  private readonly _sourceKind: EvidenceSourceKind;
  private readonly _versionIdentity?: TelemetryVersionIdentity;
  private readonly _sourceChannelProfile?: SourceChannelProfile;
  private readonly _sourceArchiveVerification?: ArchiveVerification;
  private readonly _sourceTransportVerification?: ArchiveVerification;
  private projector = new LiveTelemetryProjector();
  private _sessionLaps: LapMeta[] = [];
  /** Live Tuning Dashboard: gates the per-packet transient issue detector.
   *  Off by default — client opts in via `POST /api/live-analysis`. */
  private _liveIssuesEnabled = false;
  /** Issues computed in onLapComplete (has packets, no lapId yet), consumed in
   *  onLapSaved (has lapId/lapNumber, no packets) to build the "lap-issues" push. */
  private _pendingLapIssues: TuneIssue[] | null = null;
  private _pendingLapIssueEligibility: EligibilityDecision | null = null;
  private _recordingSession: RecordingSessionState | null = null;
  private _recordingQuality: RecordingQualityAccumulator | null = null;
  private _onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
  private _finalizedResultSessions = new Set<number>();
  private _lapReconciliations = new Map<number, Promise<void>>();
  private _resultFinalizations = new Map<number, Promise<void>>();

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
  noteSourceLifecycle(event: SourceLifecycleEvidence, source?: LiveSourceScope): void {
    if ((event.kind === "timeout" || event.kind === "reconnect") && (!source || this._recordingSession?.gameId !== source.gameId || this._recordingSession?.sessionId !== source.sessionId)) {
      return;
    }
    this._recordingQuality?.noteSourceLifecycle(event);
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
      sourceKind?: EvidenceSourceKind;
      sourceArchiveVerification?: ArchiveVerification;
      sourceTransportVerification?: ArchiveVerification;
      versionIdentity?: TelemetryVersionIdentity;
      sourceChannelProfile?: SourceChannelProfile;
    },
  ) {
    this.db = db;
    this.ws = ws;
    this.recorder = options?.recorder ?? new RealSessionRecorderAdapter();
    this._bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
    this._skipHistorySeeding = options?.skipHistorySeeding ?? false;
    this._skipDevState = options?.skipDevState ?? false;
    this._onSessionFinalized = options?.onSessionFinalized;
    this._sourceKind = options?.sourceKind ?? "native-live";
    this._versionIdentity = options?.versionIdentity;
    this._sourceChannelProfile = options?.sourceChannelProfile;
    this._sourceArchiveVerification = options?.sourceArchiveVerification;
    this._sourceTransportVerification = options?.sourceTransportVerification;
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

  private _reconcileRecordedSession(session: { sessionId: number; gameId: GameId }): Promise<void> {
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

  private async _closeRecordedSession(session: RecordingSessionState): Promise<ClosedRecordingSession> {
    const isCurrentSession = this._recordingSession?.sessionId === session.sessionId;
    const qualityAccumulator = isCurrentSession ? this._recordingQuality : null;
    if (isCurrentSession) {
      this._recordingSession = null;
      this._recordingQuality = null;
    }

    let canonicalVerification: ArchiveVerification;
    try {
      canonicalVerification = await this.recorder.stop();
    } catch (error) {
      qualityAccumulator?.noteWriterFailure(error);
      canonicalVerification = {
        state: "corrupt" as const,
        sourceGeneration: null,
        details: error instanceof Error ? error.message : String(error),
      };
    }
    const hasOriginalSourceVerification = this._sourceArchiveVerification !== undefined;
    return {
      session,
      qualityAccumulator,
      sourceVerification: this._sourceArchiveVerification ?? canonicalVerification,
      ...(this._sourceTransportVerification ? { transportVerification: this._sourceTransportVerification } : {}),
      ...(hasOriginalSourceVerification ? { canonicalVerification } : {}),
    };
  }

  private async _finalizeRecordedSession(closed: ClosedRecordingSession, endReason: string): Promise<void> {
    await closed.session.detector.waitForPendingLapWrites?.();
    if (closed.qualityAccumulator) {
      const summary = closed.qualityAccumulator.finalize(endReason, closed.sourceVerification, {
        transportVerification: closed.transportVerification,
        canonicalVerification: closed.canonicalVerification,
      });
      const finalized = await this.db.updateSessionQuality(closed.session.sessionId, summary);
      await this._refreshFinalizedSessionLaps(closed.session.sessionId, closed.session.gameId);
      this.ws.broadcastNotification({
        type: "quality-updated",
        sessionId: closed.session.sessionId,
        qualityGeneration: finalized.provenance.outputGeneration,
      });
    }
    await this._reconcileRecordedSession(closed.session);
  }

  private async _finishRecordedSession(session = this._recordingSession, endReason = "session-ended"): Promise<void> {
    const closed = await withSessionCaptureMaintenanceLock(async () => {
      if (!session) {
        await this.recorder.stop();
        return null;
      }
      return this._closeRecordedSession(session);
    });
    if (closed) await this._finalizeRecordedSession(closed, endReason);
  }

  private _buildCallbacks(): LapDetectorCallbacks {
    return {
      onSessionStart: async (session) => {
        const closedPrevious = await withSessionCaptureMaintenanceLock(async () => {
          const previousSession = this._recordingSession;
          const closed = previousSession
            ? await this._closeRecordedSession(previousSession)
            : (await this.recorder.stop(), null);

          this._pendingLapIssues = null;
          this._pendingLapIssueEligibility = null;
          this.recorder.start(session.gameId);
          this.recorder.writeMetaFrame();
          this._recordingSession = {
            sessionId: session.sessionId,
            gameId: session.gameId,
            detector: this._lapDetector!,
          };
          this._recordingQuality = new RecordingQualityAccumulator(
            this._sourceKind,
            LOCAL_PLAYER_EVIDENCE,
            this._versionIdentity ?? currentTelemetryVersionIdentity(session.gameId),
          );
          if (this.recorder.path) {
            await this.db.updateSessionRawFile(
              session.sessionId,
              this.recorder.path,
              this._lapDetector?.detectorId ?? LAP_DETECTOR_ID,
            );
          }
          return closed;
        });

        await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
        this.pitTracker.reset();
        const adapter = getServerGame(session.gameId);
        this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
        if (!this._skipHistorySeeding) {
          await this.pitTracker.seedFromHistory(session.trackOrdinal, session.carOrdinal, session.carPI, session.gameId, adapter.runtime.pit);
          await this._seedSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
        } else {
          this._sessionLaps = [];
        }
        this._broadcastSessionLaps();

        if (closedPrevious) {
          await this._finalizeRecordedSession(closedPrevious, "session-rotated");
        }
      },

      onLapComplete: (event) => {
        this.pitTracker.acceptCompletedLap(event.eligibility);
        const issueEligibility = resolveLapIssueEligibility(event.eligibility);
        this._pendingLapIssueEligibility = issueEligibility;
        const normalPaceUsable = isEligibilityUsable(event.eligibility["normal-pace"]);
        if (normalPaceUsable) {
          this.sectorTracker.updateRefLap(event.packets, event.lapTime, event.sectors);
        }

        const session = this._lapDetector?.session ?? null;
        if (session && isEligibilityUsable(event.eligibility["tire-analysis"]) && getServerGame(session.gameId).runtime.pit.useDistanceBasedWearCurves) {
          this.pitTracker.updateWearCurves(event.packets, event.lapDistStart);
        }

        if (isEligibilityUsable(issueEligibility)) {
          try {
            const corners = detectCorners(event.packets);
            const symptoms = telemetryToSymptoms(event.packets, corners);
            this._pendingLapIssues = symptomsToIssues(symptoms);
          } catch {
            this._pendingLapIssues = null;
          }
        } else {
          this._pendingLapIssues = [];
        }
      },

      onLapSaved: (event) => {
        this.ws.broadcastNotification({ type: "lap-saved", ...event });

        // Flush the per-lap issue feed computed in onLapComplete, now that we
        // have lapId/lapNumber to stamp on it. Blocked analyses still publish
        // their versioned decision so clients never mistake unavailable evidence
        // for a clean lap.
        if (this._pendingLapIssueEligibility) {
          const issues = (this._pendingLapIssues ?? []).map((issue) => ({ ...issue, lapNumber: event.lapNumber }));
          this.ws.broadcastNotification({
            type: "lap-issues",
            lapId: event.lapId,
            lapNumber: event.lapNumber,
            issues,
            eligibility: this._pendingLapIssueEligibility,
          });
          this._pendingLapIssues = null;
          this._pendingLapIssueEligibility = null;
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
            phase: event.phase,
            conditions: event.conditions,
            paceEligibility: event.paceEligibility,
            createdAt: new Date().toISOString(),
            gameId: session.gameId,
            carOrdinal: session.carOrdinal,
            trackOrdinal: session.trackOrdinal,
            sectorTimes: event.sectors ?? undefined,
            source: event.quality.sourceKind,
            quality: event.quality,
            eligibility: event.eligibility,
            qualityGeneration: event.quality.provenance.outputGeneration,
            qualityStale: event.quality.provenance.outputGeneration === "legacy",
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
        sourceKind: this._sourceKind,
        sourceChannelProfile: this._sourceChannelProfile,
        versionIdentity: this._versionIdentity,
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

  private async _refreshFinalizedSessionLaps(sessionId: number, gameId: GameId): Promise<void> {
    if (!this._sessionLaps.some((lap) => lap.sessionId === sessionId)) return;

    const persisted = await this.db.getLaps(gameId, CURRENT_SESSION_LAP_SNAPSHOT_LIMIT);
    const finalizedById = new Map(persisted.filter((lap) => lap.sessionId === sessionId).map((lap) => [lap.id, lap]));
    let replaced = false;
    this._sessionLaps = this._sessionLaps.map((lap) => {
      const finalized = lap.sessionId === sessionId ? finalizedById.get(lap.id) : undefined;
      if (!finalized) return lap;
      replaced = true;
      return finalized;
    });
    if (replaced) this._broadcastSessionLaps();
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
  async processPacket(packet: TelemetryPacket, sourceFrame?: Buffer): Promise<void> {
    this._totalProcessed++;

    // Snapshot byte offset BEFORE writing so it points to this packet's position
    let rawByteOffset: number | undefined;
    const epochBefore = this.recorder.epoch;
    if (sourceFrame && this.recorder.active) {
      rawByteOffset = this.recorder.getCurrentByteOffset();
      try {
        this.recorder.writeRecord(sourceFrame);
      } catch (error) {
        rawByteOffset = undefined;
        this._recordingQuality?.noteWriterFailure(error);
      }
    }

    const adapter = getServerGame(packet.gameId);
    if (this.ws.wantsDevTelemetry) {
      // Clone parser-native values before any in-place normalization/derivation.
      this.ws.stageDevTelemetry(structuredClone(packet));
    }

    // Normalize coordinates and derived channels using the adapter profile.
    normalizeTelemetryPacket(packet, adapter.coordSystem === "standard-xyz", adapter.runtime.normSuspensionTravelMm);

    const detector = this._getOrCreateDetector(packet.gameId);
    await detector.feed(packet, rawByteOffset);

    // If a new session was created during feed — either the very first
    // session (recorder was null) or a rotation (car-changed, etc.) — the
    // triggering packet was written to the PREVIOUS recorder (or not at all).
    // Catch up: write it to the NEW recorder as lap 1's first frame and patch
    // the detector's lap byte offset so the DB row points at the right place.
    if (sourceFrame && this.recorder.active && this.recorder.epoch !== epochBefore) {
      const firstOffset = this.recorder.getCurrentByteOffset();
      try {
        this.recorder.writeRecord(sourceFrame);
        detector.setCurrentLapByteOffset?.(firstOffset);
      } catch (error) {
        this._recordingQuality?.noteWriterFailure(error);
      }
    }
    this._recordingQuality?.observe(packet);

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
          feedCalibrationPosition(session.trackOrdinal, { x: packet.PositionX, z: packet.PositionZ }, packet.LapNumber, outline);
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

    if (!this._skipDevState) {
      this.ws.broadcastDevState({
        lapDetector: detector.getDebugState?.() ?? {},
        sectorTracker: this.sectorTracker.getDebugState(),
        pitTracker: this.pitTracker.getDebugState(),
      });
    }
  }

  async flushSessionRecorder(): Promise<void> {
    await this._finishRecordedSession(this._recordingSession, "stream-ended");
  }

  /** Flush buffered writes to disk without closing. */
  flushSessionRecorderBuffer(): void {
    this.recorder.flush();
  }
}

// Module-level pipeline used by live runtime callers.
const _defaultWs: WsAdapter = {
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

export const processPacket = (packet: TelemetryPacket, sourceFrame?: Buffer) => _default.processPacket(packet, sourceFrame);

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
  async finalizeCurrentSession() {
    await _default.finalizeCurrentSession();
  },
};
export function noteSourceLifecycle(event: SourceLifecycleEvidence, source?: LiveSourceScope): void {
  _default.noteSourceLifecycle(event, source);
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
