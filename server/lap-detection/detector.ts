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
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import {
  EMPTY_LAP_TIMELINE_CONTEXT,
  type ILapDetector,
  type LapDetectorCallbacks,
  type LapDetectorOptions,
  type SessionEndReason,
} from "./types";
import type { RaceEventId } from "../../shared/racing/events/contracts";
import { extractCurbSegments, recordCurbData } from "../../shared/racing/tracks/recording/curbs";
import { recordLapTrace } from "../../shared/racing/tracks/recording/outlines";
import { getIRacingSharedTrackName } from "../../shared/racing/tracks/catalogs/iracing";
import { lapPath } from "../../shared/racing/tracks/path";
import { assessLapRecording } from "../lap-analysis/quality";
import { classifyLap, type LapClassification } from "../../shared/racing/laps/classification";
import {
  LOCAL_PLAYER_EVIDENCE,
  type EligibilityDecisionSet,
  type EvidenceSourceKind,
  type LapQualitySummary,
  type ParticipantEvidence,
  type SourceChannelProfile,
} from "../../shared/racing/quality/contracts";
import { summarizeLapQuality } from "../../shared/racing/quality/measure";
import { evaluateAllEligibility, isEligibilityUsable } from "../../shared/racing/quality/policies";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { currentTelemetryVersionIdentity } from "../telemetry/version-identity";
import { updateLapCarSetup } from "../db/lap-mutation-queries";
import { reconcileAutoExclusionsForLap } from "../experiments/auto-exclude";
import { detectSessionBoundary, detectLapBoundary, detectLapReset, type SessionBoundaryReason } from "./boundaries";

export interface SessionState {
  sessionId: number;
  carOrdinal: number;
  trackOrdinal: number;
  carPI: number;
  gameId: GameId;
  analysisGenerationId?: string | null;
  sessionUID?: string; // F1 session UID for reliable session boundary detection
  bestLapTime: number; // best valid pace lap in current session (0 = none yet)
}

export interface LapEventContext {
  session: Readonly<SessionState>;
  lapNumber: number;
  eventIds: RaceEventId[];
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

export interface LapSavedEvent extends LapClassification {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  sectors: number[] | null;
  estimatedBestLapTime: number; // best valid pace lap in session (0 if none)
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
}
export interface LapSavedNotification extends LapSavedEvent {
  type: "lap-saved";
}

/** Bump this whenever lap detection logic changes — triggers UI prompt to reprocess old sessions. */
export const LAP_DETECTOR_ID = "lapdetector_v4";

export interface LapCompleteEvent extends LapClassification {
  packets: TelemetryPacket[];
  lapDistStart: number;
  lapTime: number;
  isValid: boolean;
  sectors: number[] | null;
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
}

export class LapDetector implements ILapDetector {
  readonly detectorId = LAP_DETECTOR_ID;
  private readonly bypassPacketRateFilter: boolean;
  private readonly sourceKind: EvidenceSourceKind;
  private readonly participant: ParticipantEvidence;
  private readonly versionIdentity?: TelemetryVersionIdentity;
  private readonly sourceChannelProfile?: SourceChannelProfile;
  private readonly lapTimelineContext: NonNullable<LapDetectorOptions["lapTimelineContext"]>;
  private db: LapDetectorOptions["db"];

  onSessionStart?: LapDetectorCallbacks["onSessionStart"];
  onSessionEnd?: LapDetectorCallbacks["onSessionEnd"];
  onLapEvaluated?: LapDetectorCallbacks["onLapEvaluated"];
  onLapComplete_?: LapDetectorCallbacks["onLapComplete"];
  onLapSaved?: LapDetectorCallbacks["onLapSaved"];

