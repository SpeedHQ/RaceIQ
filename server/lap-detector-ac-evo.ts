import type { TelemetryPacket } from "@shared/types";
import type { ILapDetector, LapDetectorOptions } from "./lap-detector-interface";
import type { SessionState } from "./lap-detector";
import type { LapDetectorCallbacks } from "./lap-detector-interface";
import type { DbAdapter } from "./pipeline-adapters";
import { assessLapRecording } from "./lap-quality";
import { computeLapSectors } from "./compute-lap-sectors";
import { accFirstPacketIsMidLap, classifyAccPitLap } from "./acc-lap-rules";

export const LAP_DETECTOR_AC_EVO_ID = "ac_evo_lapdetector_v1";

export class LapDetectorAcEvo implements ILapDetector {
  readonly detectorId = LAP_DETECTOR_AC_EVO_ID;
  private readonly db: DbAdapter;
  private readonly onLapSaved?: LapDetectorCallbacks["onLapSaved"];
  private readonly onSessionStart?: LapDetectorCallbacks["onSessionStart"];
  private readonly onLapComplete_?: LapDetectorCallbacks["onLapComplete"];

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

  constructor(opts: LapDetectorOptions) {
    this.db = opts.db;
    this.onLapSaved = opts.callbacks?.onLapSaved;
    this.onSessionStart = opts.callbacks?.onSessionStart;
    this.onLapComplete_ = opts.callbacks?.onLapComplete;
  }

  get session(): SessionState | null {
    return this.currentSession;
  }

  /** Used by the pipeline to patch lap 1's byte offset when the session
   *  recorder was created mid-feed for the very first packet. */
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
      const sessionId = await this.db.insertSession(
        packet.CarOrdinal,
        packet.TrackOrdinal ?? 0,
        packet.gameId,
        packet.f1?.sessionType
      );
      this.currentSession = {
        sessionId,
        carOrdinal: packet.CarOrdinal,
        trackOrdinal: packet.TrackOrdinal ?? 0,
        carPI: packet.CarPerformanceIndex,
        gameId: packet.gameId,
        sessionUID: packet.sessionUID,
        bestLapTime: 0,
      };
      // AC Evo LapNumber = completedLaps+1 (1-indexed): lap 1 while driving the first lap.
      // Adopt game-reported value; fall back to 1 for synthetic/stale data.
      this.currentLapNumber = (packet.LapNumber ?? 0) > 0 ? packet.LapNumber! : 1;
      this.firstLapIsPartial = accFirstPacketIsMidLap(packet);
      this._lapByteOffset = this._currentRawByteOffset;
      this._lapFrameCount = 0;
      await this.onSessionStart?.(this.currentSession);
    }

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
        const isPitOnly = classifyAccPitLap(this.lapBuffer) === "pit lap";
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
    ) return;
    // Packets stopped arriving for 10s → game went to menu or replay (parser
    // returns null for AC_OFF/AC_REPLAY). End the session so the next time the
    // user enters a race a fresh session is created.
    await this.finalizeCurrentSession();
  }

  async finalizeCurrentSession(): Promise<void> {
    if (!this.currentSession) return;
    const sid = this.currentSession.sessionId;
    if (this.lapBuffer.length >= 10) {
      await this.emitLap("incomplete", { silent: true });
    }
    console.log(`[AC Evo Lap Detector] Finalized session ${sid}`);
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
    opts?: { silent?: boolean; trigger?: TelemetryPacket }
  ): Promise<void> {
    // AC Evo writes LastLap atomically with the lap-counter bump, so the
    // trigger packet's LastLap is the fresh value for this lap.
    const lastBufferedLastLap = this.lapBuffer[this.lapBuffer.length - 1]?.LastLap ?? 0;
    const gameLastLap = opts?.trigger?.LastLap ?? 0;
    const gameLastLapFresh = gameLastLap > 0 && gameLastLap !== lastBufferedLastLap;
    const lapTime = gameLastLapFresh ? gameLastLap : this.peakCurrentLap;
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

    const quality = assessLapRecording(packets, lapTime);
    let isValid = forcedInvalidReason ? false : quality.valid;
    let invalidReason = forcedInvalidReason ?? quality.reason;

    if (isValid) {
      const pitReason = classifyAccPitLap(packets);
      if (pitReason) {
        isValid = false;
        invalidReason = pitReason;
      }
    }

    const sectors = await computeLapSectors(
      this.currentSession!.trackOrdinal,
      this.currentSession!.gameId,
      packets,
      lapTime,
      undefined
    );

    if (isValid && (this.currentSession!.bestLapTime === 0 || lapTime < this.currentSession!.bestLapTime)) {
      this.currentSession!.bestLapTime = lapTime;
    }

    const lapId = await this.db.insertLap(
      this.currentSession!.sessionId,
      lapNum,
      lapTime,
      isValid,
      lapByteOffset,
      lapFrameCount,
      null,
      null,
      invalidReason,
      sectors
    );
    if (!opts?.silent) {
      this.onLapSaved?.({
        type: "lap-saved",
        lapId,
        lapNumber: lapNum,
        lapTime,
        isValid,
        sectors,
        estimatedBestLapTime: this.currentSession!.bestLapTime,
      });
      this.onLapComplete_?.({
        packets,
        lapDistStart: packets[0]?.DistanceTraveled ?? 0,
        lapTime,
        isValid,
        sectors,
      });
    }
  }
}
