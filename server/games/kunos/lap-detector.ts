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
  private readonly loggerLabel: string;
  protected readonly db: DbAdapter;
  private readonly onLapSaved?: LapDetectorCallbacks["onLapSaved"];
  private readonly onSessionStart?: LapDetectorCallbacks["onSessionStart"];
  private readonly onLapComplete_?: LapDetectorCallbacks["onLapComplete"];
  private currentSession: SessionState | null = null;
  private readonly engine: KunosDetectorEngine;

  protected constructor(opts: LapDetectorOptions, detectorId: string, loggerLabel: string) {
    this.db = opts.db;
    this.onLapSaved = opts.callbacks?.onLapSaved;
    this.onSessionStart = opts.callbacks?.onSessionStart;
    this.onLapComplete_ = opts.callbacks?.onLapComplete;
    this.detectorId = detectorId;
    this.loggerLabel = loggerLabel;
    this.engine = new KunosDetectorEngine({
      createSession: async packet => {
        const carOrdinalResult = this.resolveCarOrdinal(packet);
        const carOrdinal = typeof carOrdinalResult === "number" ? carOrdinalResult : await carOrdinalResult;
        const sessionId = await this.db.insertSession(carOrdinal, packet.TrackOrdinal ?? 0, packet.gameId, packet.acc?.acEvo?.sessionType ?? packet.acc?.sessionType);
        this.currentSession = { sessionId, carOrdinal, trackOrdinal: packet.TrackOrdinal ?? 0, carPI: packet.CarPerformanceIndex, gameId: packet.gameId, sessionUID: packet.sessionUID, bestLapTime: 0 };
      },
      onSessionStarted: async () => { await this.onSessionStart?.(this.currentSession!); },
      backfillSessionIdentifiers: packet => this.backfillSessionIdentifiers(packet),
      isPitOnly: packets => classifyPitCycleLap(packets) === "pit lap",
      emitLap: capture => this.emitLap(capture),
    });
  }
  get session(): SessionState | null { return this.currentSession; }
  setCurrentLapByteOffset(offset: number): void { this.engine.setCurrentLapByteOffset(offset); }
  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> { await this.engine.feed(packet, rawByteOffset); }
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
    let isValid: boolean, invalidReason: string | null;
    if (capture.silent) { isValid = false; invalidReason = "incomplete"; }
    else {
      const recordedValidity = session.gameId === "acc" ? resolveAccRecordedLapValidity(packets, capture.trigger !== undefined) : null;
      if (recordedValidity !== null) { isValid = recordedValidity; invalidReason = recordedValidity ? null : "game reported invalid"; }
      else {
        const quality = assessLapRecording(packets, lapTime), pitReason = classifyPitCycleLap(packets);
        isValid = !pitReason && quality.valid; invalidReason = pitReason ?? quality.reason;
        if (isValid) { const cutReason = this.classifyTrackLimits(packets); if (cutReason) { isValid = false; invalidReason = cutReason; } }
      }
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
  protected backfillSessionIdentifiers(_packet: TelemetryPacket): void | Promise<void> {}
  protected classifyTrackLimits(_packets: TelemetryPacket[]): "track limits" | null { return null; }
}