  constructor(opts: LapDetectorOptions) {
    this.db = opts.db;
    this.bypassPacketRateFilter = opts.bypassPacketRateFilter ?? false;
    this.sourceKind = opts.sourceKind ?? "native-live";
    this.participant = opts.participant ?? LOCAL_PLAYER_EVIDENCE;
    this.versionIdentity = opts.versionIdentity;
    this.sourceChannelProfile = opts.sourceChannelProfile;
    this.lapTimelineContext = opts.lapTimelineContext ?? EMPTY_LAP_TIMELINE_CONTEXT;
    this.onSessionStart = opts.callbacks?.onSessionStart;
    this.onSessionEnd = opts.callbacks?.onSessionEnd;
    this.onLapEvaluated = opts.callbacks?.onLapEvaluated;
    this.onLapComplete_ = opts.callbacks?.onLapComplete;
    this.onLapSaved = opts.callbacks?.onLapSaved;
  }

  private currentSession: SessionState | null = null;
  private currentLapNumber: number = -1; // -1 = no lap yet (awaiting first packet)
  private lapBuffer: TelemetryPacket[] = []; // all packets for the in-progress lap
  private lapIsValid: boolean = true; // false if rewind detected mid-lap
  private invalidReason: string | null = null;
  private _loggedFeedOnce: boolean = false; // debug flag to log feed start once
  private lastLastLap: number = 0; // track LastLap changes for final-lap detection
  private lastTimestampMS: number = 0; // in-game timestamp for rewind detection
  private lastPacketTime: number = 0; // wall clock for silence timeout detection
  private recentPacketCount: number = 0; // packets in the last second
  private lastRateCheck: number = 0; // wall clock of last rate measurement
  private packetRate: number = 0; // estimated packets per second
  private _distanceAtLapStart: number = 0;
  private fuelAtLapStart: number = -1; // -1 = not yet initialized
  private _fuelHistory: LapFuelData[] = []; // rolling window (last 50 laps)
  private tireWearAtLapStart = { fl: -1, fr: -1, rl: -1, rr: -1 };
  private _tireWearHistory: LapTireWearData[] = []; // rolling window (last 50 laps)
  private _lapByteOffset: number | null = null;
  private _lapFrameCount: number = 0;
  private _currentRawByteOffset: number | null = null;
  private readonly _pendingLapWrites = new Map<number, Set<Promise<void>>>();
  private readonly _lapWriteFailures = new Map<number, { error: unknown }>();

  get session(): SessionState | null {
    return this.currentSession;
  }

  get fuelHistory(): LapFuelData[] {
    return this._fuelHistory;
  }

  get tireWearHistory(): LapTireWearData[] {
    return this._tireWearHistory;
  }

  /**
   * Overwrite the current lap's byte offset. Used by the pipeline when the
   * session recorder is created mid-feed and the first packet is written
   * retroactively — the detector itself never saw a valid offset for that
   * packet, so lap 1 would otherwise start at null.
   */
  setCurrentLapByteOffset(offset: number): void {
    this._lapByteOffset = offset;
    this._currentRawByteOffset = offset;
  }

  /**
   * Finalize the current session immediately (e.g., when game process disconnects).
   * Clears session state without waiting for silence timeout.
   */
  async finalizeCurrentSession(reason: SessionEndReason = "source-disconnected"): Promise<void> {
    if (!this.currentSession) return;
    const session = { ...this.currentSession };
    console.log(`[Lap Detector] Finalizing session ${session.sessionId}: ${reason}`);
    let failure: unknown;
    try {
      await this.finalizeLapIfNeeded();
    } catch (error) {
      failure = error;
    }
    try {
      await this.waitForPendingLapWrites(session.sessionId);
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.onSessionEnd?.(session, { reason, terminalObserved: false });
    } finally {
      this.currentSession = null;
      this.lapBuffer = [];
    }
    if (failure) throw failure;
  }

  /**
   * Feed a parsed telemetry packet into the detector.
   * Handles session creation, lap boundary detection, and rewind detection.
   */
  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    this._currentRawByteOffset = rawByteOffset ?? null;
    // Debug: log if lap detector receives any packets
    if (!this._loggedFeedOnce) {
      console.log("[Lap Detector] Started receiving packets from pipeline");
      this._loggedFeedOnce = true;
    }

    const now = Date.now();

