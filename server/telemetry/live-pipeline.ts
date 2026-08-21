import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import type { RaceEvent } from "../../shared/racing/events/contracts";
import { isEligibilityUsable } from "../../shared/racing/quality/policies";
import {
  LOCAL_PLAYER_EVIDENCE,
  type ArchiveVerification,
  type EligibilityDecision,
  type EligibilityDecisionSet,
  type EvidenceSourceKind,
  type ParticipantEvidence,
  type SourceChannelProfile,
  type RecordingQualitySummary,
  type SourceLifecycleEvidence,
} from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { packetSequences, SourceSequenceTracker } from "../../shared/telemetry/source-sequence";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import {
  type DbAdapter,
  type RaceEventPublisher,
  type WsAdapter,
  type SessionRecorderAdapter,
  currentTelemetryVersionIdentity,
  RealDbAdapter,
  RealSessionRecorderAdapter,
  WsRaceEventPublisher,
} from "./pipeline-ports";
import { LiveTelemetryProjector } from "./live-projector";
import type { ILapDetector, LapDetectorCallbacks, SessionEndReason } from "../lap-detection/types";
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
import { RaceEventCoordinator } from "../race-events/coordinator";
import type { RaceEventPreflightResult } from "../race-events/types";
import { compareRaceEvents, DatabaseRaceEventStore, MemoryRaceEventStore, type RaceEventLapLink, type RaceEventStore } from "../race-events/store";
import type { SessionBoundaryReason } from "../lap-detection/boundaries";

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
  finalizedQuality?: RecordingQualitySummary;
  closureEvents: RaceEvent[];
}
interface PendingLapIssueEvaluation {
  issues: TuneIssue[] | null;
  eligibility: EligibilityDecision;
}

interface PendingTimelineLapBatch {
  events: RaceEvent[];
  prior: Promise<void>;
  release: () => void;
  settled: Promise<void>;
  settle: () => void;
}

interface FailedTimelineBatch {
  events: RaceEvent[];
  lapLinks: RaceEventLapLink[];
  afterPersist?: () => Promise<void>;
  persisted: boolean;
}

interface PendingSessionFinalization {
  closed: ClosedRecordingSession;
  endReason: string;
}
interface CaptureFinalizationResult {
  finalization: Promise<void> | null;
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
  private readonly raceEvents: RaceEventCoordinator;
  private readonly raceEventStore: RaceEventStore;
  private readonly raceEventPublisher: RaceEventPublisher;
  private _bypassPacketRateFilter: boolean;
  private _skipHistorySeeding: boolean;
  private _skipDevState: boolean;
  private readonly _sourceKind: EvidenceSourceKind;
  private readonly _participant: ParticipantEvidence;
  private readonly _versionIdentity?: TelemetryVersionIdentity;
  private readonly _sourceChannelProfile?: SourceChannelProfile;
  private readonly _sourceArchiveVerification?: ArchiveVerification;
  private readonly _sourceTransportVerification?: ArchiveVerification;
  private projector = new LiveTelemetryProjector();
  private _sessionLaps: LapMeta[] = [];
  /** Live Tuning Dashboard: gates the per-packet transient issue detector.
   *  Off by default — client opts in via `POST /api/live-analysis`. */
  private _liveIssuesEnabled = false;
  /** Per-lap issues computed while packet evidence is available, then consumed after persistence. */
  private readonly _pendingLapIssues = new Map<string, PendingLapIssueEvaluation>();
  private _recordingSession: RecordingSessionState | null = null;
  private _recordingQuality: RecordingQualityAccumulator | null = null;
  private _onSessionFinalized?: (sessionId: number, gameId: GameId) => Promise<void>;
  private _finalizedResultSessions = new Set<number>();
  private _lapReconciliations = new Map<number, Promise<void>>();
  private _resultFinalizations = new Map<number, Promise<void>>();
  private _captureOperationQueue = Promise.resolve();
  private _timelinePersistenceQueue = Promise.resolve();
  private readonly _sessionFinalizations = new Map<number, Promise<void>>();
  private readonly _pendingSessionFinalizations = new Map<number, PendingSessionFinalization>();
  private _timelineSourceSequence = new SourceSequenceTracker();
  private _pendingTimelinePreflight: RaceEventPreflightResult | null = null;
  private _timelineEventsStaged = false;
  private readonly _stagedTimelineEvents: RaceEvent[] = [];
  private readonly _stagedTimelineLapLinks: RaceEventLapLink[] = [];
  private readonly _stagedLapSavedActions: Array<() => Promise<void>> = [];
  private readonly _pendingTimelineLapBatches = new Map<string, PendingTimelineLapBatch>();
  private readonly _failedTimelineBatches: FailedTimelineBatch[] = [];
  private _lastTimelinePacket: TelemetryPacket | null = null;

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
  noteSourceLifecycle(event: SourceLifecycleEvidence, source?: LiveSourceScope): Promise<void> {
    return this._enqueueCaptureOperation(async () => {
      if ((event.kind === "timeout" || event.kind === "reconnect") && (!source || this._recordingSession?.gameId !== source.gameId || this._recordingSession?.sessionId !== source.sessionId)) {
        return;
      }
      this._recordingQuality?.noteSourceLifecycle(event);
      if (event.kind === "reconnect") this._timelineSourceSequence.markDiscontinuity();
      await this._persistTimelineEvents(this.raceEvents.noteSourceLifecycle(event, source?.sessionId));
    });
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
      participant?: ParticipantEvidence;
      sourceArchiveVerification?: ArchiveVerification;
      sourceTransportVerification?: ArchiveVerification;
      versionIdentity?: TelemetryVersionIdentity;
      sourceChannelProfile?: SourceChannelProfile;
      raceEventCoordinator?: RaceEventCoordinator;
      raceEventStore?: RaceEventStore;
      raceEventPublisher?: RaceEventPublisher;
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
    this._participant = options?.participant ?? LOCAL_PLAYER_EVIDENCE;
    this._versionIdentity = options?.versionIdentity;
    this._sourceChannelProfile = options?.sourceChannelProfile;
    this._sourceArchiveVerification = options?.sourceArchiveVerification;
    this._sourceTransportVerification = options?.sourceTransportVerification;
    this.raceEvents =
      options?.raceEventCoordinator ??
      new RaceEventCoordinator({
        sourceKind: this._sourceKind,
      });
    this.raceEventStore = options?.raceEventStore ?? new MemoryRaceEventStore();
    this.raceEventPublisher = options?.raceEventPublisher ?? new WsRaceEventPublisher(ws);
  }

