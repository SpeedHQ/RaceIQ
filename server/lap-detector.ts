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
import type { DbAdapter } from "./pipeline-adapters";
import type { ILapDetector, LapDetectorOptions } from "./lap-detector-interface";
import { extractCurbSegments, recordCurbData } from "../shared/track-data";
import { assessLapRecording } from "./lap-quality";
import { computeLapSectors as computeLapSectorsHelper } from "./compute-lap-sectors";
import { detectSessionBoundary, detectLapBoundary, detectLapReset } from "./lap-detection";


export interface SessionState {
  sessionId: number;
  carOrdinal: number;
  trackOrdinal: number;
  carPI: number;
  gameId: GameId;
  sessionUID?: string; // F1 session UID for reliable session boundary detection
  bestLapTime: number; // best valid lap time in current session (0 = none yet)
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

export interface LapSavedEvent {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  sectors: { s1: number; s2: number; s3: number } | null;
  estimatedBestLapTime: number; // best lap time in session (0 if none yet)
}

export interface LapSavedNotification extends LapSavedEvent {
  type: "lap-saved";
}

export interface LapCompleteEvent {
  packets: TelemetryPacket[];
  lapDistStart: number;
  lapTime: number;
  isValid: boolean;
  sectors: { s1: number; s2: number; s3: number } | null;
}

export class LapDetector implements ILapDetector {
  private readonly bypassPacketRateFilter: boolean;
  private db: DbAdapter;

  constructor(dbOrOpts: DbAdapter | LapDetectorOptions, options?: { bypassPacketRateFilter?: boolean }) {
    if (dbOrOpts && typeof (dbOrOpts as LapDetectorOptions).db !== "undefined") {
      // New-style: LapDetectorOptions object
      const opts = dbOrOpts as LapDetectorOptions;
      this.db = opts.db;
      this.bypassPacketRateFilter = opts.bypassPacketRateFilter ?? false;
      if (opts.callbacks) {
        if (opts.callbacks.onSessionStart) this.onSessionStart = opts.callbacks.onSessionStart;
        if (opts.callbacks.onLapComplete) this.onLapComplete_ = opts.callbacks.onLapComplete;
        if (opts.callbacks.onLapSaved) this.onLapSaved = opts.callbacks.onLapSaved;
      }
    } else {
      // Legacy positional style: new LapDetector(db, options?)
      this.db = dbOrOpts as DbAdapter;
      this.bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
    }
  }

  onSessionStart?: (session: SessionState) => void | Promise<void>;
  onLapComplete_?: (event: LapCompleteEvent) => void;
  onLapSaved?: (event: LapSavedEvent) => void;

  private currentSession: SessionState | null = null;
  private currentLapNumber: number = -1; // -1 = no lap yet (awaiting first packet)
  private lapBuffer: TelemetryPacket[] = []; // all packets for the in-progress lap
  private lapIsValid: boolean = true; // false if rewind detected mid-lap
  private invalidReason: string | null = null;
  private _loggedFeedOnce: boolean = false; // debug flag to log feed start once
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
  // ACC: track native sector time transitions live (same pattern as F1 in-packet sector times)
  private accS1: number = 0;
  private accS2: number = 0;
  private accPrevSectorIdx: number = 0;

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
    // Debug: log if lap detector receives any packets
    if (!this._loggedFeedOnce) {
      console.log("[Lap Detector] Started receiving packets from pipeline");
      this._loggedFeedOnce = true;
    }

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
    if (!this.bypassPacketRateFilter && this.currentSession && this.packetRate > 0 && this.packetRate < 30) {
      this.lastPacketTime = now;
      return;
    }

    // Check for new session conditions
    if (this.shouldStartNewSession(packet, now)) {
      // If we have a lap in progress, save it before starting new session
      await this.finalizeLapIfNeeded(packet);
      await this.startNewSession(packet);
    }

    // Race restart / final lap detection
    if (
      this.currentLapNumber >= 0 &&
      this.lapBuffer.length > 30 &&
      packet.LapNumber === this.currentLapNumber
    ) {
      const resetResult = detectLapReset(
        this.lapBuffer[this.lapBuffer.length - 1],
        this.lastLastLap,
        packet
      );
      if (resetResult.action === "complete-final-lap") {
        console.log(`[Lap] Final lap completed: LastLap ${this.lastLastLap.toFixed(3)} -> ${packet.LastLap.toFixed(3)}`);
        await this.onLapComplete(packet);
      } else if (resetResult.action === "reset-restart") {
        console.log(`[Lap] Race restart detected — discarding buffer`);
        this.resetLapState(packet);
      }
    }