    // Track packet rate to distinguish active driving from post-race trickle
    this.recentPacketCount++;
    if (now - this.lastRateCheck >= 1000) {
      this.packetRate = this.recentPacketCount;
      this.recentPacketCount = 0;
      this.lastRateCheck = now;
    }

    // Ignore trickle packets (< 30 pps) — post-race/menu screens send
    // sporadic packets that cause ghost sessions and bad data
    if (!this.bypassPacketRateFilter && this.currentSession && this.packetRate > 0 && this.packetRate < 30) {
      this.lastPacketTime = now;
      return;
    }

    // Check for new session conditions
    const sessionBoundaryReason = this.sessionBoundaryReason(packet, now);
    if (sessionBoundaryReason) {
      // If we have a lap in progress, save it before starting new session
      await this.finalizeLapIfNeeded();
      // Durable session finalization drains these writes. Waiting here would
      // block the new recorder and lose packets while the old DB write stalls.
      if (this.currentSession) {
        await this.onSessionEnd?.({ ...this.currentSession }, { reason: sessionBoundaryReason, terminalObserved: false });
        this.currentSession = null;
        this.lapBuffer = [];
        this.currentLapNumber = -1;
      }
      await this.startNewSession(packet, sessionBoundaryReason);
    }

    // Race restart / final lap detection
    if (this.currentLapNumber >= 0 && this.lapBuffer.length > 30 && packet.LapNumber === this.currentLapNumber) {
      const resetResult = detectLapReset(this.lapBuffer[this.lapBuffer.length - 1], this.lastLastLap, packet);
      if (resetResult.action === "complete-final-lap") {
        console.log(`[Lap] Final lap completed: LastLap ${this.lastLastLap.toFixed(3)} -> ${packet.LastLap.toFixed(3)}`);
        await this.onLapComplete(packet);
      } else if (resetResult.action === "reset-restart") {
        console.log(`[Lap] Race restart detected — discarding buffer`);
        this.resetLapState(packet);
      }
    }

    // Rewind detection: TimestampMS decreased (within same lap)
    if (this.lastTimestampMS > 0 && packet.TimestampMS < this.lastTimestampMS && packet.LapNumber === this.currentLapNumber) {
      if (this.lapIsValid) {
        console.log(`[Lap] Rewind: timestamp ${this.lastTimestampMS} -> ${packet.TimestampMS}. Marking lap invalid.`);
      }
      this.invalidateLap("rewind");
    }

    // Lap boundary detection
    if (this.currentLapNumber >= 0 && packet.LapNumber !== this.currentLapNumber) {
      const lapResult = detectLapBoundary(this.currentLapNumber, packet);
      if (lapResult.action === "reset-rewind") {
        console.log(`[Lap] Rewind across lap boundary: ${this.currentLapNumber} -> ${packet.LapNumber}. Discarding buffer.`);
        this.resetLapState(packet);
      } else if (lapResult.action === "complete-skip") {
        console.log(`[Lap] Lap skip: ${this.currentLapNumber} -> ${packet.LapNumber}. Marking invalid.`);
        this.invalidateLap(lapResult.invalidReason);
        await this.onLapComplete(packet);
      } else {
        await this.onLapComplete(packet);
      }
    }

    this.lastLastLap = packet.LastLap;

    // Initialize lap tracking on first packet
    if (this.currentLapNumber < 0) {
      this.currentLapNumber = packet.LapNumber;
      this._distanceAtLapStart = packet.DistanceTraveled;
      // Seed byte offset from the current packet so lap 1 points to where
      // it actually starts in the current session's .bin file (not the
      // previous session's stale offset).
      this._lapByteOffset = this._currentRawByteOffset;
      this._lapFrameCount = 0;
    }

    // Buffer the packet for the current lap
    this.lapBuffer.push(packet);
    this._lapFrameCount++;
    this.lastTimestampMS = packet.TimestampMS;
    this.lastPacketTime = now;
  }

