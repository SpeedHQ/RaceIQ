/**
 * Lap detection state machine.
 *
 * Forza streams telemetry at 60Hz but has no explicit "session start" or
 * "lap complete" event. We infer both from packet fields:
 *   - Session boundary: car/track ordinal change, or 30s silence gap
 *   - Lap boundary:     LapNumber field increments
 *   - Rewind:           TimestampMS decreases (marks lap invalid)
 *
 * Each completed lap's full packet buffer is persisted to SQLite.
 * Fuel and tire wear deltas are tracked per-lap for strategy overlays.
 */
import type { TelemetryPacket } from "../shared/types";
import { insertSession, insertLap } from "./db/queries";

const SESSION_TIMEOUT_MS = 30_000; // 30 seconds of silence = new session

interface SessionState {
  sessionId: number;
  carOrdinal: number;
  trackOrdinal: number;
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

class LapDetector {
  private currentSession: SessionState | null = null;
  private currentLapNumber: number = -1; // -1 = no lap yet (awaiting first packet)
  private lapBuffer: TelemetryPacket[] = []; // all packets for the in-progress lap
  private lapIsValid: boolean = true; // false if rewind detected mid-lap
  private lastTimestampMS: number = 0; // in-game timestamp for rewind detection
  private lastPacketTime: number = 0; // wall clock for silence timeout detection
  private distanceAtLapStart: number = 0;
  private fuelAtLapStart: number = -1; // -1 = not yet initialized
  private _fuelHistory: LapFuelData[] = []; // rolling window (last 50 laps)
  private tireWearAtLapStart = { fl: -1, fr: -1, rl: -1, rr: -1 };
  private _tireWearHistory: LapTireWearData[] = []; // rolling window (last 50 laps)

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
   * Feed a parsed telemetry packet into the detector.
   * Handles session creation, lap boundary detection, and rewind detection.
   */
  feed(packet: TelemetryPacket): void {
    const now = Date.now();

    // Check for new session conditions
    if (this.shouldStartNewSession(packet, now)) {
      // If we have a lap in progress, save it before starting new session
      this.finalizeLapIfNeeded(packet);
      this.startNewSession(packet);
    }

    // Rewind detection: TimestampMS decreased
    if (
      this.lastTimestampMS > 0 &&
      packet.TimestampMS < this.lastTimestampMS
    ) {
      this.lapIsValid = false;
      console.log(
        `[Lap] Rewind detected: timestamp went from ${this.lastTimestampMS} to ${packet.TimestampMS}. Marking lap invalid.`
      );
    }

    // Lap boundary detection: LapNumber incremented
    if (
      this.currentLapNumber >= 0 &&
      packet.LapNumber > this.currentLapNumber
    ) {
      this.onLapComplete(packet);
    }

    // Initialize lap tracking on first packet
    if (this.currentLapNumber < 0) {
      this.currentLapNumber = packet.LapNumber;
      this.distanceAtLapStart = packet.DistanceTraveled;
    }

    // Buffer the packet for the current lap
    this.lapBuffer.push(packet);
    this.lastTimestampMS = packet.TimestampMS;
    this.lastPacketTime = now;
  }

  private shouldStartNewSession(
    packet: TelemetryPacket,
    now: number
  ): boolean {
    if (!this.currentSession) return true;

    // Car or track changed
    if (packet.CarOrdinal !== this.currentSession.carOrdinal) {
      console.log(
        `[Session] Car changed: ${this.currentSession.carOrdinal} -> ${packet.CarOrdinal}`
      );
      return true;
    }
    if (packet.TrackOrdinal && packet.TrackOrdinal !== this.currentSession.trackOrdinal) {
      console.log(
        `[Session] Track changed: ${this.currentSession.trackOrdinal} -> ${packet.TrackOrdinal}`
      );
      return true;
    }

    // Silence timeout (>30s without a packet)
    if (
      this.lastPacketTime > 0 &&
      now - this.lastPacketTime > SESSION_TIMEOUT_MS
    ) {
      console.log(
        `[Session] Silence timeout: ${now - this.lastPacketTime}ms since last packet`
      );
      return true;
    }

    return false;
  }

  private startNewSession(packet: TelemetryPacket): void {
    const trackOrd = packet.TrackOrdinal ?? 0;
    const sessionId = insertSession(packet.CarOrdinal, trackOrd);
    this.currentSession = {
      sessionId,
      carOrdinal: packet.CarOrdinal,
      trackOrdinal: trackOrd,
    };
    this.currentLapNumber = -1;
    this.lapBuffer = [];
    this.lapIsValid = true;
    this.lastTimestampMS = 0;
    this.distanceAtLapStart = packet.DistanceTraveled;

    console.log(
      `[Session] New session #${sessionId} | Car: ${packet.CarOrdinal} | Class: ${packet.CarClass} | PI: ${packet.CarPerformanceIndex}`
    );
  }

  private onLapComplete(newLapFirstPacket: TelemetryPacket): void {
    if (!this.currentSession || this.lapBuffer.length === 0) {
      this.resetLapState(newLapFirstPacket);
      return;
    }

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

    // Skip saving if lap time is 0 (first lap, warmup, etc.)
    if (lapTime <= 0) {
      console.log(
        `[Lap] Skipping lap ${this.currentLapNumber} with zero time`
      );
      this.resetLapState(newLapFirstPacket);
      return;
    }

    try {
      const lapId = insertLap(
        this.currentSession.sessionId,
        this.currentLapNumber,
        lapTime,
        this.lapIsValid,
        this.lapBuffer
      );
      console.log(
        `[Lap] Saved lap ${this.currentLapNumber} | Time: ${formatLapTime(lapTime)} | Valid: ${this.lapIsValid} | Packets: ${this.lapBuffer.length} | DB ID: ${lapId}`
      );
    } catch (err) {
      console.error(
        `[Lap] Failed to save lap ${this.currentLapNumber}:`,
        err
      );
      // Don't crash — buffer is lost but server continues
    }

    this.resetLapState(newLapFirstPacket);
  }

  /** Best-effort save of an incomplete lap when the session ends mid-lap. */
  private finalizeLapIfNeeded(nextPacket: TelemetryPacket): void {
    // Try to save current in-progress lap when session changes
    if (
      this.currentSession &&
      this.lapBuffer.length > 0 &&
      this.currentLapNumber >= 0
    ) {
      // Use the last known CurrentLap as time estimate (not ideal but best we have)
      const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
      const lapTime = lastPacket.CurrentLap;
      if (lapTime > 0) {
        try {
          insertLap(
            this.currentSession.sessionId,
            this.currentLapNumber,
            lapTime,
            false, // Mark as invalid since lap wasn't properly completed
            this.lapBuffer
          );
          console.log(
            `[Lap] Saved incomplete lap ${this.currentLapNumber} (session ended)`
          );
        } catch (err) {
          console.error("[Lap] Failed to save incomplete lap:", err);
        }
      }
    }
  }

  private resetLapState(newLapFirstPacket: TelemetryPacket): void {
    this.currentLapNumber = newLapFirstPacket.LapNumber;
    this.lapBuffer = [];
    this.lapIsValid = true;
    this.distanceAtLapStart = newLapFirstPacket.DistanceTraveled;
    this.fuelAtLapStart = newLapFirstPacket.Fuel;
    this.tireWearAtLapStart = {
      fl: newLapFirstPacket.TireWearFL,
      fr: newLapFirstPacket.TireWearFR,
      rl: newLapFirstPacket.TireWearRL,
      rr: newLapFirstPacket.TireWearRR,
    };
  }
}

function formatLapTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

export const lapDetector = new LapDetector();
