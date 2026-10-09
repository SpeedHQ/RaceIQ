/**
 * Shared ordinal-based lap detection state machine.
 *
 * Forza Motorsport and F1 2025 use this detector directly; iRacing wraps it
 * with protocol-specific timing reconciliation. Session and lap boundaries
 * are inferred from normalized packet fields:
 *   - Session boundary: game/session identity or telemetry continuity changes
 *   - Lap boundary:     LapNumber field increments
 *   - Rewind:           TimestampMS decreases (marks lap invalid)
 *
 * Each completed lap's full packet buffer is persisted to SQLite.
 * Fuel and tire wear deltas are tracked per-lap for strategy overlays.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import type { ILapDetector, LapDetectorOptions } from "./types";
import { DEFAULT_LAP_DETECTOR_POLICY, assessLapRecording, mergePitCycleReason, type LapDetectorPolicy } from "@raceiq/telemetry-core/processor/lap-policy";
import { extractCurbSegments, recordCurbData } from "@raceiq/shared/racing/tracks/recording/curbs";
import { recordLapTrace } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { getIRacingSharedTrackName } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing"
import { lapPath } from "@raceiq/shared/racing/tracks/path";
import { forzaPitTransitionEvidence, type PitCycleReason } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { persistLapMetrics } from "../lap-analysis/metrics-store";
import { reconcileAutoExclusionsForLap } from "../experiments/auto-exclude";
import { computeLapSectors as computeLapSectorsHelper } from "@raceiq/telemetry-core/processor/sectors";
import { resolveTrack } from "../tracks/info";
import {
  OrdinalDetectorEngine,
  type OrdinalEngineState,
} from "@raceiq/telemetry-core/processor/ordinal-engine";
import { logger } from "../runtime/logger";
import type { SessionIdentity } from "../telemetry/pipeline-ports";

function traceCapture(game: string, event: string, fields: Record<string, unknown>): void {
  logger.trace({ component: "capture", event, game, ...fields }, "Lap capture trace");
}


export interface SessionState {
  sessionId: number;
  carOrdinal: number;
  trackOrdinal: number;
  carPI: number;
  gameId: GameId;
  sessionUID?: string; // F1 session UID for reliable session boundary detection
  carId?: string;
  trackId?: string;
  bestLapTime: number; // best valid lap time in current session (0 = none yet)
}

export interface LapFuelData {
  lap: number;
  fuelStart: number;
  fuelEnd: number;
  fuelUsed: number;
}

export interface LapTireWearData {
  lap: number;
  start: { fl: number; fr: number; rl: number; rr: number };
  end: { fl: number; fr: number; rl: number; rr: number };
  worn: { fl: number; fr: number; rl: number; rr: number };
}

export interface LapSavedEvent {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  sectors: number[] | null;
  estimatedBestLapTime: number; // best lap time in session (0 if none yet)
}
export interface LapSavedNotification extends LapSavedEvent {
  type: "lap-saved";
}

/** Bump this whenever lap detection logic changes — triggers UI prompt to reprocess old sessions. */
export const LAP_DETECTOR_ID = "lapdetector_v7";

export interface LapCompleteEvent {
  packets: TelemetryPacket[];
  lapDistStart: number;
  lapTime: number;
  isValid: boolean;
  sectors: number[] | null;
}

export class LapDetector implements ILapDetector {
  readonly detectorId = LAP_DETECTOR_ID;
  private readonly db: LapDetectorOptions["db"];
  private readonly bypassPacketRateFilter: boolean;
  private readonly lapPolicy: LapDetectorPolicy;
  private readonly engine: OrdinalDetectorEngine;
  private currentSession: SessionState | null = null;
  onSessionStart?: (session: SessionState) => void | Promise<void>;
  onLapComplete_?: (event: LapCompleteEvent) => void;
  onLapSaved?: (event: LapSavedEvent) => void;
  private _loggedFeedOnce = false;
  private pendingIncompleteLapId: number | null = null;
  private pendingIncompleteLapWrite: Promise<void> | null = null;

