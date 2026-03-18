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
import { insertSession, insertLap, saveTrackOutline, hasRecordedOutline } from "./db/queries";
import { hasTrackOutline } from "../shared/track-outlines/index";

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

    // Auto-record track outline if no bundled or recorded outline exists
    this.maybeRecordTrackOutline(this.currentSession.trackOrdinal, this.lapBuffer);

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

  /**
   * If no bundled or previously recorded outline exists for this track,
   * extract positions from the lap buffer, smooth them, auto-compute sectors,
   * and save everything to the database.
   */
  private maybeRecordTrackOutline(trackOrdinal: number, buffer: TelemetryPacket[]): void {
    if (trackOrdinal <= 0) return;

    // Skip if a bundled outline already exists
    if (hasTrackOutline(trackOrdinal)) return;

    // Skip if we already recorded one
    if (hasRecordedOutline(trackOrdinal)) return;

    try {
      // Extract PositionX/Z, skip zero positions
      const raw: { x: number; z: number; speed: number }[] = [];
      for (const p of buffer) {
        if (p.PositionX === 0 && p.PositionZ === 0) continue;
        raw.push({ x: p.PositionX, z: p.PositionZ, speed: (p.Speed ?? 0) * 2.23694 });
      }

      if (raw.length < 50) return; // Not enough data

      // Downsample to ~300-400 points
      const targetPoints = 350;
      const step = Math.max(1, Math.floor(raw.length / targetPoints));
      const downsampled: { x: number; z: number; speed: number }[] = [];
      for (let i = 0; i < raw.length; i += step) {
        downsampled.push(raw[i]);
      }

      // Smooth with moving average (window=5)
      const smoothed = smoothOutline(downsampled, 5);

      // Re-attach speed values from downsampled
      const points = smoothed.map((p, i) => ({
        x: p.x,
        z: p.z,
        speed: downsampled[i]?.speed ?? 0,
      }));

      // Auto-compute sectors from geometry
      const sectors = computeSectorsFromGeometry(points);

      // Save to database
      saveTrackOutline(trackOrdinal, points, sectors);

      console.log(
        `[Track] Auto-recorded outline for track ${trackOrdinal}: ${points.length} points`
      );
    } catch (err) {
      console.error(`[Track] Failed to auto-record outline for track ${trackOrdinal}:`, err);
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

/**
 * Smooth an outline using a simple moving average.
 */
function smoothOutline(
  points: { x: number; z: number }[],
  window: number = 5
): { x: number; z: number }[] {
  const half = Math.floor(window / 2);
  return points.map((_, i) => {
    let sx = 0,
      sz = 0,
      count = 0;
    for (
      let j = Math.max(0, i - half);
      j <= Math.min(points.length - 1, i + half);
      j++
    ) {
      sx += points[j].x;
      sz += points[j].z;
      count++;
    }
    return { x: sx / count, z: sz / count };
  });
}

/**
 * Auto-compute 3 sectors from track geometry by finding the two largest
 * braking zones (clusters of high direction change). Returns sector
 * boundaries as fractions of total outline length.
 */
function computeSectorsFromGeometry(
  points: { x: number; z: number; speed?: number }[]
): { s1End: number; s2End: number } {
  const n = points.length;
  if (n < 30) return { s1End: 0.333, s2End: 0.666 };

  // Compute direction change (curvature) at each point
  const curvature: number[] = [];
  const window = Math.max(2, Math.floor(n / 80));

  for (let i = 0; i < n; i++) {
    const prev = (i - window + n) % n;
    const next = (i + window) % n;
    const dx1 = points[i].x - points[prev].x;
    const dz1 = points[i].z - points[prev].z;
    const dx2 = points[next].x - points[i].x;
    const dz2 = points[next].z - points[i].z;
    const angle1 = Math.atan2(dz1, dx1);
    const angle2 = Math.atan2(dz2, dx2);
    let diff = angle2 - angle1;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    curvature.push(Math.abs(diff));
  }

  // Smooth curvature
  const smoothWindow = Math.max(2, Math.floor(n / 40));
  const smoothed: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -smoothWindow; j <= smoothWindow; j++) {
      sum += curvature[(i + j + n) % n];
    }
    smoothed.push(sum / (smoothWindow * 2 + 1));
  }

  // Find peaks: local maxima of smoothed curvature above median
  const sorted = [...smoothed].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(n * 0.75)]; // 75th percentile

  // Collect peak clusters (high-curvature zones)
  type Cluster = { centerFrac: number; peakValue: number };
  const clusters: Cluster[] = [];
  let inCluster = false;
  let clusterStart = 0;
  let clusterPeak = 0;
  let clusterPeakIdx = 0;

  for (let i = 0; i < n; i++) {
    if (smoothed[i] > threshold) {
      if (!inCluster) {
        inCluster = true;
        clusterStart = i;
        clusterPeak = smoothed[i];
        clusterPeakIdx = i;
      } else if (smoothed[i] > clusterPeak) {
        clusterPeak = smoothed[i];
        clusterPeakIdx = i;
      }
    } else if (inCluster) {
      inCluster = false;
      const centerIdx = Math.floor((clusterStart + clusterPeakIdx) / 2);
      clusters.push({
        centerFrac: centerIdx / n,
        peakValue: clusterPeak,
      });
    }
  }
  // Close final cluster if still open
  if (inCluster) {
    const centerIdx = Math.floor((clusterStart + clusterPeakIdx) / 2);
    clusters.push({
      centerFrac: centerIdx / n,
      peakValue: clusterPeak,
    });
  }

  if (clusters.length < 2) {
    // Not enough features detected — use equal thirds
    return { s1End: 0.333, s2End: 0.666 };
  }

  // Sort by peak curvature descending, take top 2
  clusters.sort((a, b) => b.peakValue - a.peakValue);
  const top2 = clusters.slice(0, 2).sort((a, b) => a.centerFrac - b.centerFrac);

  let s1End = top2[0].centerFrac;
  let s2End = top2[1].centerFrac;

  // Ensure minimum sector size of 15%
  if (s1End < 0.15) s1End = 0.15;
  if (s2End < s1End + 0.15) s2End = s1End + 0.15;
  if (s2End > 0.85) s2End = 0.85;
  if (s1End > s2End - 0.15) s1End = s2End - 0.15;

  return {
    s1End: Math.round(s1End * 1000) / 1000,
    s2End: Math.round(s2End * 1000) / 1000,
  };
}

function formatLapTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

export const lapDetector = new LapDetector();
