import type { TelemetryPacket } from "../../../shared/telemetry/types";
import {
  currentTelemetryVersionIdentity,
  type DbAdapter,
} from "../../telemetry/pipeline-ports";
import {
  LOCAL_PLAYER_EVIDENCE,
  type EvidenceSourceKind,
  type ParticipantEvidence,
  type SourceChannelProfile,
} from "../../../shared/racing/quality/contracts";
import type { TelemetryVersionIdentity } from "../../../shared/telemetry/version";
import {
  assessLapRecording,
  measureLapQuality,
  type LapQualityCaptureContext,
} from "../../lap-analysis/quality";
import { persistLapMetrics } from "../../lap-analysis/metrics-store";
import { reconcileAutoExclusionsForLap } from "../../experiments/auto-exclude";
import { computeLapSectors } from "../../lap-analysis/sectors";
import {
  EMPTY_LAP_TIMELINE_CONTEXT,
  type ILapDetector,
  type LapDetectorCallbacks,
  type LapDetectorOptions,
  type SessionEndReason,
  type SessionState,
} from "../../lap-detection/types";
import { kunosFirstPacketIsMidLap } from "./lap-rules";
import { classifyLap } from "../../../shared/racing/laps/classification";
import { isEligibilityUsable } from "../../../shared/racing/quality/policies";

/** Shared Kunos (ACC / AC Evo) lap detector state machine. */
export abstract class KunosLapDetector implements ILapDetector {
  readonly detectorId: string;
  private readonly loggerLabel: string;

  private readonly lapTimelineContext: NonNullable<
    LapDetectorOptions["lapTimelineContext"]
  >;
  protected readonly db: DbAdapter;
  private readonly onLapSaved?: LapDetectorCallbacks["onLapSaved"];
  private readonly onSessionStart?: LapDetectorCallbacks["onSessionStart"];
  private readonly onSessionEnd?: LapDetectorCallbacks["onSessionEnd"];
  private readonly onLapEvaluated?: LapDetectorCallbacks["onLapEvaluated"];
  private readonly onLapComplete_?: LapDetectorCallbacks["onLapComplete"];
  private readonly sourceKind: EvidenceSourceKind;
  private readonly participant: ParticipantEvidence;
  private readonly versionIdentity?: TelemetryVersionIdentity;
  private readonly sourceChannelProfile?: SourceChannelProfile;

  private currentSession: SessionState | null = null;
  private lapBuffer: TelemetryPacket[] = [];
  private currentLapNumber = -1;

  // Running peak of CurrentLap within the current lap — the thing we actually trust
  private peakCurrentLap = 0;

  // Flag: if true, discard the next reset (recording started mid-lap)
  private firstLapIsPartial = false;

  // Duplicate-emit guard: TripletAssembler's setInterval fires at 100Hz without
  // waiting for the previous async callback. If emitLap is still awaiting DB writes
  // when the next tick arrives, the same lap could be saved twice. Track the last
  // emitted lap number — if emitLap is triggered again for the same number, ignore it.
  private _lastEmittedLapNumber = -1;
  private _lapByteOffset: number | null = null;
  private _lapFrameCount = 0;
  private _currentRawByteOffset: number | null = null;
  private _lastActivePacketTime = 0;
  protected constructor(
    opts: LapDetectorOptions,
    detectorId: string,
    loggerLabel: string,
  ) {
    this.db = opts.db;
    this.lapTimelineContext =
      opts.lapTimelineContext ?? EMPTY_LAP_TIMELINE_CONTEXT;
    this.onLapSaved = opts.callbacks?.onLapSaved;
    this.onSessionStart = opts.callbacks?.onSessionStart;
    this.onSessionEnd = opts.callbacks?.onSessionEnd;
    this.onLapEvaluated = opts.callbacks?.onLapEvaluated;
    this.onLapComplete_ = opts.callbacks?.onLapComplete;
    this.sourceKind = opts.sourceKind ?? "native-live";
    this.participant =
      opts.participant ?? LOCAL_PLAYER_EVIDENCE;
    this.versionIdentity = opts.versionIdentity;
    this.sourceChannelProfile = opts.sourceChannelProfile;
    this.detectorId = detectorId;
    this.loggerLabel = loggerLabel;
  }

  get session(): SessionState | null {
    return this.currentSession;
  }

