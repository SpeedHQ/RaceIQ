import { lapPath } from "@raceiq/shared/racing/tracks/path";
import { recordOpenLapTraceById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { KunosDetectorEngine, type KunosLapCapture } from "@raceiq/telemetry-core/processor/kunos-engine";
import type { DetectorOwnershipState, DetectorOwnershipTransition } from "@raceiq/telemetry-core/processor/ordinal-engine";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { DbAdapter, SessionIdentity } from "../../telemetry/pipeline-ports";
import { assessLapRecording } from "@raceiq/telemetry-core/processor/lap-policy";
import { persistLapMetrics } from "../../lap-analysis/metrics-store";
import { reconcileAutoExclusionsForLap } from "../../experiments/auto-exclude";
import { computeLapSectors } from "@raceiq/telemetry-core/processor/sectors";
import { resolveTrack } from "../../tracks/info";
import type {
  ILapDetector,
  LapDetectorCallbacks,
  LapDetectorOptions,
  SessionState,
} from "../../lap-detection/types";
import { resolveAccRecordedLapValidity } from "@raceiq/telemetry-core/processor/kunos-policy";
import { classifyPitCycleLap } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { logger } from "../../runtime/logger";

function traceLap(game: string, event: string, fields: Record<string, unknown>): void {
  logger.trace({ component: "capture", event, game, ...fields }, "Kunos lap capture trace");
}

/** Shared Kunos (ACC / AC Evo) lap detector state machine. */
export class KunosLapDetector implements ILapDetector {
  readonly detectorId: string;
  private readonly engine: KunosDetectorEngine;
  private readonly loggerLabel: string;
  protected readonly db: DbAdapter;
  private readonly onLapSaved?: LapDetectorCallbacks["onLapSaved"];
  private readonly onSessionStart?: LapDetectorCallbacks["onSessionStart"];
  private readonly onLapComplete_?: LapDetectorCallbacks["onLapComplete"];
  private currentSession: SessionState | null = null;
  private lastAcEvoSourceIdentity: TelemetryPacket["acEvoIdentity"] | null = null;

  protected constructor(opts: LapDetectorOptions, detectorId: string, loggerLabel: string) {
    this.db = opts.db;
    this.onLapSaved = opts.callbacks?.onLapSaved;
    this.onSessionStart = opts.callbacks?.onSessionStart;
    this.onLapComplete_ = opts.callbacks?.onLapComplete;
    this.detectorId = detectorId;
    this.loggerLabel = loggerLabel;
    this.engine = new KunosDetectorEngine({
      createSession: async packet => {
        const identity = await this.resolveSessionIdentity(packet);
        const carId = identity?.carId ?? packet.carId;
        const trackId = identity?.trackId ?? packet.trackId;
        const sessionId = await this.db.insertSession(carId, trackId, packet.gameId, packet.acc?.acEvo?.sessionType ?? packet.acc?.sessionType);
        this.currentSession = { sessionId, carId, trackId, carPI: packet.CarPerformanceIndex, gameId: packet.gameId, sessionUID: packet.sessionUID, bestLapTime: 0 };
      },
      onSessionStarted: async () => { await this.onSessionStart?.(this.currentSession!); },
      backfillSessionIdentifiers: packet => this.backfillSessionIdentifiers(packet),
      isPitOnly: packets => classifyPitCycleLap(packets) === "pit lap",
      isOpenRoute: packet => this.isOpenRoute(packet),
      emitLap: capture => this.emitLap(capture),
    });
  }
  get session(): SessionState | null { return this.currentSession; }
  getOwnershipState(): DetectorOwnershipState { return this.engine.getOwnershipState(); }
  subscribeOwnership(listener: (transition: DetectorOwnershipTransition) => void): () => void {
    return this.engine.subscribeOwnership(listener);
  }
  setCurrentLapByteOffset(offset: number, rawOrdinal?: number): void { this.engine.setCurrentLapByteOffset(offset, rawOrdinal); }
  observeSourceRecord(offset: number, endOffset: number, ordinal: number): void {
    this.engine.observeSourceRecord(offset, endOffset, ordinal);
  }
  drainOwnershipTransitions(): DetectorOwnershipTransition[] {
    return this.engine.drainOwnershipTransitions();
  }
  shouldCheckpointBeforeWrite(packet: TelemetryPacket): boolean {
    return this.engine.shouldCheckpoint(packet);
  }
  async feed(packet: TelemetryPacket, rawByteOffset?: number, rawOrdinal?: number): Promise<void> {
    const identity = packet.gameId === "ac-evo" ? packet.acEvoIdentity : undefined;
    if (identity) {
      const previous = this.lastAcEvoSourceIdentity;
      if (previous && this.currentSession &&
        ((previous.carName && identity.carName && previous.carName !== identity.carName) ||
         (previous.trackName && identity.trackName &&
          (previous.trackName !== identity.trackName || previous.trackConfiguration !== identity.trackConfiguration)))) {
        await this.finalizeCurrentSession();
      }
      this.lastAcEvoSourceIdentity = identity;
    }
    await this.engine.feed(packet, rawByteOffset, rawOrdinal);
  }
  async flushIncompleteLap(): Promise<void> { await this.engine.flushIncompleteLap(); }
  async flushStaleLap(): Promise<void> {
    if (await this.engine.flushStaleLap()) {
      const sid = this.currentSession?.sessionId;
      console.log(`${this.loggerLabel} Finalized session ${sid}`);
      this.currentSession = null;
    }
  }
  async finalizeCurrentSession(): Promise<void> {
    if (!this.currentSession) return;
    const sid = this.currentSession.sessionId;
    await this.engine.finalize();
    console.log(`${this.loggerLabel} Finalized session ${sid}`);
    this.currentSession = null;
  }
  private async emitLap(capture: KunosLapCapture): Promise<void> {
    const { packets, lapNumber: lapNum, lapTime, byteOffset: lapByteOffset, frameCount: lapFrameCount } = capture;
    const session = this.currentSession!;
    const traceGameId = session.gameId, traceSessionId = session.sessionId;
    const traceStartedAt = performance.now();
    let traceStageAt = traceStartedAt;
    traceLap(traceGameId, "lap-boundary-start", { sessionId: traceSessionId, lapNumber: lapNum, lapTimeMs: Math.round(lapTime * 1_000), frames: packets.length });
    const openRoute = packets[0] !== undefined && this.isOpenRoute(packets[0]);
    let isValid: boolean;
    let invalidReason: string | null = null;
    if (capture.invalidReason) { isValid = false; invalidReason = capture.invalidReason; }
    else if (capture.silent) { isValid = false; invalidReason = "incomplete"; }
    else {
      const recordedValidity = session.gameId === "acc" ? resolveAccRecordedLapValidity(packets, capture.trigger !== undefined) : null;
      if (recordedValidity !== null) { isValid = recordedValidity; invalidReason = recordedValidity ? null : "game reported invalid"; }
      else {
        const quality = assessLapRecording(packets, lapTime, { closed: !openRoute }), pitReason = openRoute ? null : classifyPitCycleLap(packets);
        isValid = !pitReason && quality.valid; invalidReason = pitReason ?? quality.reason;
        if (isValid) { const cutReason = this.classifyTrackLimits(packets); if (cutReason) { isValid = false; invalidReason = cutReason; } }
      }
    }
    const trackIdentity = session.trackId;
    if (isValid && openRoute) {
      const path = lapPath(packets);
      recordOpenLapTraceById(trackIdentity, path.x.map((x, index) => ({ x, z: path.z[index] })), session.gameId);
    }
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, stage: "quality", durationMs: performance.now() - traceStageAt, valid: isValid, reason: invalidReason });
    traceStageAt = performance.now();
    const sectors = await computeLapSectors(session.trackId, session.gameId, packets, lapTime, { sectors: resolveTrack(session.gameId, session.trackId).sectors });
    traceStageAt = performance.now();
    if (isValid && (session.bestLapTime === 0 || lapTime < session.bestLapTime)) session.bestLapTime = lapTime;
    const lapId = await this.db.insertLap(session.sessionId, lapNum, lapTime, isValid, lapByteOffset, lapFrameCount, null, null, invalidReason, sectors);
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, lapId, stage: "insert", durationMs: performance.now() - traceStageAt });
    traceStageAt = performance.now();
    await persistLapMetrics(this.db, lapId, packets);
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, lapId, stage: "metrics", durationMs: performance.now() - traceStageAt });
    traceStageAt = performance.now();
    await reconcileAutoExclusionsForLap(this.db, lapId);
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, lapId, stage: "auto-exclusion", durationMs: performance.now() - traceStageAt });
    traceStageAt = performance.now();
    if (!capture.silent) {
      this.onLapSaved?.({ type: "lap-saved", sessionId: session.sessionId, lapId, lapNumber: lapNum, lapTime, isValid, sectors, estimatedBestLapTime: session.bestLapTime });
      this.onLapComplete_?.({ packets, lapDistStart: packets[0]?.DistanceTraveled ?? 0, lapTime, isValid, sectors });
    }
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, stage: "callbacks", durationMs: performance.now() - traceStageAt });
    traceLap(traceGameId, "lap-boundary-end", { sessionId: traceSessionId, lapNumber: lapNum, totalMs: performance.now() - traceStartedAt });
  }
  protected async resolveSessionIdentity(_packet: TelemetryPacket): Promise<SessionIdentity | undefined> { return undefined; }
  protected async backfillSessionIdentifiers(packet: TelemetryPacket): Promise<void> {
    const session = this.currentSession;
    if (!session || (session.carId && session.trackId)) return;
    const identity = await this.resolveSessionIdentity(packet);
    if (!identity) return;
    await this.db.updateSessionCarTrack(session.sessionId, identity.carId, identity.trackId);
    Object.assign(session, identity);
  }
  protected isOpenRoute(_packet: TelemetryPacket): boolean { return false; }
  protected classifyTrackLimits(_packets: TelemetryPacket[]): "track limits" | null { return null; }
}