    // Rewind detection: TimestampMS decreased (within same lap)
    if (
      this.lastTimestampMS > 0 &&
      packet.TimestampMS < this.lastTimestampMS &&
      packet.LapNumber === this.currentLapNumber
    ) {
      if (this.lapIsValid) {
        console.log(`[Lap] Rewind: timestamp ${this.lastTimestampMS} -> ${packet.TimestampMS}. Marking lap invalid.`);
      }
      this.lapIsValid = false;
      this.invalidReason = "rewind";
    }

    // Lap boundary detection
    if (this.currentLapNumber >= 0 && packet.LapNumber !== this.currentLapNumber) {
      const lapResult = detectLapBoundary(this.currentLapNumber, packet);
      if (lapResult.action === "reset-rewind") {
        console.log(`[Lap] Rewind across lap boundary: ${this.currentLapNumber} -> ${packet.LapNumber}. Discarding buffer.`);
        this.resetLapState(packet);
      } else if (lapResult.action === "complete-skip") {
        console.log(`[Lap] Lap skip: ${this.currentLapNumber} -> ${packet.LapNumber}. Marking invalid.`);
        this.lapIsValid = false;
        this.invalidReason = lapResult.invalidReason;
        await this.onLapComplete(packet);
      } else {
        await this.onLapComplete(packet);
      }
    }

    this.lastLastLap = packet.LastLap;

    // Initialize lap tracking on first packet
    if (this.currentLapNumber < 0) {
      this.currentLapNumber = packet.LapNumber;
      this._distanceAtLapStart = packet.DistanceTraveled;
      // Seed ACC sector index from actual position so we don't fire a false transition
      // if the car starts mid-track (grid box, pit exit) rather than at sector 0.
      if (packet.gameId === "acc" && packet.acc) {
        this.accPrevSectorIdx = packet.acc.currentSectorIndex;
      }
    }

    // ACC: track sector index transitions live to capture s1/s2 times as they happen
    if (packet.gameId === "acc" && packet.acc) {
      const idx = packet.acc.currentSectorIndex;
      const t = packet.acc.lastSectorTime / 1000;
      if (idx !== this.accPrevSectorIdx && t > 0) {
        if (this.accPrevSectorIdx === 0) this.accS1 = t;
        else if (this.accPrevSectorIdx === 1) this.accS2 = t;
        this.accPrevSectorIdx = idx;
      }
    }

    // Buffer the packet for the current lap
    this.lapBuffer.push(packet);
    this.lastTimestampMS = packet.TimestampMS;
    this.lastPacketTime = now;
  }

  private shouldStartNewSession(packet: TelemetryPacket, now: number): boolean {
    const lastDist = this.lapBuffer.length > 0
      ? this.lapBuffer[this.lapBuffer.length - 1].DistanceTraveled
      : null;
    const reason = detectSessionBoundary(
      this.currentSession,
      this.currentLapNumber,
      lastDist,
      this.lastPacketTime,
      packet,
      now
    );
    if (reason) console.log(`[Session] New session: ${reason}`);
    return reason !== null;
  }

