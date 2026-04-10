// server/lap-detector-v2.ts
import type { TelemetryPacket } from "@shared/types";
import type { DbAdapter } from "./pipeline-adapters";
import type { LapSavedNotification, SessionState } from "./lap-detector";
import { assessLapRecording } from "./lap-quality";
import { computeLapSectors } from "./compute-lap-sectors";

export interface LapDetectorV2Options {
  db: DbAdapter;
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

export class LapDetectorV2 {
  private readonly db: DbAdapter;
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

  constructor(opts: LapDetectorV2Options) {
    this.db = opts.db;
    this.onLapSaved = opts.onLapSaved;
    this.onSessionStart = opts.onSessionStart;
    this.onLapComplete_ = opts.onLapComplete;
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
      this.firstLapIsPartial = packet.CurrentLap > 5;
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
        // Discard this partial lap — don't persist, don't emit, don't advance lapNumber.
        // If the discarded buffer had < 100m distance it was a trivial fragment (e.g. the
        // timer restarted briefly at session start); keep firstLapIsPartial=true so the
        // next real lap boundary is also discarded (it's the true joining lap).
        const bufStart = this.lapBuffer[0]?.DistanceTraveled ?? 0;
        const bufEnd = this.lapBuffer[this.lapBuffer.length - 1]?.DistanceTraveled ?? 0;
        const bufDist = bufEnd - bufStart;
        if (bufDist >= 100) {
          this.firstLapIsPartial = false;
        }
        // else: keep firstLapIsPartial=true to also discard the next lap boundary
        this.lapBuffer = [];
        this.peakCurrentLap = 0;
        this.lapBuffer.push(packet);
        if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
        return;
      }

      const lapTime = this.peakCurrentLap;
      const lapNum = this.currentLapNumber;
      const packets = this.lapBuffer;

      const quality = assessLapRecording(packets, lapTime);
      const isValid = quality.valid;
      const invalidReason = quality.reason;

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
      this.onLapSaved?.({
        type: "lap-saved",
        lapId,
        lapNumber: lapNum,
        lapTime,
        isValid,
        sectors,
        estimatedBestLapTime: this.currentSession!.bestLapTime,
      });

      this.currentLapNumber = lapNum + 1;
      this.lapBuffer = [];
      this.peakCurrentLap = 0;
    }

    this.lapBuffer.push(packet);
    if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
  }
}
