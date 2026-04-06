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
import type { TelemetryPacket, GameId } from "../shared/types";
import { insertSession, insertLap } from "./db/queries";
import { extractCurbSegments, recordCurbData } from "../shared/track-data";
import { loadSettings } from "./settings";
import { getTuneAssignment } from "./db/tune-queries";

const SESSION_TIMEOUT_MS = 5 * 60_000; // 5 minutes of silence = new session

export interface SessionState {
  sessionId: number;
  carOrdinal: number;
  trackOrdinal: number;
  gameId: GameId;
  sessionUID?: string; // F1 session UID for reliable session boundary detection
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
  onSessionStart?: (session: SessionState) => void | Promise<void>;

  private currentSession: SessionState | null = null;
  private currentLapNumber: number = -1; // -1 = no lap yet (awaiting first packet)
  private lapBuffer: TelemetryPacket[] = []; // all packets for the in-progress lap
  private lapIsValid: boolean = true; // false if rewind detected mid-lap
  private invalidReason: string | null = null;
  private lastLastLap: number = 0; // track LastLap changes for final-lap detection
  private lastTimestampMS: number = 0; // in-game timestamp for rewind detection
  private lastPacketTime: number = 0; // wall clock for silence timeout detection
  private recentPacketCount: number = 0; // packets in the last second
  private lastRateCheck: number = 0; // wall clock of last rate measurement
  private packetRate: number = 0; // estimated packets per second
  // @ts-ignore — distance tracking for future delta calculations
  private _distanceAtLapStart: number = 0;
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
  async feed(packet: TelemetryPacket): Promise<void> {
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
    if (this.currentSession && this.packetRate > 0 && this.packetRate < 30) {
      this.lastPacketTime = now;
      return;
    }

    // Check for new session conditions
    if (this.shouldStartNewSession(packet, now)) {
      // If we have a lap in progress, save it before starting new session
      await this.finalizeLapIfNeeded(packet);
      await this.startNewSession(packet);
    }

    // Race restart / final lap detection: CurrentLap resets to 0 mid-lap,
    // or distance jumps backwards significantly.
    if (
      this.currentLapNumber >= 0 &&
      this.lapBuffer.length > 30 &&
      packet.LapNumber === this.currentLapNumber
    ) {
      const lastPkt = this.lapBuffer[this.lapBuffer.length - 1];

      // CurrentLap reset to 0 while we had meaningful lap time
      const lapTimeReset = lastPkt.CurrentLap > 5 && packet.CurrentLap === 0;

      // Large distance drop (>500m backwards)
      const distanceDrop = lastPkt.DistanceTraveled - packet.DistanceTraveled > 500;

      if (lapTimeReset || distanceDrop) {
        // If LastLap changed, this is a completed lap (final race lap or
        // lap completion where LapNumber didn't increment), not a restart.
        const lastLapChanged = packet.LastLap > 0 && this.lastLastLap > 0 && packet.LastLap !== this.lastLastLap;

        if (lastLapChanged) {
          console.log(
            `[Lap] Final lap completed: LastLap changed ${this.lastLastLap.toFixed(3)} -> ${packet.LastLap.toFixed(3)}`
          );
          await this.onLapComplete(packet);
        } else {
          console.log(
            `[Lap] Race restart detected: ${lapTimeReset ? `CurrentLap ${lastPkt.CurrentLap.toFixed(1)}s -> ${packet.CurrentLap.toFixed(1)}s` : ""}${lapTimeReset && distanceDrop ? ", " : ""}${distanceDrop ? `Distance ${lastPkt.DistanceTraveled.toFixed(0)} -> ${packet.DistanceTraveled.toFixed(0)}` : ""}. Discarding buffer.`
          );
          this.resetLapState(packet);
        }
      }
    }

    // Rewind detection: TimestampMS decreased (within same lap)
    if (
      this.lastTimestampMS > 0 &&
      packet.TimestampMS < this.lastTimestampMS &&
      packet.LapNumber === this.currentLapNumber
    ) {
      if (this.lapIsValid) {
        console.log(
          `[Lap] Rewind detected: timestamp went from ${this.lastTimestampMS} to ${packet.TimestampMS}. Marking lap invalid.`
        );
      }
      this.lapIsValid = false;
      this.invalidReason = "rewind";
    }

    // Lap boundary detection
    if (this.currentLapNumber >= 0 && packet.LapNumber !== this.currentLapNumber) {
      if (packet.LapNumber < this.currentLapNumber) {
        // Rewind across lap boundary — buffer has mixed-lap data, discard and reset
        console.log(
          `[Lap] Rewind across lap boundary: lap ${this.currentLapNumber} -> ${packet.LapNumber}. Discarding buffer.`
        );
        this.resetLapState(packet);
      } else if (packet.LapNumber > this.currentLapNumber + 1) {
        // Lap skip — jumped more than 1 lap, buffer spans multiple laps
        console.log(
          `[Lap] Lap skip detected: lap ${this.currentLapNumber} -> ${packet.LapNumber} (skipped ${packet.LapNumber - this.currentLapNumber - 1}). Marking invalid.`
        );
        this.lapIsValid = false;
        this.invalidReason = "lap skip";
        await this.onLapComplete(packet);
      } else {
        // Normal lap increment (+1)
        await this.onLapComplete(packet);
      }
    }

    this.lastLastLap = packet.LastLap;

    // Initialize lap tracking on first packet
    if (this.currentLapNumber < 0) {
      this.currentLapNumber = packet.LapNumber;
      this._distanceAtLapStart = packet.DistanceTraveled;
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

    // F1: session UID change is the authoritative signal
    if (packet.sessionUID && this.currentSession.sessionUID &&
        packet.sessionUID !== this.currentSession.sessionUID) {
      console.log(
        `[Session] F1 sessionUID changed: ${this.currentSession.sessionUID} -> ${packet.sessionUID}`
      );
      return true;
    }

    // Lap number reset (e.g. new race on same track) — if we were on lap 3+
    // and lap number drops back to 1, it's a new session
    if (
      this.currentLapNumber > 1 &&
      packet.LapNumber === 1 &&
      packet.LapNumber < this.currentLapNumber
    ) {
      console.log(
        `[Session] Lap number reset: ${this.currentLapNumber} -> ${packet.LapNumber} (new race)`
      );
      return true;
    }

    // DistanceTraveled reset — total distance dropped significantly
    // Skip for games with session UIDs (F1) — distance resets during qualifying/practice
    // are normal (out-lap → flying lap) and the UID handles real session changes
    if (
      !this.currentSession.sessionUID &&
      this.lapBuffer.length > 0 &&
      this.lapBuffer[this.lapBuffer.length - 1].DistanceTraveled > 1000 &&
      packet.DistanceTraveled < 500
    ) {
      console.log(
        `[Session] Distance reset: ${this.lapBuffer[this.lapBuffer.length - 1].DistanceTraveled.toFixed(0)} -> ${packet.DistanceTraveled.toFixed(0)} (new race)`
      );
      return true;
    }

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

    // Silence timeout — only for games without a session UID
    if (
      !this.currentSession.sessionUID &&
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

  private async startNewSession(packet: TelemetryPacket): Promise<void> {
    const trackOrd = packet.TrackOrdinal ?? 0;
    const gameId = packet.gameId;
    const sessionType = packet.f1?.sessionType;
    let sessionId: number;
    try {
      sessionId = await insertSession(packet.CarOrdinal, trackOrd, gameId, sessionType);
    } catch (err) {
      console.error(`[LapDetector] Failed to insert session:`, (err as Error).message);
      return;
    }
    this.currentSession = {
      sessionId,
      carOrdinal: packet.CarOrdinal,
      trackOrdinal: trackOrd,
      gameId,
      sessionUID: packet.sessionUID,
    };
    this.currentLapNumber = -1;
    this.lapBuffer = [];
    this.lapIsValid = true;
    this.invalidReason = null;
    this.lastTimestampMS = 0;
    this._distanceAtLapStart = packet.DistanceTraveled;

    console.log(
      `[Session] New session #${sessionId} | Car: ${packet.CarOrdinal} | Class: ${packet.CarClass} | PI: ${packet.CarPerformanceIndex}${sessionType ? ` | Type: ${sessionType}` : ""}`
    );

    this.onSessionStart?.(this.currentSession!);
  }

  private async onLapComplete(newLapFirstPacket: TelemetryPacket): Promise<void> {
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

    // Skip saving if lap time is too short (first lap, warmup, ghost fragments)
    if (lapTime < 10) {
      console.log(
        `[Lap] Skipping lap ${this.currentLapNumber} with time ${lapTime.toFixed(3)}s (< 10s)`
      );
      this.resetLapState(newLapFirstPacket);
      return;
    }

    {
      const { activeProfileId } = loadSettings();
      const tuneAssignment = await getTuneAssignment(
        this.currentSession.carOrdinal,
        this.currentSession.trackOrdinal
      );
      const tuneId = tuneAssignment?.tuneId ?? null;
      const lapNum = this.currentLapNumber;
      const valid = this.lapIsValid;
      const packetCount = this.lapBuffer.length;
      insertLap(
        this.currentSession.sessionId,
        lapNum,
        lapTime,
        valid,
        this.lapBuffer,
        activeProfileId,
        tuneId,
        this.invalidReason
      ).then((lapId) => {
        console.log(
          `[Lap] Saved lap ${lapNum} | Time: ${formatLapTime(lapTime)} | Valid: ${valid} | Packets: ${packetCount} | DB ID: ${lapId}`
        );
      }).catch((err) => {
        console.error(`[Lap] Failed to save lap ${lapNum}:`, err);
      });
    }


    // Extract and record curb data from any valid lap
    if (this.lapIsValid && this.currentSession.trackOrdinal > 0 && this.lapBuffer.length > 50) {
      const curbSegments = extractCurbSegments(this.lapBuffer);
      if (curbSegments.length > 0) {
        recordCurbData(this.currentSession.trackOrdinal, curbSegments, this.currentSession.gameId);
      }
    }

    this.resetLapState(newLapFirstPacket);
  }

  /** Best-effort save of an incomplete lap when the session ends mid-lap. */
  private async finalizeLapIfNeeded(_nextPacket: TelemetryPacket): Promise<void> {
    // Try to save current in-progress lap when session changes
    if (
      this.currentSession &&
      this.lapBuffer.length > 0 &&
      this.currentLapNumber >= 0
    ) {
      // Use the last known CurrentLap as time estimate (not ideal but best we have)
      const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
      const lapTime = lastPacket.CurrentLap;
      if (lapTime >= 10) {
          const { activeProfileId } = loadSettings();
          const tuneAssignment = await getTuneAssignment(
            this.currentSession.carOrdinal,
            this.currentSession.trackOrdinal
          );
          insertLap(
            this.currentSession.sessionId,
            this.currentLapNumber,
            lapTime,
            false,
            this.lapBuffer,
            activeProfileId,
            tuneAssignment?.tuneId ?? null,
            "incomplete"
          ).then(() => {
            console.log(`[Lap] Saved incomplete lap (session ended)`);
          }).catch((err) => {
            console.error("[Lap] Failed to save incomplete lap:", err);
          });
      }
    }
  }

  /**
   * Flush a stale in-progress lap when packets stop arriving (e.g. race ended).
   * Called periodically from a timer — saves the buffered lap if no packets
   * have been received for >10 seconds and there's meaningful data.
   */
  async flushStaleLap(): Promise<void> {
    if (
      !this.currentSession ||
      this.lapBuffer.length < 30 ||
      this.currentLapNumber < 0 ||
      this.lastPacketTime === 0
    ) return;

    const silenceMs = Date.now() - this.lastPacketTime;
    if (silenceMs < 10_000) return;

    const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
    const lapTime = lastPacket.LastLap > 0 && lastPacket.LastLap !== this.lastLastLap
      ? lastPacket.LastLap   // game reported a final lap time
      : lastPacket.CurrentLap; // use elapsed time as best estimate

    if (lapTime < 10) return; // ignore trivial fragments (e.g. post-race trickle packets)

    // Use LastLap if it was updated (authoritative), otherwise mark as incomplete
    const isComplete = lastPacket.LastLap > 0 && lastPacket.LastLap !== this.lastLastLap;

    {
      const { activeProfileId } = loadSettings();
      const tuneAssignment = await getTuneAssignment(
        this.currentSession.carOrdinal,
        this.currentSession.trackOrdinal
      );
      const lapNum = this.currentLapNumber;
      const packetCount = this.lapBuffer.length;
      insertLap(
        this.currentSession.sessionId,
        lapNum,
        lapTime,
        isComplete && this.lapIsValid,
        this.lapBuffer,
        activeProfileId,
        tuneAssignment?.tuneId ?? null,
        isComplete ? this.invalidReason : "incomplete"
      ).then((lapId) => {
        console.log(
          `[Lap] Flushed stale lap ${lapNum} | Time: ${formatLapTime(lapTime)} | ${isComplete ? "Complete" : "Incomplete"} | Packets: ${packetCount} | DB ID: ${lapId} (${(silenceMs / 1000).toFixed(0)}s silence)`
        );
      }).catch((err) => {
        console.error("[Lap] Failed to flush stale lap:", err);
      });
    }

    // Reset state so we don't flush again
    this.lapBuffer = [];
    this.currentLapNumber = -1;
    this.lastPacketTime = 0;
  }

  private resetLapState(newLapFirstPacket: TelemetryPacket): void {
    this.currentLapNumber = newLapFirstPacket.LapNumber;
    this.lapBuffer = [];
    this.lapIsValid = true;
    this.invalidReason = null;
    this.lastLastLap = newLapFirstPacket.LastLap;
    this._distanceAtLapStart = newLapFirstPacket.DistanceTraveled;
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
 * Smooth an outline using a circular moving average (wraps around start/finish).
 */
export function smoothOutline(
  points: { x: number; z: number }[],
  window: number = 5
): { x: number; z: number }[] {
  const n = points.length;
  const half = Math.floor(window / 2);
  return points.map((_, i) => {
    let sx = 0, sz = 0;
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
export function normalizeToFixedPoints(
  raw: { x: number; z: number; speed: number }[],
  targetPoints: number
): { x: number; z: number; speed: number }[] {
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
export function filterLapOutliers(
  points: { x: number; z: number; speed: number }[]
): { x: number; z: number; speed: number }[] {
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
export function averageOutlines(
  laps: { x: number; z: number; speed: number }[][]
): { x: number; z: number; speed: number }[] {
  if (laps.length === 0) return [];
  if (laps.length === 1) return laps[0];

  const len = laps[0].length;
  const ref = laps[0];

  // Align each lap to the reference by finding the best circular shift
  const aligned: typeof laps = [ref];
  for (let l = 1; l < laps.length; l++) {
    const lap = laps[l];
    if (lap.length !== len) { aligned.push(lap); continue; }

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
      if (err < bestError) { bestError = err; bestShift = shift; }
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
      if (err < bestError) { bestError = err; bestShift = shift; }
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
    let sx = 0, sz = 0, ss = 0;
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

/**
 * Auto-compute 3 sectors from track geometry by finding the two largest
 * braking zones (clusters of high direction change). Returns sector
 * boundaries as fractions of total outline length.
 */
export function computeSectorsFromGeometry(
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

// Periodic check: flush stale laps when packets stop (e.g. race ended, game closed)
setInterval(() => lapDetector.flushStaleLap(), 5_000);