  private _enqueueCaptureOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this._captureOperationQueue;
    let release!: () => void;
    this._captureOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  private _enqueueTimelinePersistence<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this._timelinePersistenceQueue.catch(() => {});
    const { promise, resolve } = Promise.withResolvers<void>();
    this._timelinePersistenceQueue = promise;
    return previous.then(operation).finally(resolve);
  }

  private _reserveTimelinePosition(): { prior: Promise<void>; release: () => void } {
    const prior = this._timelinePersistenceQueue.catch(() => {});
    const { promise, resolve } = Promise.withResolvers<void>();
    this._timelinePersistenceQueue = promise;
    return { prior, release: resolve };
  }

  private _persistTimelineEvents(events: readonly RaceEvent[], lapLinks: readonly RaceEventLapLink[] = []): Promise<RaceEvent[]> {
    return this._enqueueTimelinePersistence(() => this._persistTimelineEventsCore(events, lapLinks));
  }

  private _queueFailedTimelineBatch(
    events: readonly RaceEvent[],
    lapLinks: readonly RaceEventLapLink[],
    afterPersist: (() => Promise<void>) | undefined,
    persisted: boolean,
  ): void {
    const queuedEvents = [...events];
    for (let index = 1; index < queuedEvents.length; index++) {
      if (compareRaceEvents(queuedEvents[index - 1]!, queuedEvents[index]!) > 0) {
        queuedEvents.sort(compareRaceEvents);
        break;
      }
    }
    const batch: FailedTimelineBatch = {
      events: queuedEvents,
      lapLinks: [...lapLinks],
      ...(afterPersist ? { afterPersist } : {}),
      persisted,
    };
    const first = queuedEvents[0];
    if (!first) {
      this._failedTimelineBatches.push(batch);
      return;
    }
    let insertionIndex = this._failedTimelineBatches.length;
    while (insertionIndex > 0) {
      const previous = this._failedTimelineBatches[insertionIndex - 1]!.events[0];
      if (!previous || compareRaceEvents(previous, first) <= 0) break;
      insertionIndex -= 1;
    }
    this._failedTimelineBatches.splice(insertionIndex, 0, batch);
  }

  private async _drainFailedTimelineBatches(): Promise<RaceEvent[]> {
    const inserted: RaceEvent[] = [];
    while (this._failedTimelineBatches.length > 0) {
      const batch = this._failedTimelineBatches[0]!;
      if (!batch.persisted) {
        inserted.push(...await this._appendTimelineEvents(batch.events, batch.lapLinks));
        batch.persisted = true;
      }
      await batch.afterPersist?.();
      this._failedTimelineBatches.shift();
    }
    return inserted;
  }

  private async _persistTimelineEventsCore(
    events: readonly RaceEvent[],
    lapLinks: readonly RaceEventLapLink[] = [],
    afterPersist?: () => Promise<void>,
  ): Promise<RaceEvent[]> {
    if (this._failedTimelineBatches.length > 0) {
      if (events.length > 0 || lapLinks.length > 0 || afterPersist) {
        this._queueFailedTimelineBatch(events, lapLinks, afterPersist, false);
      }
      return this._drainFailedTimelineBatches();
    }

    let inserted: RaceEvent[];
    try {
      inserted = await this._appendTimelineEvents(events, lapLinks);
    } catch (error) {
      this._queueFailedTimelineBatch(events, lapLinks, afterPersist, false);
      throw error;
    }
    try {
      await afterPersist?.();
    } catch (error) {
      this._queueFailedTimelineBatch(events, lapLinks, afterPersist, true);
      throw error;
    }
    return inserted;
  }

  private async _appendTimelineEvents(events: readonly RaceEvent[], lapLinks: readonly RaceEventLapLink[]): Promise<RaceEvent[]> {
    if (events.length === 0) return [];
    let ordered = events;
    for (let index = 1; index < events.length; index++) {
      if (compareRaceEvents(events[index - 1]!, events[index]!) > 0) {
        ordered = [...events].sort(compareRaceEvents);
        break;
      }
    }
    let inserted: RaceEvent[];
    try {
      inserted = lapLinks.length > 0
        ? await this.raceEventStore.appendWithLapLinks(ordered, lapLinks)
        : await this.raceEventStore.append(ordered);
    } catch (error) {
      throw new Error(`Failed to persist race events: ${ordered.map(({ eventType }) => eventType).join(", ")}`, { cause: error });
    }
    const bySession = new Map<number, RaceEvent[]>();
    for (const event of inserted) {
      const values = bySession.get(event.sessionId);
      if (values) values.push(event);
      else bySession.set(event.sessionId, [event]);
    }
    for (const [sessionId, values] of bySession) {
      this.raceEventPublisher.publishAppended(sessionId, values);
    }
    return inserted;
  }

  private async _emitTimelineEvents(events: readonly RaceEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this._timelineEventsStaged) {
      this._stagedTimelineEvents.push(...events);
      return;
    }
    await this._persistTimelineEvents(events);
  }

  private _timelineSessionBoundary(packet: TelemetryPacket): {
    sessionBoundaryReason?: SessionBoundaryReason;
    lapReset?: boolean;
    resetReason?: string;
  } {
    const session = this._lapDetector?.session;
    const previous = this._lastTimelinePacket;
    if (!session) return {};
    if (packet.gameId !== session.gameId) {
      return { sessionBoundaryReason: "car-changed", resetReason: "game-changed" };
    }
    if (packet.sessionUID && session.sessionUID && packet.sessionUID !== session.sessionUID) {
      return { sessionBoundaryReason: "session-uid-changed" };
    }
    if (packet.CarOrdinal >= 0 && packet.CarOrdinal !== session.carOrdinal) {
      return { sessionBoundaryReason: "car-changed" };
    }
    if (packet.TrackOrdinal && packet.TrackOrdinal !== session.trackOrdinal) {
      return { sessionBoundaryReason: "track-changed" };
    }
    if (previous && previous.LapNumber > 1 && packet.LapNumber === 1) {
      return { sessionBoundaryReason: "lap-number-reset", lapReset: true };
    }
    if (previous && !session.sessionUID && previous.DistanceTraveled > 1_000 && packet.DistanceTraveled < 500) {
      return { sessionBoundaryReason: "distance-reset", lapReset: true };
    }
    return {};
  }

  private _lapIssueKey(sessionId: number, lapNumber: number): string {
    return `${sessionId}:${lapNumber}`;
  }

  private _clearPendingLapIssues(sessionId: number): void {
    const prefix = `${sessionId}:`;
    for (const key of this._pendingLapIssues.keys()) {
      if (key.startsWith(prefix)) this._pendingLapIssues.delete(key);
    }
  }
  private _releaseTimelineReservationsForOtherSessions(activeSessionId: number): void {
    const prefix = `${activeSessionId}:`;
    for (const [key, pending] of this._pendingTimelineLapBatches) {
      if (!key.startsWith(prefix)) pending.release();
    }
  }



  private async _drainPendingTimelineLapBatches(sessionId: number): Promise<void> {
    const prefix = `${sessionId}:`;
    const pending = [...this._pendingTimelineLapBatches]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, batch]) => batch.settled);
    await Promise.all(pending);
  }
  private async _releaseFailedTimelineLapBatches(sessionId: number, error: unknown): Promise<void> {
    const prefix = `${sessionId}:`;
    const pending = [...this._pendingTimelineLapBatches]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, batch]) => batch);
    for (const [key, batch] of this._pendingTimelineLapBatches) {
      if (!key.startsWith(prefix)) continue;
      this._pendingTimelineLapBatches.delete(key);
      batch.release();
      batch.settle();
    }
    for (const batch of pending) {
      this._queueFailedTimelineBatch(batch.events, [], undefined, false);
    }
    await this._persistTimelineEvents([]);
    if (pending.length > 0) {
      await this._persistTimelineEvents(
        this.raceEvents.noteStorageFailure({
          kind: "failure",
          operation: "save-lap",
          details: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async _waitForPendingLapWrites(session: RecordingSessionState): Promise<void> {
    try {
      await session.detector.waitForPendingLapWrites?.(session.sessionId);
    } catch (error) {
      await this._releaseFailedTimelineLapBatches(session.sessionId, error);
      return;
    }
  }


  private _trackSessionFinalization(closed: ClosedRecordingSession, endReason: string): Promise<void> {
    const sessionId = closed.session.sessionId;
    const existing = this._sessionFinalizations.get(sessionId);
    if (existing) return existing;

    this._pendingSessionFinalizations.set(sessionId, { closed, endReason });
    let finalization!: Promise<void>;
    finalization = this._finalizeRecordedSession(closed, endReason)
      .then(() => {
        this._pendingSessionFinalizations.delete(sessionId);
      })
      .finally(() => {
        if (this._sessionFinalizations.get(sessionId) === finalization) {
          this._sessionFinalizations.delete(sessionId);
        }
      });
    this._sessionFinalizations.set(sessionId, finalization);
    void finalization.catch(() => {});
    return finalization;
  }

  private _retryPendingSessionFinalizations(): void {
    for (const { closed, endReason } of this._pendingSessionFinalizations.values()) {
      this._trackSessionFinalization(closed, endReason);
    }
  }

  private async _drainSessionFinalizations(): Promise<void> {
    await Promise.all([...this._sessionFinalizations.values()]);
  }

  private async _awaitCaptureFinalization(result: CaptureFinalizationResult): Promise<void> {
    if (result.finalization) await result.finalization;
    await this._drainSessionFinalizations();
  }

  private _scheduleLapReconciliation(sessionId: number, gameId: GameId): Promise<void> {
    const reconcile = this._onSessionFinalized;
    if (!reconcile) return Promise.resolve();
    const previous = this._lapReconciliations.get(sessionId) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous
      .catch(() => {})
      .then(() => reconcile(sessionId, gameId))
      .finally(() => {
        if (this._lapReconciliations.get(sessionId) === current) {
          this._lapReconciliations.delete(sessionId);
        }
      });
    this._lapReconciliations.set(sessionId, current);
    return current;
  }

  private async _drainLapReconciliations(sessionId: number): Promise<void> {
    await this._lapReconciliations.get(sessionId);
  }

  private _publishRaceResultInvalidation(sessionId: number): void {
    this.ws.broadcastNotification({
      type: "race-result-reconciled",
      sessionId,
      status: "updated",
    });
  }

  private _reconcileRecordedSession(session: { sessionId: number; gameId: GameId }): Promise<void> {
    if (this._finalizedResultSessions.has(session.sessionId)) {
      return Promise.resolve();
    }
    const pending = this._resultFinalizations.get(session.sessionId);
    if (pending) return pending;
    const finalization = (async () => {
      await this._drainLapReconciliations(session.sessionId);
      if (this._onSessionFinalized) {
        await this._onSessionFinalized(session.sessionId, session.gameId);
        this._publishRaceResultInvalidation(session.sessionId);
      }
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

  private async _closeRecordedSession(session: RecordingSessionState): Promise<ClosedRecordingSession | null> {
    if (this._recordingSession?.sessionId !== session.sessionId) return null;

    const qualityAccumulator = this._recordingQuality;
    const closureEvents = this.raceEvents.noteSourceSequenceFinalized(this._timelineSourceSequence.finalize());
    this._recordingSession = null;
    this._recordingQuality = null;

    let canonicalVerification: ArchiveVerification;
    try {
      canonicalVerification = await this.recorder.stop();
    } catch (error) {
      qualityAccumulator?.noteWriterFailure(error);
      closureEvents.push(
        ...this.raceEvents.noteStorageFailure({
          kind: "failure",
          operation: "stop-session-recorder",
          details: error instanceof Error ? error.message : String(error),
        }),
      );
      canonicalVerification = {
        state: "corrupt" as const,
        sourceGeneration: null,
        details: error instanceof Error ? error.message : String(error),
      };
    }
    if (canonicalVerification.state === "corrupt" || canonicalVerification.state === "truncated") {
      closureEvents.push(
        ...this.raceEvents.noteStorageFailure({
          kind: "failure",
          operation: "verify-session-recorder",
          details: canonicalVerification.details ?? canonicalVerification.state,
        }),
      );
    }
    const hasOriginalSourceVerification = this._sourceArchiveVerification !== undefined;
    return {
      session,
      qualityAccumulator,
      closureEvents,
      sourceVerification: this._sourceArchiveVerification ?? canonicalVerification,
      ...(this._sourceTransportVerification ? { transportVerification: this._sourceTransportVerification } : {}),
      ...(hasOriginalSourceVerification ? { canonicalVerification } : {}),
    };
  }

  private async _finalizeRecordedSession(closed: ClosedRecordingSession, endReason: string): Promise<void> {
    await this._waitForPendingLapWrites(closed.session);
    await this._drainPendingTimelineLapBatches(closed.session.sessionId);
    await this._persistTimelineEvents(closed.closureEvents);
    await this._persistTimelineEvents([]);
    this._clearPendingLapIssues(closed.session.sessionId);
    if (closed.qualityAccumulator) {
      const summary = closed.finalizedQuality ??= closed.qualityAccumulator.finalize(
        endReason,
        closed.sourceVerification,
        {
          transportVerification: closed.transportVerification,
          canonicalVerification: closed.canonicalVerification,
        },
      );
      const finalized = await this.db.updateSessionQuality(closed.session.sessionId, summary);
      await this.raceEventStore.refreshQualityLinks(closed.session.sessionId);
      if (!finalized.provenance.sourceGeneration.startsWith("provisional:")) {
        await this.raceEventStore.finalizeSourceGeneration(closed.session.sessionId, finalized.provenance.sourceGeneration);
      }
      this.raceEventPublisher.publishReplaced(closed.session.sessionId);
      await this._refreshFinalizedSessionLaps(closed.session.sessionId, closed.session.gameId);
      await this._reconcileRecordedSession(closed.session);
      this.ws.broadcastNotification({
        type: "quality-updated",
        sessionId: closed.session.sessionId,
        qualityGeneration: finalized.provenance.outputGeneration,
      });
      return;
    }
    await this._reconcileRecordedSession(closed.session);
  }

  private async _finishRecordedSessionCore(
    session = this._recordingSession,
    endReason: SessionEndReason = "stream-ended",
  ): Promise<CaptureFinalizationResult> {
    if (session) {
      await this._waitForPendingLapWrites(session);
      await this._drainPendingTimelineLapBatches(session.sessionId);
      await this._persistTimelineEvents([]);
      await this._emitTimelineEvents(this.raceEvents.endSession({ reason: endReason, terminalObserved: false }));
    }
    const closed = await withSessionCaptureMaintenanceLock(async () => {
      if (!session) {
        if (!this._recordingSession) await this.recorder.stop();
        return null;
      }
      return this._closeRecordedSession(session);
    });
    return {
      finalization: closed ? this._trackSessionFinalization(closed, endReason) : null,
    };
  }

  private _buildCallbacks(): LapDetectorCallbacks {
    return {



      onSessionStart: async (session, context) => {
        this._releaseTimelineReservationsForOtherSessions(session.sessionId);
        const closedPrevious = await withSessionCaptureMaintenanceLock(async () => {
          const previousSession = this._recordingSession;
          const closed = previousSession ? await this._closeRecordedSession(previousSession) : (await this.recorder.stop(), null);

          this.recorder.start(session.gameId);
          this.recorder.writeMetaFrame();
          this._recordingSession = {
            sessionId: session.sessionId,
            gameId: session.gameId,
            detector: this._lapDetector!,
          };
          this._recordingQuality = new RecordingQualityAccumulator(this._sourceKind, this._participant, this._versionIdentity ?? currentTelemetryVersionIdentity(session.gameId));
          if (this.recorder.path) {
            await this.db.updateSessionRawFile(session.sessionId, this.recorder.path, this._lapDetector?.detectorId ?? LAP_DETECTOR_ID);
          }
          return closed;
        });

        if (closedPrevious) void this._trackSessionFinalization(closedPrevious, "session-rotated");

        if (closedPrevious) {
          this._timelineSourceSequence = new SourceSequenceTracker();
          this._timelineSourceSequence.observe(context.packet, this._pendingTimelinePreflight?.observation.sourceSequences ?? []);
        }
        const observation =
          this._pendingTimelinePreflight?.observation ??
          getServerGame(session.gameId).toRaceEventObservation(context.packet, {
            receivedAtMs: Date.now(),
            sourceSequences: [],
          });
        this.raceEvents.bindSession(session.sessionId, {
          reason: context.reason,
          observation,
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
      },

      onSessionEnd: async (_session, context) => {
        if (context.reason !== "stream-ended") {
          await this._emitTimelineEvents(this.raceEvents.endSession(context));
        }
      },

      onLapEvaluated: async (event, context) => {
        const lastPacket = event.packets.at(-1);
        await this._emitTimelineEvents(
          this.raceEvents.noteLapEvaluated({
            lapNumber: context.lapNumber,
            lapTimeMs: Number.isFinite(event.lapTime) ? event.lapTime * 1_000 : null,
            isValid: event.isValid,
            phase: event.phase,
            conditions: event.conditions,
            invalidReason: event.quality.invalidReason,
            sectors: event.sectors,
            position: lastPacket && Number.isInteger(lastPacket.RacePosition) && lastPacket.RacePosition > 0 ? lastPacket.RacePosition : null,
            rawBoundaryOrdinal: event.packets.length,
          }),
        );
        this.pitTracker.acceptCompletedLap(event.eligibility);
        if (isEligibilityUsable(event.eligibility["tire-analysis"]) && getServerGame(context.session.gameId).runtime.pit.useDistanceBasedWearCurves) {
          this.pitTracker.updateWearCurves(event.packets, event.lapDistStart);
        }

        const issueEligibility = resolveLapIssueEligibility(event.eligibility);
        let issues: TuneIssue[] | null;
        if (isEligibilityUsable(issueEligibility)) {
          try {
            const corners = detectCorners(event.packets);
            const symptoms = telemetryToSymptoms(event.packets, corners);
            issues = symptomsToIssues(symptoms, context.lapNumber);
          } catch {
            issues = null;
          }
        } else {
          issues = [];
        }
        this._pendingLapIssues.set(this._lapIssueKey(context.session.sessionId, context.lapNumber), { issues, eligibility: issueEligibility });
      },

      onLapComplete: (event) => {
        if (isEligibilityUsable(event.eligibility["normal-pace"])) {
          this.sectorTracker.updateRefLap(event.packets, event.lapTime, event.sectors);
        }
      },

      onLapSaved: async (event, context) => {
        const session = context.session;
        const issueKey = this._lapIssueKey(session.sessionId, context.lapNumber);
        const pendingBatch = this._pendingTimelineLapBatches.get(issueKey);
        const staged = pendingBatch == null && this._timelineEventsStaged;
        const lapLink = {
          sessionId: session.sessionId,
          lapNumber: context.lapNumber,
          lapId: event.lapId,
        };
        this.raceEvents.noteLapSaved(context.lapNumber, event.lapId);
        if (staged) this._stagedTimelineLapLinks.push(lapLink);

        let attached = false;
        let published = false;
        const action = async (timelineLinked: boolean) => {
          if (!timelineLinked && !attached) {
            await this.raceEventStore.attachLap(session.sessionId, context.lapNumber, event.lapId);
            attached = true;
          }
          if (published) return;

          const pendingIssues = this._pendingLapIssues.get(issueKey);
          this._pendingLapIssues.delete(issueKey);

          const isActiveSession = this._recordingSession?.sessionId === session.sessionId && this._recordingSession.gameId === session.gameId;
          if (!isActiveSession) return;

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
          published = true;
          this.ws.broadcastNotification({ type: "lap-saved", ...event });
          if (pendingIssues) {
            const issues = pendingIssues.issues ?? [];
            this.ws.broadcastNotification({
              type: "lap-issues",
              lapId: event.lapId,
              lapNumber: event.lapNumber,
              issues,
              eligibility: pendingIssues.eligibility,
            });
          }
          this._broadcastSessionLaps();
        };

        const reconcile = async () => {
          await this._scheduleLapReconciliation(session.sessionId, session.gameId);
          if (this._onSessionFinalized) {
            this._publishRaceResultInvalidation(session.sessionId);
          }
        };

        if (pendingBatch) {
          await pendingBatch.prior;
          try {
            await this._persistTimelineEventsCore(pendingBatch.events, [lapLink], () => action(true));
          } finally {
            this._pendingTimelineLapBatches.delete(issueKey);
            pendingBatch.release();
            pendingBatch.settle();
          }
          await reconcile();
          return;
        }
        if (staged) {
          this._stagedLapSavedActions.push(async () => {
            await action(true);
            await reconcile();
          });
          return;
        }
        await this._enqueueTimelinePersistence(async () => {
          await action(false);
          await reconcile();
        });
      },
    };
  }

  private async _getOrCreateDetector(gameId: GameId): Promise<ILapDetector> {
    this._retryPendingSessionFinalizations();
    if (this._lapDetector === null || this._lapDetectorGameId !== gameId) {
      const previousDetector = this._lapDetector;
      const previousSession = this._recordingSession;
      if (previousDetector) {
        const previousSessionId = previousDetector.session?.sessionId;
        let detectorFailure: unknown;
        try {
          await previousDetector.finalizeCurrentSession?.("session-rotated");
        } catch (error) {
          detectorFailure = error;
        }
        if (previousSession) {
          const result = await this._finishRecordedSessionCore(previousSession, "session-rotated");
          void result.finalization?.catch(() => {});
        } else if (previousSessionId != null) {
          await previousDetector.waitForPendingLapWrites?.(previousSessionId);
        }
        if (detectorFailure) throw detectorFailure;
      }
      const serverAdapter = getServerGame(gameId);
      this._lapDetector = serverAdapter.createLapDetector({
        db: this.db,
        lapTimelineContext: {
          classificationForLap: (sessionId, lapNumber) => this.raceEvents.classificationForLap(sessionId, lapNumber),
          eventIdsForLap: (sessionId, lapNumber) => this.raceEvents.eventIdsForLap(sessionId, lapNumber),
        },
        bypassPacketRateFilter: this._bypassPacketRateFilter,
        callbacks: this._buildCallbacks(),
        sourceKind: this._sourceKind,
        participant: this._participant,
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
    await this._enqueueCaptureOperation(async () => {
      await this._lapDetector?.flushIncompleteLap?.();
    });
  }

  /** Finalize detector, durable capture, then authoritative session result. */
  async finalizeCurrentSession(reason: SessionEndReason = "stream-ended"): Promise<void> {
    this._retryPendingSessionFinalizations();
    const result = await this._enqueueCaptureOperation(async () => {
      const session = this._recordingSession;
      let detectorFailure: unknown;
      try {
        await this._lapDetector?.finalizeCurrentSession?.(reason);
      } catch (error) {
        detectorFailure = error;
      }
      const finalization = await this._finishRecordedSessionCore(session, reason);
      if (detectorFailure) {
        await this._awaitCaptureFinalization(finalization);
        throw detectorFailure;
      }
      return finalization;
    });
    await this._awaitCaptureFinalization(result);
  }

  /** Detect game-specific stale finalization and finish its durable capture. */
  async flushStaleSession(): Promise<void> {
    this._retryPendingSessionFinalizations();
    const result = await this._enqueueCaptureOperation(async () => {
      const session = this._recordingSession;
      await this._lapDetector?.flushStaleLap?.();
      return session && !this._lapDetector?.session ? this._finishRecordedSessionCore(session) : { finalization: null };
    });
    await this._awaitCaptureFinalization(result);
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
    await this._enqueueCaptureOperation(() => this._processPacketCore(packet, sourceFrame));
  }

  private async _processPacketCore(packet: TelemetryPacket, sourceFrame?: Buffer): Promise<void> {
    this._totalProcessed++;
    const receivedAtMs = Date.now();
    let recorderWriteFailure: unknown = null;

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
        recorderWriteFailure = error;
      }
    }

    const adapter = getServerGame(packet.gameId);
    if (this.ws.wantsDevTelemetry) {
      // Clone parser-native values before any in-place normalization/derivation.
      this.ws.stageDevTelemetry(structuredClone(packet));
    }

    // Normalize coordinates and derived channels using the adapter profile.
    normalizeTelemetryPacket(packet, adapter.coordSystem === "standard-xyz", adapter.runtime.normSuspensionTravelMm);
    const detector = await this._getOrCreateDetector(packet.gameId);

    const sourceSequences = packetSequences(packet);
    const sourceSequenceTracker = this._timelineSourceSequence;
    const sourceSequenceCheckpoint = sourceSequenceTracker.checkpoint();
    const sequenceEvidence = sourceSequenceTracker.observe(packet, sourceSequences);
    const observation = adapter.toRaceEventObservation(packet, { receivedAtMs, sourceSequences });
    const preflight = this.raceEvents.preflight(observation, {
      ...this._timelineSessionBoundary(packet),
      sourceSequenceBoundaries: sequenceEvidence.boundaries,
      sourceSequenceGapCandidates: sequenceEvidence.gapCandidates,
    });
    this._pendingTimelinePreflight = preflight;
    if (!preflight.accepted) {
      this._recordingQuality?.observe(packet, sourceSequences);
      const rejected = this.raceEvents.processPreflight(preflight);
      sourceSequenceTracker.commit(sourceSequenceCheckpoint);
      await this._persistTimelineEvents(rejected.events);
      this._pendingTimelinePreflight = null;
      return;
    }

    this._timelineEventsStaged = true;
    this._stagedTimelineEvents.length = 0;
    this._stagedTimelineLapLinks.length = 0;
    this._stagedLapSavedActions.length = 0;
    try {
      await detector.feed(packet, rawByteOffset);
    } catch (error) {
      this.raceEvents.abortPreflight(preflight);
      sourceSequenceTracker.rollback(sourceSequenceCheckpoint);
      this._timelineEventsStaged = false;
      this._pendingTimelinePreflight = null;
      this._stagedTimelineEvents.length = 0;
      this._stagedTimelineLapLinks.length = 0;
      this._stagedLapSavedActions.length = 0;
      throw error;
    }

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
        recorderWriteFailure = error;
      }
    }
    this._recordingQuality?.observe(packet, sourceSequences);
    const processed = this.raceEvents.processPreflight(preflight);
    sourceSequenceTracker.commit(sourceSequenceCheckpoint);
    this._stagedTimelineEvents.push(...processed.events);
    if (processed.rejectedDrafts.length > 0) {
      this._stagedTimelineEvents.push(
        ...this.raceEvents.noteStorageFailure({
          kind: "failure",
          operation: "validate-race-event-drafts",
          details: processed.rejectedDrafts.map(({ eventType, error }) => `${eventType}: ${error}`).join("; "),
        }),
      );
    }
    if (recorderWriteFailure != null) {
      this._stagedTimelineEvents.push(
        ...this.raceEvents.noteStorageFailure({
          kind: "drop",
          operation: "write-session-record",
          details: recorderWriteFailure instanceof Error ? recorderWriteFailure.message : String(recorderWriteFailure),
        }),
      );
    }
    try {
      const pendingLapEvent = this._stagedTimelineEvents.find((event) => event.eventType === "lap_completed" && event.lapNumber != null);
      const pendingLapLinked = pendingLapEvent != null && this._stagedTimelineLapLinks.some((link) => link.sessionId === pendingLapEvent.sessionId && link.lapNumber === pendingLapEvent.lapNumber);
      if (pendingLapEvent && !pendingLapLinked) {
        const key = this._lapIssueKey(pendingLapEvent.sessionId, pendingLapEvent.lapNumber!);
        if (this._pendingTimelineLapBatches.has(key)) {
          throw new Error(`Pending race-event lap batch already exists for ${key}`);
        }
        const reservation = this._reserveTimelinePosition();
        const completion = Promise.withResolvers<void>();
        this._pendingTimelineLapBatches.set(key, {
          events: [...this._stagedTimelineEvents],
          ...reservation,
          settled: completion.promise,
          settle: completion.resolve,
        });
      } else {
        await this._enqueueTimelinePersistence(async () => {
          await this._persistTimelineEventsCore(this._stagedTimelineEvents, this._stagedTimelineLapLinks);
          const lapSavedActions = this._stagedLapSavedActions.splice(0);
          for (const action of lapSavedActions) await action();
        });
      }
    } finally {
      this._timelineEventsStaged = false;
      this._pendingTimelinePreflight = null;
      this._stagedTimelineEvents.length = 0;
      this._stagedTimelineLapLinks.length = 0;
    }
    this._lastTimelinePacket = packet;


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
      receivedAtMs,
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
    this._retryPendingSessionFinalizations();
    const result = await this._enqueueCaptureOperation(() => this._finishRecordedSessionCore(this._recordingSession, "stream-ended"));
    await this._awaitCaptureFinalization(result);
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
  raceEventStore: new DatabaseRaceEventStore(),
  onSessionFinalized: async (sessionId, gameId) => {
    await reconcileSessionResult(sessionId, gameId);
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
  async finalizeCurrentSession(reason: SessionEndReason = "stream-ended") {
    await _default.finalizeCurrentSession(reason);
  },
};
export function noteSourceLifecycle(event: SourceLifecycleEvidence, source?: LiveSourceScope): Promise<void> {
  return _default.noteSourceLifecycle(event, source);
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