  private get state(): OrdinalEngineState { return this.engine.state; }
  private get currentLapNumber() { return this.state.lapNumber; }
  private set currentLapNumber(v: number) { this.state.lapNumber = v; }
  private get lapBuffer() { return this.state.lapBuffer; }
  private set lapBuffer(v: TelemetryPacket[]) { this.state.lapBuffer = v; }
  private get lapIsValid() { return this.state.lapIsValid; }
  private set lapIsValid(v: boolean) { this.state.lapIsValid = v; }
  private get invalidReason() { return this.state.invalidReason; }
  private set invalidReason(v: string | null) { this.state.invalidReason = v; }
  private get lastLastLap() { return this.state.lastLastLap; }
  private set lastLastLap(v: number) { this.state.lastLastLap = v; }
  private get completedLapCount() { return this.state.completedLapCount; }
  private set completedLapCount(v: number) { this.state.completedLapCount = v; }
  private get lastTimestampMS() { return this.state.lastTimestampMS; }
  private set lastTimestampMS(v: number) { this.state.lastTimestampMS = v; }
  private get lastPacketTime() { return this.state.lastPacketTime; }
  private set lastPacketTime(v: number) { this.state.lastPacketTime = v; }
  private get recentPacketCount() { return this.state.recentPacketCount; }
  private set recentPacketCount(v: number) { this.state.recentPacketCount = v; }
  private get lastRateCheck() { return this.state.lastRateCheck; }
  private set lastRateCheck(v: number) { this.state.lastRateCheck = v; }
  private get packetRate() { return this.state.packetRate; }
  private set packetRate(v: number) { this.state.packetRate = v; }
  private get _distanceAtLapStart() { return this.state.distanceAtLapStart; }
  private set _distanceAtLapStart(v: number) { this.state.distanceAtLapStart = v; }
  private get fuelAtLapStart() { return this.state.fuelAtLapStart; }
  private set fuelAtLapStart(v: number) { this.state.fuelAtLapStart = v; }
  private get _fuelHistory() { return this.state.fuelHistory as LapFuelData[]; }
  private get tireWearAtLapStart() { return this.state.tireWearAtLapStart; }
  private set tireWearAtLapStart(v: {fl:number;fr:number;rl:number;rr:number}) { this.state.tireWearAtLapStart = v; }
  private get _tireWearHistory() { return this.state.tireWearHistory as LapTireWearData[]; }
  private get _lapByteOffset() { return this.state.lapByteOffset; }
  private set _lapByteOffset(v: number | null) { this.state.lapByteOffset = v; }
  private get _lapFrameCount() { return this.state.lapFrameCount; }
  private set _lapFrameCount(v: number) { this.state.lapFrameCount = v; }
  private get currentPitCycleReason() { return this.state.currentPitCycleReason as PitCycleReason | null; }
  private set currentPitCycleReason(v: PitCycleReason | null) { this.state.currentPitCycleReason = v; }
  private get nextPitCycleReason() { return this.state.nextPitCycleReason as PitCycleReason | null; }
  private set nextPitCycleReason(v: PitCycleReason | null) { this.state.nextPitCycleReason = v; }
  private get forzaRaceOffObserved() { return this.state.forzaRaceOffObserved; }
  private set forzaRaceOffObserved(v: boolean) { this.state.forzaRaceOffObserved = v; }