  private sessionBoundaryReason(packet: TelemetryPacket, now: number) {
    const lastDist = this.lapBuffer.length > 0 ? this.lapBuffer[this.lapBuffer.length - 1].DistanceTraveled : null;
    const reason = detectSessionBoundary(this.currentSession, this.currentLapNumber, lastDist, this.lastPacketTime, packet, now);
    if (reason) console.log(`[Session] New session: ${reason}`);
    return reason;
  }

  private async startNewSession(packet: TelemetryPacket, reason: SessionBoundaryReason): Promise<void> {
    const trackOrd = packet.TrackOrdinal ?? 0;
    const gameId = packet.gameId;
    const sessionType = packet.f1?.sessionType;
    let sessionId: number;
    try {
      sessionId = await this.db.insertSession(packet.CarOrdinal, trackOrd, gameId, sessionType, this.versionIdentity, this.sourceKind, this.sourceChannelProfile);
    } catch (err) {
      console.error(`[LapDetector] Failed to insert session:`, (err as Error).message);
      return;
    }
    this.currentSession = {
      sessionId,
      carOrdinal: packet.CarOrdinal,
      trackOrdinal: trackOrd,
      carPI: packet.CarPerformanceIndex,
      gameId,
      sessionUID: packet.sessionUID,
      bestLapTime: 0,
    };
    this.currentLapNumber = -1;
    this.lapBuffer = [];
    this.lapIsValid = true;
    this.invalidReason = null;
    this.lastTimestampMS = 0;
    this._distanceAtLapStart = packet.DistanceTraveled;
    // Reset raw-file bookkeeping so lap 1 of this session doesn't inherit
    // byte offsets/frame counts from the previous session's .bin file.
    this._lapByteOffset = null;
    this._lapFrameCount = 0;

    console.log(`[Session] New session #${sessionId} | Car: ${packet.CarOrdinal} | Class: ${packet.CarClass} | PI: ${packet.CarPerformanceIndex}${sessionType ? ` | Type: ${sessionType}` : ""}`);

    await this.onSessionStart?.(this.currentSession!, { reason, packet });
  }