  /** Used by the pipeline to patch lap 1's byte offset when the session
   * recorder was created mid-feed for the very first packet. */
  setCurrentLapByteOffset(offset: number): void {
    this._lapByteOffset = offset;
    this._currentRawByteOffset = offset;
  }

  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    this._lastActivePacketTime = Date.now();
    if (rawByteOffset !== undefined) {
      if (this._currentRawByteOffset === null) {
        this._lapByteOffset = rawByteOffset;
      }
      this._currentRawByteOffset = rawByteOffset;
      this._lapFrameCount++;
    }
    if (!this.currentSession) {
      const carOrdinalResult = this.resolveCarOrdinal(packet);
      const resolvedCarOrdinal = typeof carOrdinalResult === "number" ? carOrdinalResult : await carOrdinalResult;
      const qualityContext: LapQualityCaptureContext = {
        sourceKind: this.sourceKind,
        participant: this.participant,
        versionIdentity:
          this.versionIdentity ??
          currentTelemetryVersionIdentity(packet.gameId),
        sourceChannelProfile: this.sourceChannelProfile,
      };
      const sessionId = await this.db.insertSession(
        resolvedCarOrdinal,
        packet.TrackOrdinal ?? 0,
        packet.gameId,
        packet.f1?.sessionType,
        qualityContext.versionIdentity,
        qualityContext.sourceKind,
        qualityContext.sourceChannelProfile,
      );
      this.currentSession = {
        sessionId,
        carOrdinal: resolvedCarOrdinal,
        trackOrdinal: packet.TrackOrdinal ?? 0,
        carPI: packet.CarPerformanceIndex,
        gameId: packet.gameId,
        sessionUID: packet.sessionUID,
        bestLapTime: 0,
      };
      // LapNumber is 1-indexed in production parser counters.
      this.currentLapNumber = (packet.LapNumber ?? 0) > 0 ? packet.LapNumber! : 1;
      this.firstLapIsPartial = kunosFirstPacketIsMidLap(packet);
      this._lapByteOffset = this._currentRawByteOffset;
      this._lapFrameCount = 0;
      await this.onSessionStart?.(this.currentSession, {
        reason: "no-session",
        packet,
      });
    }

    const backfill = this.backfillSessionIdentifiers(packet);
    if (backfill) await backfill;

    const prev = this.lapBuffer[this.lapBuffer.length - 1];

    // Session restart detection: distance went backward by >100m
    if (prev && packet.DistanceTraveled < prev.DistanceTraveled - 100) {
      this.lapBuffer = [];
      this.peakCurrentLap = 0;
      this.firstLapIsPartial = false;
      this._lapByteOffset = this._currentRawByteOffset;
      this._lapFrameCount = 0;
      this.lapBuffer.push(packet);
      if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
      return;
    }

    const isReset = prev && prev.CurrentLap >= 30 && packet.CurrentLap <= 2;

    if (isReset) {
      if (this.firstLapIsPartial) {
        const bufStart = this.lapBuffer[0]?.DistanceTraveled ?? 0;
        const bufEnd = this.lapBuffer[this.lapBuffer.length - 1]?.DistanceTraveled ?? 0;
        const bufDist = bufEnd - bufStart;
        const isPitOnly =
          this.lapTimelineContext.classificationForLap(
            this.currentSession.sessionId,
            this.currentLapNumber,
          ).pitPhase === "pit";
        if (bufDist < 100 || isPitOnly) {
          this.lapBuffer = [];
          this.peakCurrentLap = 0;
          this.firstLapIsPartial = false;
          this._lapByteOffset = this._currentRawByteOffset;
          this._lapFrameCount = 0;
          this.lapBuffer.push(packet);
          if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
          return;
        }
        this.firstLapIsPartial = false;
      }

      await this.emitLap(null, { trigger: packet });
    }