  constructor(opts: LapDetectorOptions) {
    this.db = opts.db;
    this.bypassPacketRateFilter = opts.bypassPacketRateFilter ?? false;
    this.lapPolicy = opts.policy ?? DEFAULT_LAP_DETECTOR_POLICY;
    this.onSessionStart = opts.callbacks?.onSessionStart;
    this.onLapComplete_ = opts.callbacks?.onLapComplete;
    this.onLapSaved = opts.callbacks?.onLapSaved;
    this.engine = new OrdinalDetectorEngine({
      now: () => Date.now(),
      log: (message) => console.log(message),
      createSession: async (packet) => {
        const created = await this.startNewSession(packet);
        if (!created) return null;
        return {
          carOrdinal: created.carOrdinal, trackOrdinal: created.trackOrdinal,
          gameId: created.gameId, sessionUID: created.sessionUID,
          carId: created.carId, trackId: created.trackId,
        };
      },
      onSessionStarted: async () => { if (this.currentSession) await this.onSessionStart?.(this.currentSession); },
      onProvisionalLapResume: async (startsNewSession) => {
        if (this.pendingIncompleteLapWrite) await this.pendingIncompleteLapWrite;
        if (this.pendingIncompleteLapId === null) return;
        if (startsNewSession) {
          this.pendingIncompleteLapId = null;
          return "discard";
        }
        const id = this.pendingIncompleteLapId;
        this.pendingIncompleteLapId = null;
        await this.db.deleteLap(id);
        return "retain";
      },
      pitTransition: (previous, next, raceOffObserved) => {
        const evidence = forzaPitTransitionEvidence(previous, next, raceOffObserved);
        if (evidence.detected) {
          this.currentPitCycleReason = mergePitCycleReason(this.currentPitCycleReason, "inlap");
          this.nextPitCycleReason = mergePitCycleReason(this.nextPitCycleReason, "outlap");
          console.log(`[Lap] FM pit transition: raceOff=${evidence.raceOffObserved} timingGap=${evidence.timingGap} fuel=${evidence.fuelIncreased} tires=${evidence.tireWearRefreshed}`);
        }
        return evidence.detected;
      },
      finalizeLap: (packet) => this.onLapComplete(packet),
      finalizeIncompleteLap: () => this.finalizeLapIfNeeded(),
      finalizeStaleLap: async (lapTime, isComplete, silenceMs, state) => {
        const session = this.currentSession;
        if (!session) return;
        const tuneAssignment = await this.db.getTuneAssignment(session.gameId, session.carOrdinal, session.trackOrdinal);
        const lapNum = state.lapNumber;
        const packetCount = state.lapBuffer.length;
        const lapPackets = state.lapBuffer;
        this.db.insertLap(
          session.sessionId,
          lapNum,
          lapTime,
          isComplete && state.lapIsValid,
          state.lapByteOffset,
          state.lapFrameCount,
          null,
          tuneAssignment?.tuneId ?? null,
          isComplete ? state.invalidReason : "incomplete",
          null,
        ).then(async (lapId) => {
          await this.persistLapFollowups(lapId, lapPackets);
          console.log(
            `[Lap] Flushed stale lap ${lapNum} | Time: ${formatLapTime(lapTime)} | ${isComplete ? "Complete" : "Incomplete"} | Packets: ${packetCount} | DB ID: ${lapId} (${(silenceMs / 1000).toFixed(0)}s silence)`
          );
        }).catch((err) => {
          console.error("[Lap] Failed to flush stale lap:", err);
        });
      },
      finalizeSession: async () => { this.currentSession = null; },
    }, { bypassPacketRateFilter: this.bypassPacketRateFilter });
  }