  private async onLapComplete(newLapFirstPacket: TelemetryPacket): Promise<void> {
    if (!this.currentSession || this.lapBuffer.length === 0) {
      this.resetLapState(newLapFirstPacket);
      return;
    }
    const session = this.currentSession;

    // Record fuel usage
    const fuelEnd = this.lapBuffer[this.lapBuffer.length - 1].Fuel;
    if (this.fuelAtLapStart >= 0) {
      this._fuelHistory.push({
        lap: this.currentLapNumber,
        fuelStart: this.fuelAtLapStart,
        fuelEnd,
        fuelUsed: this.fuelAtLapStart - fuelEnd,
      });
      // Keep last 50 laps
      if (this._fuelHistory.length > 50) this._fuelHistory.shift();
    }

    // Record tire wear
    const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
    if (this.tireWearAtLapStart.fl >= 0) {
      const end = { fl: lastPacket.TireWearFL, fr: lastPacket.TireWearFR, rl: lastPacket.TireWearRL, rr: lastPacket.TireWearRR };
      const start = this.tireWearAtLapStart;
      this._tireWearHistory.push({
        lap: this.currentLapNumber,
        start: { ...start },
        end,
        worn: {
          fl: start.fl - end.fl,
          fr: start.fr - end.fr,
          rl: start.rl - end.rl,
          rr: start.rr - end.rr,
        },
      });
      if (this._tireWearHistory.length > 50) this._tireWearHistory.shift();
    }

    // Use LastLap from the first packet of the new lap as authoritative lap time
    const lapTime = newLapFirstPacket.LastLap;

    // Running-start trim: strip pre-start-line packets
    this.trimRunningStartPackets();

    // Skip saving if lap time is too short (first lap, warmup, ghost fragments)
    if (lapTime < 10) {
      console.log(`[Lap] Skipping lap ${this.currentLapNumber} with time ${lapTime.toFixed(3)}s (< 10s)`);
      this.resetLapState(newLapFirstPacket);
      return;
    }

    {
      const tuneAssignment = await this.db.getTuneAssignment(session.gameId, session.carOrdinal, session.trackOrdinal);
      const tuneId = tuneAssignment?.tuneId ?? null;
      const lapNum = this.currentLapNumber;
      const packetCount = this.lapBuffer.length;

      // Structural validity and pace classification remain independent.
      const recordingAssessment = assessLapRecording(this.lapBuffer, lapTime);
      const classification = classifyLap(this.lapTimelineContext.classificationForLap(session.sessionId, lapNum));
      const valid = this.lapIsValid && recordingAssessment.valid;
      const invalidReason = this.invalidReason ?? recordingAssessment.reason;
      const versionIdentity = this.versionIdentity ?? currentTelemetryVersionIdentity(session.gameId);
      const quality = summarizeLapQuality({
        packets: this.lapBuffer,
        lapTime,
        timingSource: "simulator-last-lap",
        complete: true,
        structurallyValid: valid,
        invalidReason,
        classification,
        sourceKind: this.sourceKind,
        participant: this.participant,
        versionIdentity,
        sourceChannelProfile: this.sourceChannelProfile,
      });
      const eligibility = evaluateAllEligibility(quality);
      const normalPaceEligible = valid && classification.paceEligibility === "eligible" && isEligibilityUsable(eligibility["normal-pace"]);

      if (normalPaceEligible && (session.bestLapTime === 0 || lapTime < session.bestLapTime)) {
        session.bestLapTime = lapTime;
      }

      const event: LapCompleteEvent = {
        packets: this.lapBuffer,
        lapDistStart: this.lapBuffer[0].DistanceTraveled,
        lapTime,
        isValid: valid,
        ...classification,
        sectors: null,
        quality,
        eligibility,
      };
      const context: LapEventContext = {
        session: { ...session },
        lapNumber: lapNum,
        eventIds: this.lapTimelineContext.eventIdsForLap(session.sessionId, lapNum),
      };
      await this.onLapEvaluated?.(event, context);

      // iRacing exposes heading, speed, and native LapDistPct but no public
      // world position. Keep RaceIQ's existing recorded-outline fallback warm
      // for layouts without exact shared geometry (or when the official SVG
      // cannot be reached). Higher-quality shared/SVG sources still win in the
      // outline resolver.
      if (normalPaceEligible && session.gameId === "iracing" && session.trackOrdinal > 0 && !getIRacingSharedTrackName(session.trackOrdinal)) {
        const path = lapPath(this.lapBuffer);
        const trace = path.x.map((x, index) => ({
          x,
          z: path.z[index],
        }));
        recordLapTrace(session.trackOrdinal, trace, trace[0] ?? null, this.lapBuffer[0]?.Yaw ?? null, "iracing");
      }

      if (normalPaceEligible) {
        await this.onLapComplete_?.(event, context);
      }

      // Capture the frame buffer before resetLapState reassigns it; completion
      // followups still persist F1 setup metadata from this recording boundary.
      const lapPackets = this.lapBuffer;
      this.trackLapWrite(
        context.session.sessionId,
        this.db
          .insertLap({
            sessionId: context.session.sessionId,
            lapNumber: lapNum,
            lapTime,
            isValid: valid,
            rawByteOffset: this._lapByteOffset,
            rawFrameCount: this._lapFrameCount,
            profileId: null,
            tuneId,
            invalidReason,
            sectors: event.sectors,
            classification,
            quality,
            eligibility,
            versionIdentity,
          })
          .then(async (lapId) => {
            // Precompute fuel/tyre metrics now (frames in memory) so /lap-metrics
            // never decodes on first open.
            await this.persistLapFollowups(lapId, lapPackets);
            console.log(`[Lap] Saved lap ${lapNum} | Time: ${formatLapTime(lapTime)} | Valid: ${valid}${invalidReason ? ` (${invalidReason})` : ""} | Packets: ${packetCount} | DB ID: ${lapId}`);
            await this.onLapSaved?.(
              {
                lapId,
                lapNumber: lapNum,
                lapTime,
                isValid: valid,
                ...classification,
                sectors: event.sectors,
                estimatedBestLapTime: context.session.bestLapTime,
                quality,
                eligibility,
              },
              context,
            );
          }),
        `[Lap] Failed to save lap ${lapNum}:`,
      );

      // Extract and record curb data from laps allowed for normal-pace geometry seeding.
      if (normalPaceEligible && session.trackOrdinal > 0 && this.lapBuffer.length > 50) {
        const curbSegments = extractCurbSegments(this.lapBuffer);
        if (curbSegments.length > 0) {
          recordCurbData(session.trackOrdinal, curbSegments, session.gameId);
        }
      }
    }

    this.resetLapState(newLapFirstPacket);
  }

