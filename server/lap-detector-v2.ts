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

  constructor(opts: LapDetectorV2Options) {
    this.db = opts.db;
    this.onLapSaved = opts.onLapSaved;
    this.onSessionStart = opts.onSessionStart;
    this.onLapComplete_ = opts.onLapComplete;
  }

  get session(): SessionState | null {
    return this.currentSession;
  }

  async feed(_packet: TelemetryPacket): Promise<void> {
    // Implemented in subsequent tasks
  }
}