  get session(): SessionState | null { return this.currentSession; }
  get fuelHistory(): LapFuelData[] { return this._fuelHistory; }
  get tireWearHistory(): LapTireWearData[] { return this._tireWearHistory; }
  setCurrentLapByteOffset(offset: number): void { this.engine.setCurrentLapByteOffset(offset); }
  async snapshotIncompleteLap(): Promise<void> {
    if (this.currentSession?.gameId === "fm-2023") this.engine.markProvisionalSnapshot();
    if (this.pendingIncompleteLapId !== null) return;
    if (this.pendingIncompleteLapWrite) return this.pendingIncompleteLapWrite;
    if (!this.currentSession || this.currentLapNumber < 0 || !this.lapBuffer.length) return;
    const session = this.currentSession, lapNumber = this.currentLapNumber;
    const lapTime = this.lapBuffer.at(-1)!.CurrentLap;
    if (lapTime < 10) return;
    this.pendingIncompleteLapWrite = (async () => {
      const tune = await this.db.getTuneAssignment(session.gameId, session.carOrdinal, session.trackOrdinal);
      this.pendingIncompleteLapId = await this.db.insertLap(session.sessionId, lapNumber, lapTime, false, this._lapByteOffset, this._lapFrameCount, null, tune?.tuneId ?? null, this.currentPitCycleReason ?? "incomplete", null);
      console.log(`[Lap] Saved provisional incomplete lap ${lapNumber}`);
    })();
    try { await this.pendingIncompleteLapWrite; } finally { this.pendingIncompleteLapWrite = null; }
  }
  async finalizeCurrentSession(): Promise<void> {
    if (!this.currentSession) return;
    const sessionId = this.currentSession.sessionId;
    await this.pendingIncompleteLapWrite;
    await this.flushIncompleteLap();
    console.log(`[Lap Detector] Finalizing session ${sessionId} due to game disconnect`);
    await this.engine.finalizeCurrentSession();
  }
  async flushIncompleteLap(): Promise<void> {
    await this.pendingIncompleteLapWrite;
    if (this.pendingIncompleteLapId === null) await this.engine.flushIncompleteLap();
    else this.engine.discardIncompleteLap();
    this.pendingIncompleteLapId = null;
  }
  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    if (!this._loggedFeedOnce) {
      console.log("[Lap Detector] Started receiving packets from pipeline");
      this._loggedFeedOnce = true;
    }
    await this.engine.feed(packet, rawByteOffset);
  }



  private async startNewSession(packet: TelemetryPacket): Promise<SessionState | null> {
    const trackOrd = packet.TrackOrdinal ?? 0;
    const gameId = packet.gameId;
    const sessionType = packet.f1?.sessionType ?? packet.lmu?.sessionType;
    const identity: SessionIdentity | undefined = packet.lmu
      ? {
          carId: packet.lmu.carId,
          trackId: packet.lmu.trackId,
        }
      : undefined;
    let sessionId: number;
    try {
      sessionId = await this.db.insertSession(
        packet.CarOrdinal,
        trackOrd,
        gameId,
        sessionType,
        undefined,
        undefined,
        identity,
      );
    } catch (err) {
      console.error(`[LapDetector] Failed to insert session:`, (err as Error).message);
      return null;
    }
    this.currentSession = {
      sessionId,
      carOrdinal: packet.CarOrdinal,
      trackOrdinal: trackOrd,
      carPI: packet.CarPerformanceIndex,
      gameId,
      sessionUID: packet.sessionUID,
      ...identity,
      bestLapTime: 0,
    };
    console.log(
      `[Session] New session #${sessionId} | Car: ${packet.CarOrdinal} | Class: ${packet.CarClass} | PI: ${packet.CarPerformanceIndex}${sessionType ? ` | Type: ${sessionType}` : ""}`
    );
    return this.currentSession;
  }

  private async onLapComplete(newLapFirstPacket: TelemetryPacket): Promise<boolean> {

    if (!this.currentSession || this.lapBuffer.length === 0) return false;
    const traceStartedAt = performance.now();




    const lapTime = this.lapPolicy.resolveLapTime(
      this.lapBuffer,
      newLapFirstPacket,
    );
    traceCapture(this.currentSession.gameId, "lap-boundary-start", {
      sessionId: this.currentSession.sessionId,
      lapNumber: this.currentLapNumber,
      lapTimeMs: Math.round(lapTime * 1000),
      frames: this.lapBuffer.length,
    });
    let traceStageAt = performance.now();


    // Running-start trim: strip pre-start-line packets
    this.engine.trimRunningStartPackets();

    // Skip saving if lap time is too short (first lap, warmup, ghost fragments)
    if (lapTime < 10) {
      console.log(
        `[Lap] Skipping lap ${this.currentLapNumber} with time ${lapTime.toFixed(3)}s (< 10s)`
      );
      traceCapture(this.currentSession.gameId, "lap-boundary-end", {
        sessionId: this.currentSession.sessionId,
        lapNumber: this.currentLapNumber,
        status: "skipped",
        totalMs: performance.now() - traceStartedAt,
      });

      return false;
    }

    {
      const tuneAssignment = await this.db.getTuneAssignment(
        this.currentSession.gameId,
        this.currentSession.carOrdinal,
        this.currentSession.trackOrdinal
      );
      const tuneId = tuneAssignment?.tuneId ?? null;
      traceCapture(this.currentSession.gameId, "lap-boundary-stage", {
        sessionId: this.currentSession.sessionId,
        lapNumber: this.currentLapNumber,
        stage: "tune-assignment",
        durationMs: performance.now() - traceStageAt,
      });
      traceStageAt = performance.now();
      const lapNum = this.currentLapNumber;
      const packetCount = this.lapBuffer.length;

      // Catalog-native pit state and FM's gap/service evidence both become
      // lap-level exclusions only after the complete lap window is available.
      const pitReason = mergePitCycleReason(
        this.currentPitCycleReason,
        this.lapPolicy.classifyPitCycle(this.lapBuffer, this.completedLapCount),
      );
      const policyReason = this.lapPolicy.invalidReason?.(this.lapBuffer) ?? null;
      const quality = assessLapRecording(this.lapBuffer, lapTime);
      const valid =
        this.lapIsValid &&
        policyReason === null &&
        pitReason === null &&
        quality.valid;
      const invalidReason =
        this.invalidReason ??
        policyReason ??
        pitReason ??
        (!quality.valid ? quality.reason : null);
      traceCapture(this.currentSession.gameId, "lap-boundary-stage", {
        sessionId: this.currentSession.sessionId,
        lapNumber: this.currentLapNumber,
        stage: "quality",
        durationMs: performance.now() - traceStageAt,
        valid,
        reason: invalidReason,
      });
      traceStageAt = performance.now();

      const sectors = await this.computeLapSectors(this.lapBuffer, lapTime);
      traceCapture(this.currentSession.gameId, "lap-boundary-stage", {
        sessionId: this.currentSession.sessionId,
        lapNumber: this.currentLapNumber,
        stage: "sectors",
        durationMs: performance.now() - traceStageAt,
      });
      traceStageAt = performance.now();

      // iRacing exposes heading, speed, and native LapDistPct but no public
      // world position. Keep RaceIQ's existing recorded-outline fallback warm
      // for layouts without exact shared geometry (or when the official SVG
      // cannot be reached). Higher-quality shared/SVG sources still win in the
      // outline resolver.
      if (
        valid &&
        this.currentSession.gameId === "iracing" &&
        this.currentSession.trackOrdinal > 0 &&
        !getIRacingSharedTrackName(this.currentSession.trackOrdinal)
      ) {
        const path = lapPath(this.lapBuffer);
        const trace = path.x.map((x, index) => ({
          x,
          z: path.z[index],
        }));
        recordLapTrace(
          this.currentSession.trackOrdinal,
          trace,
          trace[0] ?? null,
          this.lapBuffer[0]?.Yaw ?? null,
          "iracing",
        );
      }

      // Update session best lap time
      if (valid && (this.currentSession!.bestLapTime === 0 || lapTime < this.currentSession!.bestLapTime)) {
        this.currentSession!.bestLapTime = lapTime;
      }

      // Notify pipeline so sector tracker can update reference lap for delta
      if (valid) {
        this.onLapComplete_?.({
          packets: this.lapBuffer,
          lapDistStart: this.lapBuffer[0].DistanceTraveled,
          lapTime,
          isValid: valid,
          sectors,
        });
      }
      traceCapture(this.currentSession.gameId, "lap-boundary-stage", {
        sessionId: this.currentSession.sessionId,
        lapNumber: this.currentLapNumber,
        stage: "completion-callback",
        durationMs: performance.now() - traceStageAt,
        ran: valid,
      });
      traceStageAt = performance.now();

      // Capture the frame buffer before the engine resets its state; the insert below
      // is fire-and-forget, so persistLapMetrics runs after reset.
      const lapPackets = this.lapBuffer;
      const insertStartedAt = performance.now();
      this.db.insertLap(
        this.currentSession.sessionId,
        lapNum,
        lapTime,
        valid,
        this._lapByteOffset,
        this._lapFrameCount,
        null,
        tuneId,
        invalidReason,
        sectors
      ).then(async (lapId) => {
        traceCapture(lapPackets[0]?.gameId ?? "unknown", "lap-insert", {
          lapId,
          lapNumber: lapNum,
          durationMs: performance.now() - insertStartedAt,
        });
        // Precompute fuel/tyre metrics now (frames in memory) so /lap-metrics
        // never decodes on first open.
        await this.persistLapFollowups(lapId, lapPackets);
        console.log(
          `[Lap] Saved lap ${lapNum} | Time: ${formatLapTime(lapTime)} | Valid: ${valid}${invalidReason ? ` (${invalidReason})` : ""} | Packets: ${packetCount} | DB ID: ${lapId}`
        );
        this.onLapSaved?.({
          lapId,
          lapNumber: lapNum,
          lapTime,
          isValid: valid,
          sectors,
          estimatedBestLapTime: this.currentSession!.bestLapTime,
        });
      }).catch((err) => {
        console.error(`[Lap] Failed to save lap ${lapNum}:`, err);
      });

    }


    // Extract and record curb data from any valid lap
    if (this.lapIsValid && this.currentSession.trackOrdinal > 0 && this.lapBuffer.length > 50) {
      const curbSegments = extractCurbSegments(this.lapBuffer);
      if (curbSegments.length > 0) {
        recordCurbData(this.currentSession.trackOrdinal, curbSegments, this.currentSession.gameId);
      }
    }
    traceCapture(this.currentSession.gameId, "lap-boundary-stage", {
      sessionId: this.currentSession.sessionId,
      lapNumber: this.currentLapNumber,
      stage: "curb-recording",
      durationMs: performance.now() - traceStageAt,
    });
    traceCapture(this.currentSession.gameId, "lap-boundary-end", {
      sessionId: this.currentSession.sessionId,
      lapNumber: this.currentLapNumber,
      status: "saved",
      totalMs: performance.now() - traceStartedAt,
    });

    return true;
  }

  /** Persist an incomplete lap selected by the ordinal engine's finalization policy. */
  private async finalizeLapIfNeeded(): Promise<void> {
    if (!this.currentSession || !this.lapBuffer.length || this.currentLapNumber < 0) return;
    const tuneAssignment = await this.db.getTuneAssignment(
      this.currentSession.gameId,
      this.currentSession.carOrdinal,
      this.currentSession.trackOrdinal
    );
    const lapPackets = this.lapBuffer;
    this.db.insertLap(
      this.currentSession.sessionId,
      this.currentLapNumber,
      lapPackets[lapPackets.length - 1].CurrentLap,
      false,
      this._lapByteOffset,
      this._lapFrameCount,
      null,
      tuneAssignment?.tuneId ?? null,
      this.currentPitCycleReason ?? "incomplete",
      null
    ).then(async (lapId) => {
      await this.persistLapFollowups(lapId, lapPackets);
      console.log(`[Lap] Saved incomplete lap (session ended)`);
    }).catch((err) => {
      console.error("[Lap] Failed to save incomplete lap:", err);
    });
  }

  /**
   * Flush a stale in-progress lap when packets stop arriving (e.g. race ended).
   * FM silence and race-off packets also occur during pit service, so only its
   * provisional snapshot or process exit owns finalization.
   */
  async flushStaleLap(): Promise<void> {
    await this.engine.flushStaleLap();
  }


  /** Compute s1/s2/s3 sector times from a lap's telemetry buffer. */
  private async computeLapSectors(
    packets: TelemetryPacket[],
    lapTime: number
  ): Promise<number[] | null> {
    if (!this.currentSession) return null;
    const { trackOrdinal, gameId } = this.currentSession;
    return computeLapSectorsHelper(trackOrdinal, gameId, packets, lapTime, { sectors: resolveTrack(gameId, trackOrdinal).sectors });
  }

  private async persistLapFollowups(
    lapId: number,
    lapPackets: TelemetryPacket[],
  ): Promise<void> {
    const traceGameId = lapPackets[0]?.gameId ?? "unknown";
    const traceStartedAt = performance.now();
    let traceStageAt = traceStartedAt;
    traceCapture(traceGameId, "lap-followups-start", {
      lapId,
      frames: lapPackets.length,
    });
    const setup = lapPackets.find((packet) => packet.f1?.setup)?.f1?.setup;
    if (setup) {
      try {
        await this.db.updateLapCarSetup(lapId, setup);
      } catch (error) {
        console.error("[Lap] updateLapCarSetup failed:", error);
      }
    }
    traceCapture(traceGameId, "lap-followups-stage", {
      lapId,
      stage: "setup",
      durationMs: performance.now() - traceStageAt,
    });
    traceStageAt = performance.now();
    try {
      await persistLapMetrics(this.db, lapId, lapPackets);
    } catch (error) {
      console.error("[Lap] persistLapMetrics failed:", error);
    }
    traceCapture(traceGameId, "lap-followups-stage", {
      lapId,
      stage: "metrics",
      durationMs: performance.now() - traceStageAt,
    });
    traceStageAt = performance.now();
    try {
      await reconcileAutoExclusionsForLap(this.db, lapId);
    } catch (error) {
      console.error("[Lap] reconcileAutoExclusionsForLap failed:", error);
    }
    traceCapture(traceGameId, "lap-followups-stage", {
      lapId,
      stage: "auto-exclusion",
      durationMs: performance.now() - traceStageAt,
    });
    traceCapture(traceGameId, "lap-followups-end", {
      lapId,
      totalMs: performance.now() - traceStartedAt,
    });
  }



  getDebugState(): Record<string, unknown> {
    return {
      currentSession: this.currentSession,
      currentLapNumber: this.currentLapNumber,
      lapBufferLength: this.lapBuffer?.length ?? 0,
      lapIsValid: this.lapIsValid,
      invalidReason: this.invalidReason,
      lastLastLap: this.lastLastLap,
      lastTimestampMS: this.lastTimestampMS,
      lastPacketTime: this.lastPacketTime,
      recentPacketCount: this.recentPacketCount,
      lastRateCheck: this.lastRateCheck,
      packetRate: this.packetRate,
      distanceAtLapStart: this._distanceAtLapStart,
      fuelAtLapStart: this.fuelAtLapStart,
      fuelHistoryLength: this._fuelHistory?.length ?? 0,
      tireWearAtLapStart: this.tireWearAtLapStart,
      currentPitCycleReason: this.currentPitCycleReason,
      nextPitCycleReason: this.nextPitCycleReason,
      forzaRaceOffObserved: this.forzaRaceOffObserved,
      tireWearHistoryLength: this._tireWearHistory?.length ?? 0,
    };
  }
}