  /** Best-effort save of an incomplete lap when the session ends mid-lap. */
  private async finalizeLapIfNeeded(): Promise<void> {
    // Try to save current in-progress lap when session changes
    if (this.currentSession && this.lapBuffer.length > 0 && this.currentLapNumber >= 0) {
      const session = this.currentSession;
      const lapNumber = this.currentLapNumber;
      this.trimRunningStartPackets();
      // Use the last known CurrentLap as time estimate (not ideal but best we have)
      const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
      const lapTime = lastPacket.CurrentLap;
      if (lapTime >= 10) {
        const tuneAssignment = await this.db.getTuneAssignment(session.gameId, session.carOrdinal, session.trackOrdinal);
        const lapPackets = this.lapBuffer;
        const classification = classifyLap(this.lapTimelineContext.classificationForLap(session.sessionId, lapNumber));
        const versionIdentity = this.versionIdentity ?? currentTelemetryVersionIdentity(session.gameId);
        const quality = summarizeLapQuality({
          packets: lapPackets,
          lapTime,
          timingSource: "estimated",
          complete: false,
          structurallyValid: false,
          invalidReason: "incomplete",
          classification,
          sourceKind: this.sourceKind,
          participant: this.participant,
          versionIdentity,
          sourceChannelProfile: this.sourceChannelProfile,
        });
        const eligibility = evaluateAllEligibility(quality);
        this.trackLapWrite(
          session.sessionId,
          this.db
            .insertLap({
              sessionId: session.sessionId,
              lapNumber,
              lapTime,
              isValid: false,
              rawByteOffset: this._lapByteOffset,
              rawFrameCount: this._lapFrameCount,
              profileId: null,
              tuneId: tuneAssignment?.tuneId ?? null,
              invalidReason: "incomplete",
              sectors: null,
              classification,
              quality,
              eligibility,
              versionIdentity,
            })
            .then(async (lapId) => {
              await this.persistLapFollowups(lapId, lapPackets);
              console.log(`[Lap] Saved incomplete lap (session ended)`);
            }),
          "[Lap] Failed to save incomplete lap:",
        );
      }
    }
  }

