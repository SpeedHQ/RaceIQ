// server/lap-detector-v2.ts
import type { TelemetryPacket } from "@shared/types";
import type { ILapDetector, LapDetectorOptions } from "./lap-detector-interface";
import type { LapSavedNotification, SessionState } from "./lap-detector";
import { assessLapRecording } from "./lap-quality";
import { computeLapSectors } from "./compute-lap-sectors";
import { accFirstPacketIsMidLap, classifyAccPitLap } from "./acc-lap-rules";

/** @deprecated Use LapDetectorOptions from lap-detector-interface instead. */
export interface LapDetectorV2Options {
  db: import("./pipeline-adapters").DbAdapter;
  onLapSaved?: (n: LapSavedNotification) => void;
  onSessionStart?: (s: SessionState) => void;
  onLapComplete?: (args: {
    packets: TelemetryPacket[];
    lapDistStart: number;
    lapTime: number;
    isValid: boolean;
    sectors: { s1: number; s2: number; s3: number } | null;
  }) => void;
}

export class LapDetectorV2 implements ILapDetector {
  private readonly db: import("./pipeline-adapters").DbAdapter;
  private readonly onLapSaved?: LapDetectorV2Options["onLapSaved"];
  private readonly onSessionStart?: LapDetectorV2Options["onSessionStart"];
  private readonly onLapComplete_?: LapDetectorV2Options["onLapComplete"];

  private currentSession: SessionState | null = null;
  private lapBuffer: TelemetryPacket[] = [];
  private currentLapNumber = -1;

  // Running peak of CurrentLap within the current lap — the thing we actually trust
  private peakCurrentLap = 0;

  // Flag: if true, discard the next reset (recording started mid-lap)
  private firstLapIsPartial = false;

  constructor(opts: LapDetectorOptions | LapDetectorV2Options) {
    // Support both unified LapDetectorOptions and legacy LapDetectorV2Options
    if ("callbacks" in opts || !("onLapSaved" in opts && "db" in opts && !("callbacks" in opts))) {
      // New-style: LapDetectorOptions (has .callbacks sub-object, or is a plain {db} object)
      const o = opts as LapDetectorOptions;
      this.db = o.db;
      this.onLapSaved = o.callbacks?.onLapSaved as LapDetectorV2Options["onLapSaved"] | undefined;
      this.onSessionStart = o.callbacks?.onSessionStart as LapDetectorV2Options["onSessionStart"] | undefined;
      this.onLapComplete_ = o.callbacks?.onLapComplete as LapDetectorV2Options["onLapComplete"] | undefined;
    } else {
      // Legacy style: LapDetectorV2Options with top-level callbacks
      const o = opts as LapDetectorV2Options;
      this.db = o.db;
      this.onLapSaved = o.onLapSaved;
      this.onSessionStart = o.onSessionStart;
      this.onLapComplete_ = o.onLapComplete;
    }
  }

  get session(): SessionState | null {
    return this.currentSession;
  }

  async feed(packet: TelemetryPacket): Promise<void> {
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
      this.currentLapNumber = 0;
      this.firstLapIsPartial = accFirstPacketIsMidLap(packet);
      await this.onSessionStart?.(this.currentSession);
    }

    const prev = this.lapBuffer[this.lapBuffer.length - 1];

    // Session restart detection: distance went backward by >100m
    if (prev && packet.DistanceTraveled < prev.DistanceTraveled - 100) {
      // Abandon in-progress lap, keep the new packet as lap start
      this.lapBuffer = [];
      this.peakCurrentLap = 0;
      this.firstLapIsPartial = false;
      this.lapBuffer.push(packet);
      if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
      return;
    }

    const isReset = prev && prev.CurrentLap >= 30 && packet.CurrentLap <= 2;

    if (isReset) {
      if (this.firstLapIsPartial) {
        // Recording started mid-lap. If the buffer is a trivial timer-glitch
        // fragment (< 100m of distance), skip it entirely and keep the flag
        // set so the NEXT reset (the real lap) is the one we emit. Otherwise
        // clear the flag and let normal emission run — the pit-lane rule in
        // emitLap will mark it as "outlap" if the lap started in the pit.
        const bufStart = this.lapBuffer[0]?.DistanceTraveled ?? 0;
        const bufEnd = this.lapBuffer[this.lapBuffer.length - 1]?.DistanceTraveled ?? 0;
        const bufDist = bufEnd - bufStart;
        if (bufDist < 100) {
          this.lapBuffer = [];
          this.peakCurrentLap = 0;
          this.lapBuffer.push(packet);
          if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
          return;
        }
        this.firstLapIsPartial = false;
      }

      await this.emitLap(null);
    }

    this.lapBuffer.push(packet);
    if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
  }

  /**
   * Flush any in-progress lap at end-of-stream as an incomplete (invalid) lap.
   * Called by the pipeline/test harness when packets stop arriving (e.g. recording ends).
   *
   * Matches v1 behavior: writes to the DB but does NOT fire onLapSaved. Consumers
   * (test assertions, live UI) treat incomplete laps as "finalized after the fact"
   * rather than a real lap-completion event.
   */
  async flushIncompleteLap(): Promise<void> {
    if (!this.currentSession || this.lapBuffer.length < 10) return;
    await this.emitLap("incomplete", { silent: true });
    this.lapBuffer = [];
    this.peakCurrentLap = 0;
  }

  /** Emit the current lapBuffer as a saved lap. Callers clear state afterwards. */
  private async emitLap(
    forcedInvalidReason: string | null,
    opts?: { silent?: boolean }
  ): Promise<void> {
    const lapTime = this.peakCurrentLap;
    const lapNum = this.currentLapNumber;
    const packets = this.lapBuffer;

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
      this.db,
      this.currentSession!.trackOrdinal,
      this.currentSession!.gameId,
      packets,
      lapTime,
      // ACC live sectors not yet tracked in v2 — falls back to distance-fraction
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
      packets,
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

    this.currentLapNumber = lapNum + 1;
    this.lapBuffer = [];
    this.peakCurrentLap = 0;
  }
}
