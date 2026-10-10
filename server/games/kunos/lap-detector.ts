import { lapPath } from "@raceiq/shared/racing/tracks/path";
import { recordOpenLapTrace } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { KunosDetectorEngine, type KunosLapCapture } from "@raceiq/telemetry-core/processor/kunos-engine";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { DbAdapter } from "../../telemetry/pipeline-ports";
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
  private lastAcEvoSourceIdentity: {
    carName: string;
    trackName: string;
    trackConfiguration: string;
    carOrdinal: number;
    trackOrdinal: number;
  } | null = null;

  protected constructor(opts: LapDetectorOptions, detectorId: string, loggerLabel: string) {
    this.db = opts.db;
    this.onLapSaved = opts.callbacks?.onLapSaved;
    this.onSessionStart = opts.callbacks?.onSessionStart;
    this.onLapComplete_ = opts.callbacks?.onLapComplete;
    this.detectorId = detectorId;
    this.loggerLabel = loggerLabel;
    this.engine = new KunosDetectorEngine({
      createSession: async packet => {
        const carOrdinal = packet.CarOrdinal;
        const trackOrdinal = packet.TrackOrdinal;
        const sessionId = await this.db.insertSession(carOrdinal, trackOrdinal, packet.gameId, packet.acc?.acEvo?.sessionType ?? packet.acc?.sessionType);
        this.currentSession = { sessionId, carOrdinal, trackOrdinal, carPI: packet.CarPerformanceIndex, gameId: packet.gameId, sessionUID: packet.sessionUID, bestLapTime: 0 };
      },
      onSessionStarted: async () => { await this.onSessionStart?.(this.currentSession!); },
      backfillSessionIdentifiers: packet => this.backfillSessionIdentifiers(packet),
      isPitOnly: packets => classifyPitCycleLap(packets) === "pit lap",
      isOpenRoute: packet => this.isOpenRoute(packet),
      emitLap: capture => this.emitLap(capture),
    });
  }
  get session(): SessionState | null { return this.currentSession; }
  setCurrentLapByteOffset(offset: number): void { this.engine.setCurrentLapByteOffset(offset); }
  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    const identity = packet.gameId === "ac-evo" ? packet.acEvoIdentity : undefined;
    if (identity) {
      const previous = this.lastAcEvoSourceIdentity;
      if (
        previous?.carName === identity.carName &&
        previous.trackName === identity.trackName &&
        previous.trackConfiguration === identity.trackConfiguration
      ) {
        packet.CarOrdinal = previous.carOrdinal;
        packet.TrackOrdinal = previous.trackOrdinal;
      } else {
        const [carOrdinal, trackOrdinal] = await Promise.all([
          this.resolveCarOrdinal(packet),
          this.resolveTrackOrdinal(packet),
        ]);
        packet.CarOrdinal = carOrdinal;
        packet.TrackOrdinal = trackOrdinal;
        this.lastAcEvoSourceIdentity = { ...identity, carOrdinal, trackOrdinal };
      }
    }
    await this.engine.feed(packet, rawByteOffset);
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
    if (isValid && openRoute && session.trackOrdinal >= 0) {
      const path = lapPath(packets);
      recordOpenLapTrace(session.trackOrdinal, path.x.map((x, index) => ({ x, z: path.z[index] })), session.gameId);
    }
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, stage: "quality", durationMs: performance.now() - traceStageAt, valid: isValid, reason: invalidReason });
    traceStageAt = performance.now();
    const sectors = await computeLapSectors(session.trackOrdinal, session.gameId, packets, lapTime, { sectors: resolveTrack(session.gameId, session.trackOrdinal).sectors });
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, stage: "sectors", durationMs: performance.now() - traceStageAt });
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
      this.onLapSaved?.({ type: "lap-saved", lapId, lapNumber: lapNum, lapTime, isValid, sectors, estimatedBestLapTime: session.bestLapTime });
      this.onLapComplete_?.({ packets, lapDistStart: packets[0]?.DistanceTraveled ?? 0, lapTime, isValid, sectors });
    }
    traceLap(traceGameId, "lap-boundary-stage", { sessionId: traceSessionId, lapNumber: lapNum, stage: "callbacks", durationMs: performance.now() - traceStageAt });
    traceLap(traceGameId, "lap-boundary-end", { sessionId: traceSessionId, lapNumber: lapNum, totalMs: performance.now() - traceStartedAt });
  }
  protected resolveCarOrdinal(packet: TelemetryPacket): number | Promise<number> { return packet.CarOrdinal; }
  protected resolveTrackOrdinal(packet: TelemetryPacket): number | Promise<number> { return packet.TrackOrdinal; }
  protected backfillSessionIdentifiers(_packet: TelemetryPacket): void | Promise<void> {}
  protected isOpenRoute(_packet: TelemetryPacket): boolean { return false; }
  protected classifyTrackLimits(_packets: TelemetryPacket[]): "track limits" | null { return null; }
}