    this.lapBuffer.push(packet);
    if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
  }

  async flushIncompleteLap(): Promise<void> {
    if (!this.currentSession || this.lapBuffer.length < 10) return;
    await this.emitLap("incomplete", { silent: true });
    this.lapBuffer = [];
    this.peakCurrentLap = 0;
  }

  async flushStaleLap(): Promise<void> {
    if (
      !this.currentSession ||
      this._lastActivePacketTime === 0 ||
      Date.now() - this._lastActivePacketTime < 10_000
    ) {
      return;
    }
    // Packets stopped arriving for 10s — end session so next race start
    // creates fresh session.
    await this.finalizeCurrentSession("source-stale");
  }

  async finalizeCurrentSession(
    reason: SessionEndReason = "source-disconnected",
  ): Promise<void> {
    if (!this.currentSession) return;
    const session = { ...this.currentSession };
    const sid = session.sessionId;
    if (this.lapBuffer.length >= 10) {
      await this.emitLap("incomplete", { silent: true });
    }
    await this.onSessionEnd?.(session, {
      reason,
      terminalObserved: false,
    });
    console.log(`${this.loggerLabel} Finalized session ${sid}`);
    this.currentSession = null;
    this.lapBuffer = [];
    this.peakCurrentLap = 0;
    this.firstLapIsPartial = false;
    this._lapByteOffset = null;
    this._currentRawByteOffset = null;
    this._lapFrameCount = 0;
    this._lastActivePacketTime = 0;
    this._lastEmittedLapNumber = -1;
    this.currentLapNumber = -1;
  }

  private async emitLap(
    forcedInvalidReason: string | null,
    opts?: { silent?: boolean; trigger?: TelemetryPacket },
  ): Promise<void> {
    if (!this.currentSession) return;
    const session = this.currentSession;

    // Kunos publishes LastLap around timer reset. Use only fresh value.
    const lastBufferedLastLap =
      this.lapBuffer[this.lapBuffer.length - 1]?.LastLap ?? 0;
    const gameLastLap = opts?.trigger?.LastLap ?? 0;
    const gameLastLapFresh =
      gameLastLap > 0 && gameLastLap !== lastBufferedLastLap;
    const lapTime = gameLastLapFresh
      ? gameLastLap
      : this.peakCurrentLap;
    const lapNum = this.currentLapNumber;

    if (lapNum === this._lastEmittedLapNumber) return;
    this._lastEmittedLapNumber = lapNum;

    const packets = this.lapBuffer;
    if (opts?.trigger) packets.push(opts.trigger);
    const lapByteOffset = this._lapByteOffset;
    const lapFrameCount = this._lapFrameCount;
    this.lapBuffer = [];
    this.peakCurrentLap = 0;
    this.currentLapNumber = lapNum + 1;
    this._lapByteOffset = this._currentRawByteOffset;
    this._lapFrameCount = 0;

    const recordingAssessment = assessLapRecording(packets, lapTime);
    const classification = classifyLap(
      this.lapTimelineContext.classificationForLap(
        session.sessionId,
        lapNum,
      ),
    );
    const complete = forcedInvalidReason === null;
    let isValid = complete && recordingAssessment.valid;
    let invalidReason =
      forcedInvalidReason ?? recordingAssessment.reason;
    if (isValid) {
      const cutReason = this.classifyTrackLimits(packets);
      if (cutReason) {
        isValid = false;
        invalidReason = cutReason;
      }
    }

    const sectors = await computeLapSectors(
      session.trackOrdinal,
      session.gameId,
      packets,
      lapTime,
      undefined,
    );
    const qualityContext: LapQualityCaptureContext = {
      sourceKind: this.sourceKind,
      participant: this.participant,
      versionIdentity:
        this.versionIdentity ??
        currentTelemetryVersionIdentity(session.gameId),
      sourceChannelProfile: this.sourceChannelProfile,
    };
    const measuredQuality = measureLapQuality(qualityContext, {
      packets,
      lapTime,
      timingSource: !complete
        ? "estimated"
        : gameLastLapFresh
          ? "simulator-last-lap"
          : "telemetry-elapsed",
      complete,
      isValid,
      invalidReason,
      classification,
    });
    const { quality, eligibility } = measuredQuality;
    const normalPaceEligible =
      isValid &&
      classification.paceEligibility === "eligible" &&
      isEligibilityUsable(eligibility["normal-pace"]);

    if (
      normalPaceEligible &&
      (session.bestLapTime === 0 || lapTime < session.bestLapTime)
    ) {
      session.bestLapTime = lapTime;
    }

    const event = {
      packets,
      lapDistStart: packets[0]?.DistanceTraveled ?? 0,
      lapTime,
      isValid,
      ...classification,
      sectors,
      quality,
      eligibility,
    };
    const context = {
      session: { ...session },
      lapNumber: lapNum,
      eventIds: this.lapTimelineContext.eventIdsForLap(
        session.sessionId,
        lapNum,
      ),
    };
    if (complete) {
      await this.onLapEvaluated?.(event, context);
    }

    const lapId = await this.db.insertLap({
      sessionId: session.sessionId,
      lapNumber: lapNum,
      lapTime,
      isValid,
      rawByteOffset: lapByteOffset,
      rawFrameCount: lapFrameCount,
      profileId: null,
      tuneId: null,
      invalidReason,
      sectors,
      classification,
      quality,
      eligibility,
      versionIdentity: qualityContext.versionIdentity,
    });
    await persistLapMetrics(this.db, lapId, packets);
    await reconcileAutoExclusionsForLap(this.db, lapId);

    if (!opts?.silent) {
      if (normalPaceEligible) {
        await this.onLapComplete_?.(event, context);
      }
      await this.onLapSaved?.(
        {
          type: "lap-saved",
          lapId,
          lapNumber: lapNum,
          lapTime,
          isValid,
          ...classification,
          sectors,
          estimatedBestLapTime: context.session.bestLapTime,
          quality,
          eligibility,
        },
        context,
      );
    }
  }

  /** ACC uses the parser-provided ordinal; AC Evo overrides this hook. */
  protected resolveCarOrdinal(packet: TelemetryPacket): number | Promise<number> {
    return packet.CarOrdinal;
  }

  /** ACC keeps no per-packet identifier backfill; AC Evo overrides this hook. */
  protected backfillSessionIdentifiers(_packet: TelemetryPacket): void | Promise<void> {}

  /** ACC does not invalidate laps from Kunos track-limit flags. */
  protected classifyTrackLimits(_packets: TelemetryPacket[]): "track limits" | null {
    return null;
  }
}
