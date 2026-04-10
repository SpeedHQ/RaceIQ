// server/lap-detector-v2.ts
import type { TelemetryPacket } from "@shared/types";
import type { DbAdapter } from "./pipeline-adapters";
import type { LapSavedNotification, SessionState } from "./lap-detector";

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
    const isReset = prev && prev.CurrentLap >= 30 && packet.CurrentLap <= 2;

    if (isReset) {
      if (this.firstLapIsPartial) {
        // Discard this partial lap — don't persist, don't emit, don't advance lapNumber
        this.firstLapIsPartial = false;
        this.lapBuffer = [];
        this.peakCurrentLap = 0;
        this.lapBuffer.push(packet);
        if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap;
        return;
      }

      const lapTime = this.peakCurrentLap;
      const lapNum = this.currentLapNumber;
      const packets = this.lapBuffer;

      const lapId = await this.db.insertLap(
        this.currentSession!.sessionId,
        lapNum,
        lapTime,
        true,
        packets,
        null,
        null,
        null,
        null
      );
      this.onLapSaved?.({
        type: "lap-saved",
        lapId,
        lapNumber: lapNum,
        lapTime,
        isValid: true,
        sectors: null,
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