  /**
   * Flush a stale in-progress lap when packets stop arriving (e.g. race ended).
   * Called periodically from a timer — saves the buffered lap if no packets
   * have been received for >10 seconds and there's meaningful data.
   */
  async flushStaleLap(): Promise<void> {
    if (!this.currentSession || this.lapBuffer.length < 30 || this.currentLapNumber < 0 || this.lastPacketTime === 0) return;
    const session = this.currentSession;

    const silenceMs = Date.now() - this.lastPacketTime;
    if (silenceMs < 10_000) return;

    this.trimRunningStartPackets();
    if (this.lapBuffer.length < 30) return;

    const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
    const lapTime =
      lastPacket.LastLap > 0 && lastPacket.LastLap !== this.lastLastLap
        ? lastPacket.LastLap // game reported a final lap time
        : lastPacket.CurrentLap; // use elapsed time as best estimate

    if (lapTime < 10) return; // ignore trivial fragments (e.g. post-race trickle packets)

    // Use LastLap if it was updated (authoritative), otherwise mark as incomplete
    const isComplete = lastPacket.LastLap > 0 && lastPacket.LastLap !== this.lastLastLap;

    {
      const tuneAssignment = await this.db.getTuneAssignment(session.gameId, session.carOrdinal, session.trackOrdinal);
      const lapNum = this.currentLapNumber;
      const packetCount = this.lapBuffer.length;
      const lapPackets = this.lapBuffer;
      const recordingAssessment = assessLapRecording(lapPackets, lapTime);
      const classification = classifyLap(this.lapTimelineContext.classificationForLap(session.sessionId, lapNum));
      const valid = isComplete && this.lapIsValid && recordingAssessment.valid;
      const invalidReason = isComplete ? (this.invalidReason ?? recordingAssessment.reason) : "incomplete";
      const versionIdentity = this.versionIdentity ?? currentTelemetryVersionIdentity(session.gameId);
      const quality = summarizeLapQuality({
        packets: lapPackets,
        lapTime,
        timingSource: isComplete ? "simulator-last-lap" : "estimated",
        complete: isComplete,
        structurallyValid: valid,
        invalidReason,
        classification,
        sourceKind: this.sourceKind,
        participant: this.participant,
        versionIdentity,
        sourceChannelProfile: this.sourceChannelProfile,
      });
      const eligibility = evaluateAllEligibility(quality);
      let completedEvent: LapCompleteEvent | null = null;
      if (isComplete) {
        const context: LapEventContext = {
          session: { ...session },
          lapNumber: lapNum,
          eventIds: this.lapTimelineContext.eventIdsForLap(session.sessionId, lapNum),
        };
        completedEvent = {
          packets: lapPackets,
          lapDistStart: lapPackets[0].DistanceTraveled,
          lapTime,
          isValid: valid,
          ...classification,
          sectors: null,
          quality,
          eligibility,
        };
        await this.onLapEvaluated?.(completedEvent, context);
      }
      this.trackLapWrite(
        session.sessionId,
        this.db
          .insertLap({
            sessionId: session.sessionId,
            lapNumber: lapNum,
            lapTime,
            isValid: valid,
            rawByteOffset: this._lapByteOffset,
            rawFrameCount: this._lapFrameCount,
            profileId: null,
            tuneId: tuneAssignment?.tuneId ?? null,
            invalidReason,
            sectors: completedEvent?.sectors ?? null,
            classification,
            quality,
            eligibility,
            versionIdentity,
          })
          .then(async (lapId) => {
            await this.persistLapFollowups(lapId, lapPackets);
            console.log(
              `[Lap] Flushed stale lap ${lapNum} | Time: ${formatLapTime(lapTime)} | ${isComplete ? "Complete" : "Incomplete"} | Packets: ${packetCount} | DB ID: ${lapId} (${(silenceMs / 1000).toFixed(0)}s silence)`,
            );
          }),
        "[Lap] Failed to flush stale lap:",
      );
    }

    // Reset state so we don't flush again
    this.lapBuffer = [];
    this.currentLapNumber = -1;
    this.lastPacketTime = 0;
  }

  /**
   * Strip leading packets from before a CurrentLap reset (running start).
   * In practice/meetup sessions the buffer may start mid-previous-lap;
   * find the last large CurrentLap drop and discard everything before it.
   */
  private trimRunningStartPackets(): void {
    if (this.lapBuffer.length <= 1) return;
    let resetIdx = 0;
    for (let i = 1; i < this.lapBuffer.length; i++) {
      if (this.lapBuffer[i - 1].CurrentLap > 5 && this.lapBuffer[i].CurrentLap < 1) {
        resetIdx = i;
      }
    }
    // Only trim if the reset is in the first half of the buffer.
    // A true running-start reset happens early (mid-previous-lap data at the front).
    // A lap-end reset happens at the very end and must not be treated as a running start.
    if (resetIdx > 0 && resetIdx < this.lapBuffer.length / 2) {
      console.log(`[Lap] Trimmed ${resetIdx} pre-start packets (running start), ${this.lapBuffer.length - resetIdx} remain`);
      this.lapBuffer = this.lapBuffer.slice(resetIdx);
    }
  }