  private async startNewSession(packet: TelemetryPacket): Promise<void> {
    const trackOrd = packet.TrackOrdinal ?? 0;
    const gameId = packet.gameId;
    const sessionType = packet.f1?.sessionType;
    let sessionId: number;
    try {
      sessionId = await this.db.insertSession(packet.CarOrdinal, trackOrd, gameId, sessionType);
    } catch (err) {
      console.error(`[LapDetector] Failed to insert session:`, (err as Error).message);
      return;
    }
    this.currentSession = {
      sessionId,
      carOrdinal: packet.CarOrdinal,
      trackOrdinal: trackOrd,
      carPI: packet.CarPerformanceIndex,
      gameId,
      sessionUID: packet.sessionUID,
      bestLapTime: 0,
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

    await this.onSessionStart?.(this.currentSession!);
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

    // ACC: iCurrentTime can reset and start counting the new lap before completedLaps
    // increments, so the tail of the buffer may contain packets with a reset CurrentLap.
    // Split at the peak CurrentLap — everything after is overflow for the next lap.
    let overflowPackets: TelemetryPacket[] = [];
    if (newLapFirstPacket.gameId === "acc") {
      let peakIdx = 0;
      for (let i = 1; i < this.lapBuffer.length; i++) {
        if (this.lapBuffer[i].CurrentLap >= this.lapBuffer[peakIdx].CurrentLap) peakIdx = i;
      }
      if (peakIdx < this.lapBuffer.length - 1) {
        overflowPackets = this.lapBuffer.slice(peakIdx + 1);
        this.lapBuffer = this.lapBuffer.slice(0, peakIdx + 1);
      }
    }

    // Running-start trim: strip pre-start-line packets
    this.trimRunningStartPackets();

    // Skip saving if lap time is too short (first lap, warmup, ghost fragments)
    if (lapTime < 10) {
      console.log(
        `[Lap] Skipping lap ${this.currentLapNumber} with time ${lapTime.toFixed(3)}s (< 10s)`
      );
      this.resetLapState(newLapFirstPacket);
      return;
    }

    {
      const tuneAssignment = await this.db.getTuneAssignment(
        this.currentSession.carOrdinal,
        this.currentSession.trackOrdinal
      );
      const tuneId = tuneAssignment?.tuneId ?? null;
      const lapNum = this.currentLapNumber;
      const packetCount = this.lapBuffer.length;

      // Run recording quality check — can override game-valid laps if telemetry is bad
      const quality = assessLapRecording(this.lapBuffer, lapTime);
      const valid = this.lapIsValid && quality.valid;
      const invalidReason = this.invalidReason ?? (!quality.valid ? quality.reason : null);

      const sectors = await this.computeLapSectors(this.lapBuffer, lapTime);

      // Update session best lap time
      if (valid && (this.currentSession!.bestLapTime === 0 || lapTime < this.currentSession!.bestLapTime)) {
        this.currentSession!.bestLapTime = lapTime;
      }

      // Notify pipeline so sector tracker can update reference lap for delta
      if (valid) {
        this.onLapComplete_?.({
          packets: this.lapBuffer,
          lapDistStart: this.lapBuffer[0].DistanceTraveled,
          lapTime,
          isValid: valid,
          sectors,
        });
      }

      this.db.insertLap(
        this.currentSession.sessionId,
        lapNum,
        lapTime,
        valid,
        this.lapBuffer,
        null,
        tuneId,
        invalidReason,
        sectors
      ).then((lapId) => {
        console.log(
          `[Lap] Saved lap ${lapNum} | Time: ${formatLapTime(lapTime)} | Valid: ${valid}${invalidReason ? ` (${invalidReason})` : ""} | Packets: ${packetCount} | DB ID: ${lapId}`
        );
        this.onLapSaved?.({
          lapId,
          lapNumber: lapNum,
          lapTime,
          isValid: valid,
          sectors,
          estimatedBestLapTime: this.currentSession!.bestLapTime,
        });
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

    this.resetLapState(newLapFirstPacket, overflowPackets);
  }

  /** Best-effort save of an incomplete lap when the session ends mid-lap. */
  private async finalizeLapIfNeeded(_nextPacket: TelemetryPacket): Promise<void> {
    // Try to save current in-progress lap when session changes
    if (
      this.currentSession &&
      this.lapBuffer.length > 0 &&
      this.currentLapNumber >= 0
    ) {
      this.trimRunningStartPackets();
      // Use the last known CurrentLap as time estimate (not ideal but best we have)
      const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
      const lapTime = lastPacket.CurrentLap;
      if (lapTime >= 10) {
          const tuneAssignment = await this.db.getTuneAssignment(
            this.currentSession.carOrdinal,
            this.currentSession.trackOrdinal
          );
          this.db.insertLap(
            this.currentSession.sessionId,
            this.currentLapNumber,
            lapTime,
            false,
            this.lapBuffer,
            null,
            tuneAssignment?.tuneId ?? null,
            "incomplete",
            null
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

    this.trimRunningStartPackets();
    if (this.lapBuffer.length < 30) return;

    const lastPacket = this.lapBuffer[this.lapBuffer.length - 1];
    const lapTime = lastPacket.LastLap > 0 && lastPacket.LastLap !== this.lastLastLap
      ? lastPacket.LastLap   // game reported a final lap time
      : lastPacket.CurrentLap; // use elapsed time as best estimate

    if (lapTime < 10) return; // ignore trivial fragments (e.g. post-race trickle packets)

    // Use LastLap if it was updated (authoritative), otherwise mark as incomplete
    const isComplete = lastPacket.LastLap > 0 && lastPacket.LastLap !== this.lastLastLap;

    {
      const tuneAssignment = await this.db.getTuneAssignment(
        this.currentSession.carOrdinal,
        this.currentSession.trackOrdinal
      );
      const lapNum = this.currentLapNumber;
      const packetCount = this.lapBuffer.length;
      this.db.insertLap(
        this.currentSession.sessionId,
        lapNum,
        lapTime,
        isComplete && this.lapIsValid,
        this.lapBuffer,
        null,
        tuneAssignment?.tuneId ?? null,
        isComplete ? this.invalidReason : "incomplete",
        null
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

  /**
   * Strip leading packets from before a CurrentLap reset (running start).
   * In practice/meetup sessions the buffer may start mid-previous-lap;
   * find the last large CurrentLap drop and discard everything before it.
   */
  private trimRunningStartPackets(): void {
    if (this.lapBuffer.length <= 1) return;
    let resetIdx = 0;
    for (let i = 1; i < this.lapBuffer.length; i++) {
      if (this.lapBuffer[i - 1].CurrentLap > 5 && this.lapBuffer[i].CurrentLap < 1) {
        resetIdx = i;
      }
    }
    // Only trim if the reset is in the first half of the buffer.
    // A true running-start reset happens early (mid-previous-lap data at the front).
    // A lap-end reset happens at the very end and must not be treated as a running start.
    if (resetIdx > 0 && resetIdx < this.lapBuffer.length / 2) {
      console.log(
        `[Lap] Trimmed ${resetIdx} pre-start packets (running start), ${this.lapBuffer.length - resetIdx} remain`
      );
      this.lapBuffer = this.lapBuffer.slice(resetIdx);
    }
  }

  /** Compute s1/s2/s3 sector times from a lap's telemetry buffer. */
  private async computeLapSectors(
    packets: TelemetryPacket[],
    lapTime: number
  ): Promise<{ s1: number; s2: number; s3: number } | null> {
    if (!this.currentSession) return null;
    const { trackOrdinal, gameId } = this.currentSession;
    const accLiveSectors = this.accS1 > 0 && this.accS2 > 0
      ? { s1: this.accS1, s2: this.accS2 }
      : undefined;
    return computeLapSectorsHelper(this.db, trackOrdinal, gameId, packets, lapTime, accLiveSectors);
  }

  private resetLapState(newLapFirstPacket: TelemetryPacket, seedPackets: TelemetryPacket[] = []): void {
    this.currentLapNumber = newLapFirstPacket.LapNumber;
    this.lapBuffer = [...seedPackets];
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
    this.accS1 = 0;
    this.accS2 = 0;
    // Preserve sector index from new lap's first packet so we don't fire a false transition
    this.accPrevSectorIdx = newLapFirstPacket.acc?.currentSectorIndex ?? 0;
  }

  getDebugState(): Record<string, unknown> {
    return {
      currentSession: this.currentSession,
      currentLapNumber: this.currentLapNumber,
      lapBufferLength: this.lapBuffer?.length ?? 0,
      lapIsValid: this.lapIsValid,
      invalidReason: this.invalidReason,
      lastLastLap: this.lastLastLap,
      lastTimestampMS: this.lastTimestampMS,
      lastPacketTime: this.lastPacketTime,
      recentPacketCount: this.recentPacketCount,
      lastRateCheck: this.lastRateCheck,
      packetRate: this.packetRate,
      distanceAtLapStart: this._distanceAtLapStart,
      fuelAtLapStart: this.fuelAtLapStart,
      fuelHistoryLength: this._fuelHistory?.length ?? 0,
      tireWearAtLapStart: this.tireWearAtLapStart,
      tireWearHistoryLength: this._tireWearHistory?.length ?? 0,
      accS1: this.accS1,
      accS2: this.accS2,
      accPrevSectorIdx: this.accPrevSectorIdx,
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

