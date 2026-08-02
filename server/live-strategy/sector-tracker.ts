/**
 * Server-side sector timing tracker.
 *
 * Computes live sector splits from the telemetry packet stream using
 * distance-fraction sector boundaries. Broadcast via WebSocket so the
 * client just renders numbers.
 */
import type { TelemetryPacket, GameId, LiveSectorData } from "../../shared/types";
import { getGame } from "../../shared/games/registry";
import type { GameAdapter } from "../../shared/games/types";
import { resolveTrack } from "../tracks/info";

interface SectorBounds {
  starts: number[];
  trackLength: number;
}

/** Reference lap distance-time curve for interpolation-based delta. */
interface ReferenceLap {
  distances: Float64Array; // per-lap distance (meters from lap start)
  times: Float64Array;     // elapsed time at each distance point
  lapTime: number;
}

export class SectorTracker {
  private bounds: SectorBounds | null = null;
  private sectorCount = 3;

  // Running state
  private lapDistStart = 0;
  private lapDistTotal = 0;
  private currentSector = 0;
  private sectorStartTime = 0;
  private currentTimes: number[] = [0, 0, 0];
  private bestTimes: number[] = [Infinity, Infinity, Infinity];
  private lastTimes: number[] = [0, 0, 0];
  private lastLap = 0;
  private bestLapTime = Infinity;
  private lastLapTime = 0;
  private initialized = false;
  private prevCurrentLap = 0;
  private refLap: ReferenceLap | null = null;
  private currentTrackOrdinal = -1;
  private currentCarOrdinal = -1;
  private currentGameId: GameId | null = null;
  private currentGame: GameAdapter | null = null;

  /** Reset for a new session — loads sector boundaries and track length. */
  async reset(trackOrdinal: number, gameId: GameId, carOrdinal: number = -1): Promise<void> {
    this.bounds = null;
    this.sectorCount = 3;
    this.lapDistStart = 0;
    this.lapDistTotal = 0;
    this.currentSector = 0;
    this.sectorStartTime = 0;
    this.currentTimes = [0, 0, 0];
    this.bestTimes = [Infinity, Infinity, Infinity];
    this.lastTimes = [0, 0, 0];
    this.lastLap = 0;
    this.bestLapTime = Infinity;
    this.lastLapTime = 0;
    this.initialized = false;
    this.prevCurrentLap = 0;
    this.refLap = null;
    this.currentTrackOrdinal = trackOrdinal;
    this.currentCarOrdinal = carOrdinal;
    this.currentGameId = gameId;
    this.currentGame = getGame(gameId);

    // Games with native sector metadata provide their authoritative layout on
    // telemetry frames. Wait for it rather than inventing equal thirds.
    if (this.currentGame.nativeSectors) return;

    // Sector boundaries: this game's curated pair, else bundled, else thirds.
    const track = resolveTrack(gameId, trackOrdinal);
    const sectors = track.sectors;

    if (!sectors?.s1End || !sectors?.s2End) return;

    // Compute track length from outline
    let trackLength = 0;
    const outline = track.outline;
    if (outline && outline.length > 1) {
      for (let i = 1; i < outline.length; i++) {
        const dx = outline[i].x - outline[i - 1].x;
        const dz = outline[i].z - outline[i - 1].z;
        trackLength += Math.sqrt(dx * dx + dz * dz);
      }
    }

    this.bounds = {
      starts: [0, sectors.s1End, sectors.s2End],
      trackLength,
    };
    if (trackLength > 0) this.lapDistTotal = trackLength;

    console.log(`[Sectors] Loaded for track ${trackOrdinal} (${gameId}): s1=${sectors.s1End}, s2=${sectors.s2End}, length=${trackLength.toFixed(0)}m, seeded best=${this.bestLapTime === Infinity ? "none" : this.bestLapTime.toFixed(3)}`);
  }

