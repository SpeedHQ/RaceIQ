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

class LapDetector {
  private currentSession: SessionState | null = null;
  private currentLapNumber: number = -1;
  private lapBuffer: TelemetryPacket[] = [];
  private lapIsValid: boolean = true;
  private lastTimestampMS: number = 0;
  private lastPacketTime: number = 0; // wall clock time of last received packet
  private distanceAtLapStart: number = 0;
  private fuelAtLapStart: number = -1;
  private _fuelHistory: LapFuelData[] = [];

  get session(): SessionState | null {
    return this.currentSession;
  }

  get fuelHistory(): LapFuelData[] {
    return this._fuelHistory;
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
  }
}

function formatLapTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

export const lapDetector = new LapDetector();