/**
 * Smooth an outline using a circular moving average (wraps around start/finish).
 */
export function smoothOutline(
  points: { x: number; z: number }[],
  window: number = 5
): { x: number; z: number }[] {
  const n = points.length;
  const half = Math.floor(window / 2);
  return points.map((_, i) => {
    let sx = 0, sz = 0;
    const count = half * 2 + 1;
    for (let j = -half; j <= half; j++) {
      const idx = (i + j + n) % n;
      sx += points[idx].x;
      sz += points[idx].z;
    }
    return { x: sx / count, z: sz / count };
  });
}

/**
 * Normalize a variable-length point array to a fixed number of points
 * using linear interpolation along cumulative distance.
 */
export function normalizeToFixedPoints(
  raw: { x: number; z: number; speed: number }[],
  targetPoints: number
): { x: number; z: number; speed: number }[] {
  if (raw.length <= targetPoints) return raw;

  // Compute cumulative distances
  const dists: number[] = [0];
  for (let i = 1; i < raw.length; i++) {
    const dx = raw[i].x - raw[i - 1].x;
    const dz = raw[i].z - raw[i - 1].z;
    dists.push(dists[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const totalDist = dists[dists.length - 1];
  if (totalDist <= 0) return raw.slice(0, targetPoints);

  // Sample at equal distance intervals
  const result: { x: number; z: number; speed: number }[] = [];
  let rawIdx = 0;

  for (let i = 0; i < targetPoints; i++) {
    const targetDist = (i / (targetPoints - 1)) * totalDist;

    // Advance rawIdx to bracket the target distance
    while (rawIdx < raw.length - 2 && dists[rawIdx + 1] < targetDist) {
      rawIdx++;
    }

    // Linear interpolation between rawIdx and rawIdx+1
    const d0 = dists[rawIdx];
    const d1 = dists[rawIdx + 1] ?? d0;
    const t = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
    const p0 = raw[rawIdx];
    const p1 = raw[rawIdx + 1] ?? p0;

    result.push({
      x: p0.x + (p1.x - p0.x) * t,
      z: p0.z + (p1.z - p0.z) * t,
      speed: p0.speed + (p1.speed - p0.speed) * t,
    });
  }

  return result;
}

/**
 * Filter outlier jumps from raw lap telemetry (rewinds, pit teleports).
 * Removes points where the step distance exceeds median * 5.
 */
export function filterLapOutliers(
  points: { x: number; z: number; speed: number }[]
): { x: number; z: number; speed: number }[] {
  if (points.length < 10) return points;

  // Compute step distances
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    steps.push(Math.sqrt(dx * dx + dz * dz));
  }
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const maxStep = median * 5;

  const result = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (steps[i - 1] <= maxStep) {
      result.push(points[i]);
    }
  }
  return result;
}

/**
 * Average multiple normalized outlines (all same length) into one.
 * Aligns each subsequent lap to the reference (first lap) by finding
 * the best rotational offset that minimizes position error, then averages.
 */
export function averageOutlines(
  laps: { x: number; z: number; speed: number }[][]
): { x: number; z: number; speed: number }[] {
  if (laps.length === 0) return [];
  if (laps.length === 1) return laps[0];

  const len = laps[0].length;
  const ref = laps[0];

  // Align each lap to the reference by finding the best circular shift
  const aligned: typeof laps = [ref];
  for (let l = 1; l < laps.length; l++) {
    const lap = laps[l];
    if (lap.length !== len) { aligned.push(lap); continue; }

    // Test shifts at coarse intervals, then refine around the best
    let bestShift = 0;
    let bestError = Infinity;
    const step = Math.max(1, Math.floor(len / 50)); // coarse: ~50 candidates
    for (let shift = 0; shift < len; shift += step) {
      let err = 0;
      // Sample every 10th point for speed
      for (let i = 0; i < len; i += 10) {
        const j = (i + shift) % len;
        const dx = lap[j].x - ref[i].x;
        const dz = lap[j].z - ref[i].z;
        err += dx * dx + dz * dz;
      }
      if (err < bestError) { bestError = err; bestShift = shift; }
    }
    // Refine around best coarse shift
    const refineStart = Math.max(0, bestShift - step);
    const refineEnd = Math.min(len - 1, bestShift + step);
    for (let shift = refineStart; shift <= refineEnd; shift++) {
      let err = 0;
      for (let i = 0; i < len; i += 5) {
        const j = (i + shift) % len;
        const dx = lap[j].x - ref[i].x;
        const dz = lap[j].z - ref[i].z;
        err += dx * dx + dz * dz;
      }
      if (err < bestError) { bestError = err; bestShift = shift; }
    }

    // Apply shift
    if (bestShift === 0) {
      aligned.push(lap);
    } else {
      aligned.push([...lap.slice(bestShift), ...lap.slice(0, bestShift)]);
    }
  }

  // Point-by-point average of aligned laps
  const result: { x: number; z: number; speed: number }[] = [];
  for (let i = 0; i < len; i++) {
    let sx = 0, sz = 0, ss = 0;
    for (const lap of aligned) {
      sx += lap[i].x;
      sz += lap[i].z;
      ss += lap[i].speed;
    }
    const n = aligned.length;
    result.push({ x: sx / n, z: sz / n, speed: ss / n });
  }

  return result;
}


function formatLapTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