  /** Process a packet. Returns sector data or null if no sector bounds loaded. */
  feed(packet: TelemetryPacket): LiveSectorData | null {
    const nativeLayout = this.currentGame?.getNativeSectorLayout?.(packet);
    if (this.currentGame?.nativeSectors) {
      const starts = nativeLayout?.starts;
      if (
        starts &&
        starts.length >= 2 &&
        Number.isFinite(starts[0]) &&
        starts[0] >= 0 &&
        starts[0] < 1e-6
      ) {
        const trackLength = nativeLayout?.trackLengthM ?? 0;
        this.setNativeSectorLayout(starts, trackLength);
        if (this.lapDistTotal <= 0 && trackLength > 0) {
          this.lapDistTotal = trackLength;
        }
      }
    }

    if (!this.bounds) return null;

    // Initialize from first packet
    if (!this.initialized) {
      this.initialized = true;
      this.lapDistStart = packet.DistanceTraveled;
      this.lastLap = packet.LapNumber;
      this.sectorStartTime = packet.CurrentLap;
      this.prevCurrentLap = packet.CurrentLap;
    }

    // Handle backward distance jump (demo loop / teleport)
    if (packet.DistanceTraveled < this.lapDistStart - 100) {
      this.lapDistStart = packet.DistanceTraveled;
      this.currentSector = 0;
      this.sectorStartTime = packet.CurrentLap;
      this.currentTimes = Array(this.sectorCount).fill(0);
    }

    // Detect lap boundary via CurrentLap timer reset (covers Forza time-trial,
    // final lap, and LapNumber 0→1 where the LapNumber check alone is skipped).
    const currentLapReset = this.prevCurrentLap > 5 && packet.CurrentLap < 1;
    this.prevCurrentLap = packet.CurrentLap;

    // Lap boundary: LapNumber increment (any, including 0→1) OR CurrentLap reset
    if (packet.LapNumber > this.lastLap || currentLapReset) {
      const hasCompletedSectors =
        this.currentTimes
          .slice(0, this.sectorCount - 1)
          .every((time) => time > 0);
      if (hasCompletedSectors) {
        this.lastTimes = [...this.currentTimes];
        const completedTime = this.currentTimes
          .slice(0, this.sectorCount - 1)
          .reduce((sum, time) => sum + time, 0);
        this.lastTimes[this.sectorCount - 1] = Math.max(
          0,
          packet.LastLap - completedTime,
        );
        // bestTimes only updated from valid laps (via updateRefLap / seeding)
      }

      if (packet.LastLap > 0) {
        this.lastLapTime = packet.LastLap;
        // bestLapTime is only updated from valid laps (via updateRefLap / seeding)
      }

      // Refine track length from actual completed distance.
      // For ACC/AC Evo: guard against pit laps — their short completedDist would
      // corrupt lapDistTotal and make sector fractions fire too early on the
      // following lap (e.g. S3 before turn 2 on the outlap).
      // An authoritative telemetry length must survive a source attaching
      // mid-lap, when the first completedDist may be only a lap fragment.
      const completedDist = packet.DistanceTraveled - this.lapDistStart;
      const minPlausibleLap = this.currentGameId === "acc" && this.bounds ? this.bounds.trackLength * 0.5 : 100;
      if (!this.currentGame?.authoritativeTrackLength && completedDist > minPlausibleLap) {
        this.lapDistTotal = completedDist;
      }

      this.lapDistStart = packet.DistanceTraveled;
      this.currentSector = 0;
      this.sectorStartTime = 0;
      this.currentTimes = Array(this.sectorCount).fill(0);
    }
    this.lastLap = packet.LapNumber;

    // Sector boundary detection.
    // ACC: use the game's own currentSectorIndex (track-position-based, accurate from any lap start).
    // Other games: fall back to distance-fraction against lapDistTotal.
    if (this.currentGameId === "acc" && packet.acc?.currentSectorIndex !== undefined) {
      this.updateAccSector(packet);
    } else {
      // Native sector starts are fractions and their telemetry supplies the
      // matching lap fraction directly. Other games derive it from distance.
      const frac = this.currentGame?.nativeSectors
        ? nativeLayout?.lapFraction
        : this.lapDistTotal > 0
          ? (packet.DistanceTraveled - this.lapDistStart) / this.lapDistTotal
          : undefined;

      let expectedSector = this.currentSector;
      if (frac !== undefined) {
        expectedSector = 0;
        for (let index = 1; index < this.bounds.starts.length; index++) {
          if (frac < this.bounds.starts[index]) break;
          expectedSector = index;
        }
      }

      if (expectedSector > this.currentSector) {
        this.currentTimes[this.currentSector] = packet.CurrentLap - this.sectorStartTime;
        this.sectorStartTime = packet.CurrentLap;
        this.currentSector = expectedSector;
      }
    }

    // Current sector running time
    const currentSectorTime = packet.CurrentLap - this.sectorStartTime;

    // Estimated lap time via interpolation against best lap's distance-time curve.
    // delta = liveTime - refTimeAtSameDistance; estimated = bestLapTime + delta
    let estimatedLap = 0;
    let deltaToBest = 0;
    if (this.refLap && packet.CurrentLap > 0) {
      const lapDist = packet.DistanceTraveled - this.lapDistStart;
      if (lapDist > 0) {
        const refTime = this.interpolateRefTime(lapDist);
        if (refTime >= 0) {
          deltaToBest = packet.CurrentLap - refTime;
          estimatedLap = this.refLap.lapTime + deltaToBest;
        }
      }
    }

    const deltaToLast = estimatedLap > 0 && this.lastLapTime > 0
      ? estimatedLap - this.lastLapTime
      : 0;

    return {
      sectorCount: this.sectorCount,
      currentSector: this.currentSector,
      currentSectorTime,
      currentTimes: [...this.currentTimes],
      lastTimes: [...this.lastTimes],
      bestTimes: this.bestTimes.map(t => t === Infinity ? 0 : t),
      lastLapTime: this.lastLapTime,
      bestLapTime: this.bestLapTime === Infinity ? 0 : this.bestLapTime,
      estimatedLap,
      deltaToBest,
      deltaToLast,
    };
  }