  private async persistLapFollowups(lapId: number, lapPackets: TelemetryPacket[]): Promise<void> {
    const setup = lapPackets.find((packet) => packet.f1?.setup)?.f1?.setup;
    if (setup) {
      try {
        await updateLapCarSetup(lapId, setup);
      } catch (error) {
        console.error("[Lap] updateLapCarSetup failed:", error);
      }
    }
    try {
      await reconcileAutoExclusionsForLap(this.db, lapId);
    } catch (error) {
      console.error("[Lap] reconcileAutoExclusionsForLap failed:", error);
    }
  }

  private trackLapWrite(sessionId: number, pending: Promise<void>, failureMessage: string): void {
    const pendingWrites = this._pendingLapWrites.get(sessionId) ?? new Set<Promise<void>>();
    pendingWrites.add(pending);
    this._pendingLapWrites.set(sessionId, pendingWrites);
    void pending.then(
      () => pendingWrites.delete(pending),
      (error) => {
        pendingWrites.delete(pending);
        if (!this._lapWriteFailures.has(sessionId)) {
          this._lapWriteFailures.set(sessionId, { error });
        }
        console.error(failureMessage, error);
      },
    );
  }

  async waitForPendingLapWrites(sessionId: number): Promise<void> {
    const pendingWrites = this._pendingLapWrites.get(sessionId);
    while (pendingWrites && pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
    }
    this._pendingLapWrites.delete(sessionId);
    const failure = this._lapWriteFailures.get(sessionId);
    this._lapWriteFailures.delete(sessionId);
    if (failure) throw failure.error;
  }

  private invalidateLap(reason: string): void {
    this.lapIsValid = false;
    this.invalidReason = reason;
  }

  private resetLapState(newLapFirstPacket: TelemetryPacket): void {
    this.currentLapNumber = newLapFirstPacket.LapNumber;
    this.lapBuffer = [];
    this.lapIsValid = true;
    this.invalidReason = null;
    this.lastLastLap = newLapFirstPacket.LastLap;
    this._distanceAtLapStart = newLapFirstPacket.DistanceTraveled;
    this._lapByteOffset = this._currentRawByteOffset;
    this._lapFrameCount = 0;
    this.fuelAtLapStart = newLapFirstPacket.Fuel;
    this.tireWearAtLapStart = {
      fl: newLapFirstPacket.TireWearFL,
      fr: newLapFirstPacket.TireWearFR,
      rl: newLapFirstPacket.TireWearRL,
      rr: newLapFirstPacket.TireWearRR,
    };
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
      tireWearHistoryLength: this._tireWearHistory?.length ?? 0,
    };
  }
}

/**
 * Smooth an outline using a circular moving average (wraps around start/finish).
 */
export function smoothOutline(points: { x: number; z: number }[], window: number = 5): { x: number; z: number }[] {
  const n = points.length;
  const half = Math.floor(window / 2);
  return points.map((_, i) => {
    let sx = 0,
      sz = 0;
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
export function normalizeToFixedPoints(raw: { x: number; z: number; speed: number }[], targetPoints: number): { x: number; z: number; speed: number }[] {
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
export function filterLapOutliers(points: { x: number; z: number; speed: number }[]): { x: number; z: number; speed: number }[] {
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
export function averageOutlines(laps: { x: number; z: number; speed: number }[][]): { x: number; z: number; speed: number }[] {
  if (laps.length === 0) return [];
  if (laps.length === 1) return laps[0];

  const len = laps[0].length;
  const ref = laps[0];

  // Align each lap to the reference by finding the best circular shift
  const aligned: typeof laps = [ref];
  for (let l = 1; l < laps.length; l++) {
    const lap = laps[l];
    if (lap.length !== len) {
      aligned.push(lap);
      continue;
    }

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
      if (err < bestError) {
        bestError = err;
        bestShift = shift;
      }
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
      if (err < bestError) {
        bestError = err;
        bestShift = shift;
      }
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
    let sx = 0,
      sz = 0,
      ss = 0;
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