  /** Binary search + linear interpolation to find reference time at a given lap distance. */
  private interpolateRefTime(lapDist: number): number {
    const ref = this.refLap;
    if (!ref || ref.distances.length < 2) return -1;
    const d = ref.distances;
    const t = ref.times;
    // Beyond reference lap range
    if (lapDist >= d[d.length - 1]) return -1;
    if (lapDist <= d[0]) return t[0];
    // Binary search for bracket
    let lo = 0, hi = d.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid] <= lapDist) lo = mid; else hi = mid;
    }
    // Linear interpolation
    const frac = (lapDist - d[lo]) / (d[hi] - d[lo]);
    return t[lo] + frac * (t[hi] - t[lo]);
  }

  /** Build a reference lap structure from packet data. */
  private buildRefLapFromPackets(packets: TelemetryPacket[], lapTime: number): ReferenceLap {
    const lapDistStart = packets[0].DistanceTraveled;
    const distances = new Float64Array(packets.length);
    const times = new Float64Array(packets.length);

    for (let i = 0; i < packets.length; i++) {
      distances[i] = packets[i].DistanceTraveled - lapDistStart;
      times[i] = packets[i].CurrentLap;
    }
    return { distances, times, lapTime };
  }

  private updateAccSector(packet: TelemetryPacket): void {
    const idx = packet.acc!.currentSectorIndex!;
    if (idx > this.currentSector) {
      this.currentTimes[this.currentSector] = packet.CurrentLap - this.sectorStartTime;
      this.sectorStartTime = packet.CurrentLap;
      this.currentSector = idx;
    }
  }

  private setNativeSectorLayout(
    starts: readonly number[],
    trackLength: number,
  ): void {
    const changed =
      !this.bounds ||
      this.bounds.starts.length !== starts.length ||
      starts.some((start, index) => start !== this.bounds!.starts[index]);
    const resolvedTrackLength =
      trackLength > 0 ? trackLength : (this.bounds?.trackLength ?? 0);
    this.bounds = { starts: [...starts], trackLength: resolvedTrackLength };
    if (!changed) return;

    this.sectorCount = starts.length;
    this.currentSector = 0;
    this.currentTimes = Array(this.sectorCount).fill(0);
    this.lastTimes = Array(this.sectorCount).fill(0);
    this.bestTimes = Array(this.sectorCount).fill(Infinity);
  }

  /** Update reference lap and bests from a just-completed valid live lap. */
  updateRefLap(
    packets: TelemetryPacket[],
    lapTime: number,
    sectors?: number[] | null,
  ): void {
    if (lapTime < this.bestLapTime) this.bestLapTime = lapTime;
    if (sectors) {
      if (this.currentGame?.nativeSectors) {
        this.lastTimes = [...sectors];
        this.lastLapTime = lapTime;
      }
      for (let index = 0; index < sectors.length; index++) {
        const time = sectors[index];
        if (time > 0 && time < (this.bestTimes[index] ?? Infinity)) {
          this.bestTimes[index] = time;
        }
      }
    }
    if (this.refLap && lapTime >= this.refLap.lapTime) return;
    this.refLap = this.buildRefLapFromPackets(packets, lapTime);
  }

  /** Initialize tracker state for testing (bypasses async reset/DB). */
  _initForTest(opts: { s1End: number; s2End: number; trackLength: number }): void {
    this.bounds = {
      starts: [0, opts.s1End, opts.s2End],
      trackLength: opts.trackLength,
    };
    this.lapDistTotal = opts.trackLength;
    this.initialized = false;
  }

  /** Expose track length so PitTracker can use it */
  getTrackLength(): number {
    return this.bounds?.trackLength ?? 0;
  }

  /** Expose lap distance start for PitTracker curve interpolation. */
  getLapDistStart(): number {
    return this.lapDistStart;
  }

  getDebugState(): Record<string, unknown> {
    return {
      bounds: this.bounds,
      sectorCount: this.sectorCount,
      lapDistStart: this.lapDistStart,
      lapDistTotal: this.lapDistTotal,
      currentSector: this.currentSector,
      sectorStartTime: this.sectorStartTime,
      currentTimes: this.currentTimes,
      bestTimes: this.bestTimes,
      lastTimes: this.lastTimes,
      lastLap: this.lastLap,
      bestLapTime: this.bestLapTime,
      lastLapTime: this.lastLapTime,
      initialized: this.initialized,
      prevCurrentLap: this.prevCurrentLap,
      refLapLength: this.refLap?.distances.length ?? 0,
      refLapTime: this.refLap?.lapTime ?? null,
      currentTrackOrdinal: this.currentTrackOrdinal,
      currentCarOrdinal: this.currentCarOrdinal,
    };
  }
}
