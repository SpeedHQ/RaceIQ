/**
 * Server-side sector timing tracker.
 *
 * Computes live sector splits from the telemetry packet stream using
 * distance-fraction sector boundaries. Broadcast via WebSocket so the
 * client just renders numbers.
 */
import type { TelemetryPacket, GameId, LiveSectorData, LivePitData, LapMeta } from "../shared/types";
import { getTrackOutlineSectors, getLaps, getLapById } from "./db/queries";
import { getTrackSectorsByOrdinal, getTrackOutlineByOrdinal, loadSharedTrackMeta } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";

interface SectorBounds {
  s1End: number;
  s2End: number;
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

  // Running state
  private lapDistStart = 0;
  private lapDistTotal = 0;
  private currentSector = 0;
  private sectorStartTime = 0;
  private currentTimes: [number, number, number] = [0, 0, 0];
  private bestTimes: [number, number, number] = [Infinity, Infinity, Infinity];
  private lastTimes: [number, number, number] = [0, 0, 0];
  private lastLap = 0;
  private bestLapTime = Infinity;
  private lastLapTime = 0;
  private initialized = false;
  private prevCurrentLap = 0;
  private refLap: ReferenceLap | null = null;
  private currentTrackOrdinal = -1;
  private currentCarOrdinal = -1;

  /** Reset for a new session — loads sector boundaries and track length. */
  async reset(trackOrdinal: number, gameId: GameId, carOrdinal: number = -1): Promise<void> {
    // Preserve reference lap and best times when staying on the same track+car
    // (e.g. user restarted the race, rewind to start, new practice session)
    const sameSetup = trackOrdinal === this.currentTrackOrdinal && carOrdinal === this.currentCarOrdinal;
    const prevRefLap = sameSetup ? this.refLap : null;
    const prevBestTimes = sameSetup ? [...this.bestTimes] as [number, number, number] : null;
    const prevBestLapTime = sameSetup ? this.bestLapTime : Infinity;

    this.bounds = null;
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

    // Load sector boundaries: DB → shared meta → bundled fallback
    const adapter = tryGetGame(gameId);
    const sharedName = adapter?.getSharedTrackName?.(trackOrdinal);
    const dbSectors = await getTrackOutlineSectors(trackOrdinal, gameId);
    const sharedMeta = sharedName ? loadSharedTrackMeta(sharedName) : null;
    const sectors = dbSectors ?? sharedMeta?.sectors ?? getTrackSectorsByOrdinal(trackOrdinal);

    if (!sectors?.s1End || !sectors?.s2End) return;

    // Compute track length from outline
    let trackLength = 0;
    const outline = getTrackOutlineByOrdinal(trackOrdinal, gameId, sharedName);
    if (outline && outline.length > 1) {
      for (let i = 1; i < outline.length; i++) {
        const dx = outline[i].x - outline[i - 1].x;
        const dz = outline[i].z - outline[i - 1].z;
        trackLength += Math.sqrt(dx * dx + dz * dz);
      }
    }

    this.bounds = { s1End: sectors.s1End, s2End: sectors.s2End, trackLength };
    if (trackLength > 0) this.lapDistTotal = trackLength;

    // Seed best times from recorded laps on this track+car
    await this.seedFromRecordedLaps(trackOrdinal, gameId, carOrdinal, sectors.s1End, sectors.s2End);

    // Restore reference lap and best times from same-track session
    if (prevRefLap) this.refLap = prevRefLap;
    if (prevBestTimes) {
      for (let i = 0; i < 3; i++) {
        if (prevBestTimes[i] < this.bestTimes[i]) this.bestTimes[i] = prevBestTimes[i];
      }
    }
    if (prevBestLapTime < this.bestLapTime) this.bestLapTime = prevBestLapTime;

    console.log(`[Sectors] Loaded for track ${trackOrdinal} (${gameId}): s1=${sectors.s1End}, s2=${sectors.s2End}, length=${trackLength.toFixed(0)}m, seeded best=${this.bestLapTime === Infinity ? "none" : this.bestLapTime.toFixed(3)}`);
  }

  /** Seed bestTimes and bestLapTime from previously recorded laps on this track+car. */
  private async seedFromRecordedLaps(
    trackOrdinal: number,
    gameId: GameId,
    carOrdinal: number,
    s1End: number,
    s2End: number
  ): Promise<void> {
    try {
      const allLaps = await getLaps(gameId, 200);
      const trackLaps = allLaps
        .filter((l) => l.trackOrdinal === trackOrdinal && (carOrdinal < 0 || l.carOrdinal === carOrdinal) && l.isValid && l.lapTime > 10)
        .sort((a, b) => a.lapTime - b.lapTime)
        .slice(0, 10); // only check top 10 by lap time

      for (const lapMeta of trackLaps) {
        const lap = await getLapById(lapMeta.id);
        if (!lap?.telemetry || lap.telemetry.length < 50) continue;

        const packets = lap.telemetry;
        const startDist = packets[0].DistanceTraveled;
        const lapDistance = packets[packets.length - 1].DistanceTraveled - startDist;
        if (lapDistance < 100) continue;

        let currentSector = 0;
        let sectorStartTime = packets[0].CurrentLap;
        let s1Time = 0;
        let s2Time = 0;

        for (const p of packets) {
          const frac = (p.DistanceTraveled - startDist) / lapDistance;
          const expected = frac < s1End ? 0 : frac < s2End ? 1 : 2;
          if (expected > currentSector) {
            const t = p.CurrentLap - sectorStartTime;
            if (currentSector === 0) s1Time = t;
            else if (currentSector === 1) s2Time = t;
            sectorStartTime = p.CurrentLap;
            currentSector = expected;
          }
        }

        if (s1Time > 0 && s2Time > 0) {
          const s3Time = lapMeta.lapTime - s1Time - s2Time;
          if (s3Time <= 0) continue;

          if (s1Time < this.bestTimes[0]) this.bestTimes[0] = s1Time;
          if (s2Time < this.bestTimes[1]) this.bestTimes[1] = s2Time;
          if (s3Time < this.bestTimes[2]) this.bestTimes[2] = s3Time;

          if (lapMeta.lapTime < this.bestLapTime) this.bestLapTime = lapMeta.lapTime;
          // Reference lap is only built from live session laps (via updateRefLap),
          // not seeded from historical data — keeps delta relative to this session.
        }
      }
    } catch (err) {
      console.warn("[Sectors] Failed to seed from recorded laps:", err);
    }
  }

  /** Process a packet. Returns sector data or null if no sector bounds loaded. */
  feed(packet: TelemetryPacket): LiveSectorData | null {
    if (!this.bounds) return null;

    const { s1End, s2End } = this.bounds;

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
      this.currentTimes = [0, 0, 0];
    }

    // Detect lap boundary via CurrentLap timer reset (covers Forza time-trial,
    // final lap, and LapNumber 0→1 where the LapNumber check alone is skipped).
    const currentLapReset = this.prevCurrentLap > 5 && packet.CurrentLap < 1;
    this.prevCurrentLap = packet.CurrentLap;

    // Lap boundary: LapNumber increment (any, including 0→1) OR CurrentLap reset
    if (packet.LapNumber > this.lastLap || currentLapReset) {
      if (this.currentTimes[0] > 0 && this.currentTimes[1] > 0) {
        this.lastTimes = [...this.currentTimes] as [number, number, number];
        this.lastTimes[2] = packet.LastLap - this.currentTimes[0] - this.currentTimes[1];
        if (this.lastTimes[2] < 0) this.lastTimes[2] = 0;
        // bestTimes only updated from valid laps (via updateRefLap / seeding)
      }

      if (packet.LastLap > 0) {
        this.lastLapTime = packet.LastLap;
        // bestLapTime is only updated from valid laps (via updateRefLap / seeding)
      }

      // Refine track length from actual completed distance
      const completedDist = packet.DistanceTraveled - this.lapDistStart;
      if (completedDist > 100) {
        this.lapDistTotal = completedDist;
      }

      this.lapDistStart = packet.DistanceTraveled;
      this.currentSector = 0;
      this.sectorStartTime = 0;
      this.currentTimes = [0, 0, 0];
    }
    this.lastLap = packet.LapNumber;

    // Sector boundary detection
    if (this.lapDistTotal > 0) {
      const lapDist = packet.DistanceTraveled - this.lapDistStart;
      const frac = lapDist / this.lapDistTotal;

      const expectedSector = frac < s1End ? 0 : frac < s2End ? 1 : 2;

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
      currentSector: this.currentSector,
      currentSectorTime,
      currentTimes: [...this.currentTimes] as [number, number, number],
      lastTimes: [...this.lastTimes] as [number, number, number],
      bestTimes: this.bestTimes.map(t => t === Infinity ? 0 : t) as [number, number, number],
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

  /** Update reference lap and bests from a just-completed valid live lap. */
  updateRefLap(packets: TelemetryPacket[], lapDistStart: number, lapTime: number, sectors?: { s1: number; s2: number; s3: number } | null): void {
    if (lapTime < this.bestLapTime) this.bestLapTime = lapTime;
    if (sectors) {
      if (sectors.s1 > 0 && sectors.s1 < this.bestTimes[0]) this.bestTimes[0] = sectors.s1;
      if (sectors.s2 > 0 && sectors.s2 < this.bestTimes[1]) this.bestTimes[1] = sectors.s2;
      if (sectors.s3 > 0 && sectors.s3 < this.bestTimes[2]) this.bestTimes[2] = sectors.s3;
    }
    if (this.refLap && lapTime >= this.refLap.lapTime) return;
    const distances = new Float64Array(packets.length);
    const times = new Float64Array(packets.length);
    for (let i = 0; i < packets.length; i++) {
      distances[i] = packets[i].DistanceTraveled - lapDistStart;
      times[i] = packets[i].CurrentLap;
    }
    this.refLap = { distances, times, lapTime };
  }

  /** Initialize tracker state for testing (bypasses async reset/DB). */
  _initForTest(opts: { s1End: number; s2End: number; trackLength: number }): void {
    this.bounds = { s1End: opts.s1End, s2End: opts.s2End, trackLength: opts.trackLength };
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
}

/**
 * Server-side pit strategy tracker.
 *
 * Fuel: rolling average of last 5 valid laps with outlier rejection.
 *
 * Tires: distance-based interpolation against reference wear curves
 *   (averaged from last 3 laps), with per-lap rolling average as fallback.
 *   Same approach as estimated lap time but for wear — knows which parts
 *   of the track cause more wear and adjusts estimates dynamically mid-lap.
 */

/** Resampled wear curve on a 1-meter grid for point-wise averaging. */
interface ResampledWearCurve {
  /** Per-tire cumulative wear delta at each meter. [FL, FR, RL, RR] */
  wears: [Float64Array, Float64Array, Float64Array, Float64Array];
  /** Total wear for the full lap per tire. */
  totalWear: [number, number, number, number];
  /** Track length in meters (array length). */
  length: number;
}

export class PitTracker {
  // Fuel
  private fuelHistory: number[] = [];
  private fuelAtLapStart = -1;
  private lastLap = -1;

  // Per-tire wear history (each entry = wear delta for one lap) — fallback
  private tireWearHistory: { fl: number; fr: number; rl: number; rr: number }[] = [];
  private wearAtLapStart = { fl: -1, fr: -1, rl: -1, rr: -1 };

  // Distance-based wear curves (last 3 laps, averaged)
  private recentWearCurves: ResampledWearCurve[] = [];
  private refWearCurve: ResampledWearCurve | null = null;
  private liveWearAtLapStart = { fl: 0, fr: 0, rl: 0, rr: 0 }; // for computing live delta

  // Lap time tracking for outlier detection
  private lapTimeHistory: number[] = [];
  private lastCurrentLap = 0;
  private sessionLapCount = 0;

  // Game-specific thresholds (health = 1 - wear)
  private badHealthThreshold = 0.40;
  private criticalHealth = 0.20;

  reset(): void {
    this.fuelHistory = [];
    this.fuelAtLapStart = -1;
    this.lastLap = -1;
    this.tireWearHistory = [];
    this.wearAtLapStart = { fl: -1, fr: -1, rl: -1, rr: -1 };
    this.recentWearCurves = [];
    this.refWearCurve = null;
    this.liveWearAtLapStart = { fl: 0, fr: 0, rl: 0, rr: 0 };
    this.lapTimeHistory = [];
    this.lastCurrentLap = 0;
    this.sessionLapCount = 0;
  }

  setTireThresholds(yellow: number): void {
    this.badHealthThreshold = yellow;
  }

  /**
   * Seed fuel (and optionally tire) histories from previous sessions.
   * Fuel is always seeded (same engine regardless of compound).
   * Tire wear is only seeded for games with known compounds (F1, ACC) —
   * Forza bakes compound into the car build so historical wear is unreliable.
   */
  async seedFromHistory(trackOrdinal: number, carOrdinal: number, pi: number, gameId: GameId): Promise<void> {
    const seedFuel = PitTracker.shouldSeedFuel(gameId);
    const seedTires = PitTracker.shouldSeedTires(gameId);
    try {
      const allLaps = await getLaps(gameId, 200);
      const matching = allLaps
        .filter((l: LapMeta) => l.trackOrdinal === trackOrdinal && l.carOrdinal === carOrdinal && l.pi === pi && l.isValid && l.lapTime > 10)
        .sort((a: LapMeta, b: LapMeta) => b.id - a.id) // newest first
        .slice(0, 5);

      const fuelRates: number[] = [];
      const wearRates: { fl: number; fr: number; rl: number; rr: number }[] = [];

      for (const lapMeta of matching) {
        if ((!seedFuel || fuelRates.length >= 2) && (!seedTires || wearRates.length >= 1)) break;
        const lap = await getLapById(lapMeta.id);
        if (!lap?.telemetry || lap.telemetry.length < 50) continue;

        const first = lap.telemetry[0];
        const last = lap.telemetry[lap.telemetry.length - 1];

        // Fuel
        const fuelUsed = first.Fuel - last.Fuel;
        if (fuelUsed > 0 && fuelRates.length < 2) {
          fuelRates.push(fuelUsed);
        }

        // Tire wear (F1/ACC only — compounds are known/consistent)
        if (seedTires && wearRates.length < 1) {
          const worn = {
            fl: Math.max(0, last.TireWearFL - first.TireWearFL),
            fr: Math.max(0, last.TireWearFR - first.TireWearFR),
            rl: Math.max(0, last.TireWearRL - first.TireWearRL),
            rr: Math.max(0, last.TireWearRR - first.TireWearRR),
          };
          if (Math.max(worn.fl, worn.fr, worn.rl, worn.rr) > 0) {
            wearRates.push(worn);
          }
        }
      }

      if (seedFuel) this.fuelHistory.push(...fuelRates);
      if (seedTires) this.tireWearHistory.push(...wearRates);

      if (fuelRates.length > 0 || wearRates.length > 0) {
        console.log(`[Pit] Seeded from history: ${fuelRates.length} fuel, ${wearRates.length} tire entries (PI=${pi}, game=${gameId})`);
      }
    } catch (err) {
      console.warn("[Pit] Failed to seed from history:", err);
    }
  }

  /** Check if a lap's data should be excluded (formation lap, pit lap, etc.) */
  private isOutlier(fuelUsed: number, lapTime: number): boolean {
    // Fuel increased (refueled during pit stop)
    if (fuelUsed <= 0) return true;
    // Abnormally long lap (>2x rolling average = formation/safety car/pit lap)
    if (this.lapTimeHistory.length >= 2) {
      const avg = this.lapTimeHistory.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, this.lapTimeHistory.length);
      if (lapTime > avg * 2) return true;
    }
    // Abnormally short lap (<30% of average = cut track / rewind artifact)
    if (this.lapTimeHistory.length >= 2) {
      const avg = this.lapTimeHistory.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, this.lapTimeHistory.length);
      if (lapTime < avg * 0.3) return true;
    }
    return false;
  }

  /** Rolling average of the last N entries from an array. */
  private static rollingAvg(arr: number[], n: number): number {
    if (arr.length === 0) return 0;
    const slice = arr.slice(-n);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  }

  feed(packet: TelemetryPacket, trackLength: number, lapDistStart: number = 0): LivePitData {
    // Detect lap boundary
    if (this.lastLap >= 0 && packet.LapNumber > this.lastLap) {
      const lapTime = this.lastCurrentLap; // CurrentLap at end of previous lap

      // Fuel
      const fuelUsed = this.fuelAtLapStart >= 0 ? this.fuelAtLapStart - packet.Fuel : 0;
      const outlier = this.isOutlier(fuelUsed, lapTime);

      if (!outlier && fuelUsed > 0) {
        this.fuelHistory.push(fuelUsed);
        if (this.fuelHistory.length > 50) this.fuelHistory.shift();
        this.sessionLapCount++;
      }
      this.fuelAtLapStart = packet.Fuel;

      // Per-tire wear
      if (!outlier && this.wearAtLapStart.fl >= 0) {
        const worn = {
          fl: packet.TireWearFL - this.wearAtLapStart.fl,
          fr: packet.TireWearFR - this.wearAtLapStart.fr,
          rl: packet.TireWearRL - this.wearAtLapStart.rl,
          rr: packet.TireWearRR - this.wearAtLapStart.rr,
        };
        // Only record if at least one tire showed positive wear
        if (Math.max(worn.fl, worn.fr, worn.rl, worn.rr) > 0) {
          this.tireWearHistory.push(worn);
          if (this.tireWearHistory.length > 50) this.tireWearHistory.shift();
        }
      }
      this.wearAtLapStart = {
        fl: packet.TireWearFL, fr: packet.TireWearFR,
        rl: packet.TireWearRL, rr: packet.TireWearRR,
      };
      // Snapshot for live curve-based delta
      this.liveWearAtLapStart = { ...this.wearAtLapStart };

      // Track lap times for outlier detection
      if (lapTime > 10) {
        this.lapTimeHistory.push(lapTime);
        if (this.lapTimeHistory.length > 20) this.lapTimeHistory.shift();
      }
    }

    if (this.lastLap < 0 || packet.LapNumber !== this.lastLap) {
      if (this.fuelAtLapStart < 0) this.fuelAtLapStart = packet.Fuel;
      if (this.wearAtLapStart.fl < 0) {
        this.wearAtLapStart = {
          fl: packet.TireWearFL, fr: packet.TireWearFR,
          rl: packet.TireWearRL, rr: packet.TireWearRR,
        };
        this.liveWearAtLapStart = { ...this.wearAtLapStart };
      }
      this.lastLap = packet.LapNumber;
    }
    this.lastCurrentLap = packet.CurrentLap;

    // Fuel estimate: rolling average of last 5 valid laps
    const fuelPerLap = PitTracker.rollingAvg(this.fuelHistory, 5);
    const fuelLapsRemaining = fuelPerLap > 0 ? Math.floor((packet.Fuel / fuelPerLap) * 10) / 10 : null;
    const currentLapFuelUsed = this.fuelAtLapStart >= 0 ? this.fuelAtLapStart - packet.Fuel : 0;

    // Tire estimates: curve-based when available, rolling average fallback
    const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
    const toCliff: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    const toDead: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    let projectedWearPerLap = [0, 0, 0, 0]; // per-tire projected full-lap wear

    const lapDist = packet.DistanceTraveled - lapDistStart;

    if (this.refWearCurve && lapDist > 0) {
      // Curve-based: interpolate expected wear at this distance, compute delta, project
      const liveStart = this.liveWearAtLapStart;
      const liveStartArr = [liveStart.fl, liveStart.fr, liveStart.rl, liveStart.rr];
      for (let i = 0; i < 4; i++) {
        const refWear = this.interpolateRefWear(lapDist, i);
        if (refWear >= 0) {
          const actualWearDelta = wears[i] - liveStartArr[i]; // actual wear so far this lap
          const wearDeviation = actualWearDelta - refWear;     // ahead/behind reference
          projectedWearPerLap[i] = Math.max(0, this.refWearCurve.totalWear[i] + wearDeviation);
        }
      }
    }

    // Fallback / floor: use rolling average from per-lap history.
    // Also serves as a minimum — curve projection at lap start can be too low.
    const n = 3;
    const recent = this.tireWearHistory.slice(-n);
    if (recent.length > 0) {
      const avgFromHistory = [
        recent.reduce((s, w) => s + w.fl, 0) / recent.length,
        recent.reduce((s, w) => s + w.fr, 0) / recent.length,
        recent.reduce((s, w) => s + w.rl, 0) / recent.length,
        recent.reduce((s, w) => s + w.rr, 0) / recent.length,
      ];
      for (let i = 0; i < 4; i++) {
        // Use whichever is higher: curve projection or historical average
        projectedWearPerLap[i] = Math.max(projectedWearPerLap[i], avgFromHistory[i]);
      }
    }

    const worstWearPerLap = Math.max(...projectedWearPerLap);

    // Per-tire estimates
    for (let i = 0; i < 4; i++) {
      if (projectedWearPerLap[i] > 0) {
        const h = 1 - wears[i];
        const untilCliff = h - this.badHealthThreshold;
        const untilDead = h - this.criticalHealth;
        toCliff[i] = untilCliff > 0 ? Math.floor((untilCliff / projectedWearPerLap[i]) * 10) / 10 : 0;
        toDead[i] = untilDead > 0 ? Math.floor((untilDead / projectedWearPerLap[i]) * 10) / 10 : 0;
      }
    }

    // Worst-tire summary
    const worstWear = Math.max(...wears);
    const health = 1 - worstWear;
    let tireLapsToBad: number | null = null;
    let tireLapsToCritical: number | null = null;
    if (worstWearPerLap > 0) {
      const wearUntilBad = health - this.badHealthThreshold;
      const wearUntilCritical = health - this.criticalHealth;
      tireLapsToBad = wearUntilBad > 0 ? Math.floor((wearUntilBad / worstWearPerLap) * 10) / 10 : 0;
      tireLapsToCritical = wearUntilCritical > 0 ? Math.floor((wearUntilCritical / worstWearPerLap) * 10) / 10 : 0;
    }

    const tireLapsRemaining = tireLapsToBad;

    let pitInLaps: number | null = null;
    let limitedBy: "fuel" | "tires" | null = null;
    if (fuelLapsRemaining != null || tireLapsRemaining != null) {
      if (fuelLapsRemaining != null && tireLapsRemaining != null) {
        pitInLaps = Math.min(fuelLapsRemaining, tireLapsRemaining);
        limitedBy = fuelLapsRemaining <= tireLapsRemaining ? "fuel" : "tires";
      } else if (fuelLapsRemaining != null) {
        pitInLaps = fuelLapsRemaining;
        limitedBy = "fuel";
      } else {
        pitInLaps = tireLapsRemaining;
        limitedBy = "tires";
      }
    }

    const hasEstimates = fuelPerLap > 0 || worstWearPerLap > 0;
    const estimateSource: "history" | "session" | null = !hasEstimates
      ? null
      : this.sessionLapCount > 0 ? "session" : "history";

    return {
      fuelPerLap,
      fuelLapsRemaining,
      currentLapFuelUsed,
      tireLapsToBad,
      tireLapsToCritical,
      tireEstimates: {
        toCliff,
        toDead,
        wearPerLap: projectedWearPerLap as [number, number, number, number],
      },
      tireWearPerLap: worstWearPerLap,
      tireLapsRemaining,
      pitInLaps,
      limitedBy,
      trackLength,
      estimateSource,
      cliffPct: Math.round(this.badHealthThreshold * 100),
      deadPct: Math.round(this.criticalHealth * 100),
    };
  }

  /** Whether tire wear should be seeded from history for this game. */
  static shouldSeedTires(gameId: string): boolean {
    return gameId !== "fm-2023";
  }

  /** Whether tire wear should use distance-based curve estimation. F1 uses simple rolling avg like fm-2023. */
  static shouldUseCurves(gameId: string): boolean {
    return gameId === "acc";
  }

  /** Whether fuel should be seeded from history. F1 has no refueling so fuel isn't relevant. */
  static shouldSeedFuel(gameId: string): boolean {
    return gameId !== "f1-2025";
  }

  /** Inject fuel/tire history for testing. */
  _seedForTest(fuel: number[], tires: { fl: number; fr: number; rl: number; rr: number }[]): void {
    this.fuelHistory.push(...fuel);
    this.tireWearHistory.push(...tires);
  }

  /**
   * Build a wear curve from a completed lap and update the averaged reference.
   * Called from the pipeline on valid lap completion.
   */
  updateWearCurves(packets: TelemetryPacket[], lapDistStart: number): void {
    if (packets.length < 50) return;
    const startDist = lapDistStart;
    const endDist = packets[packets.length - 1].DistanceTraveled;
    const trackLen = Math.round(endDist - startDist);
    if (trackLen < 100) return;

    // Extract raw per-tire wear deltas relative to lap start
    const startWear = [packets[0].TireWearFL, packets[0].TireWearFR, packets[0].TireWearRL, packets[0].TireWearRR];

    // Resample onto 1-meter grid via linear interpolation
    const wears: [Float64Array, Float64Array, Float64Array, Float64Array] = [
      new Float64Array(trackLen), new Float64Array(trackLen),
      new Float64Array(trackLen), new Float64Array(trackLen),
    ];

    let pi = 0; // packet index cursor
    for (let m = 0; m < trackLen; m++) {
      const targetDist = startDist + m;
      // Advance cursor to bracket targetDist
      while (pi < packets.length - 2 && packets[pi + 1].DistanceTraveled <= targetDist) pi++;
      const p0 = packets[pi];
      const p1 = packets[Math.min(pi + 1, packets.length - 1)];
      const dRange = p1.DistanceTraveled - p0.DistanceTraveled;
      const frac = dRange > 0 ? (targetDist - p0.DistanceTraveled) / dRange : 0;
      const pktWears = [
        [p0.TireWearFL, p1.TireWearFL],
        [p0.TireWearFR, p1.TireWearFR],
        [p0.TireWearRL, p1.TireWearRL],
        [p0.TireWearRR, p1.TireWearRR],
      ];
      for (let t = 0; t < 4; t++) {
        const interpolated = pktWears[t][0] + frac * (pktWears[t][1] - pktWears[t][0]);
        wears[t][m] = interpolated - startWear[t]; // delta from lap start
      }
    }

    const totalWear: [number, number, number, number] = [
      wears[0][trackLen - 1], wears[1][trackLen - 1],
      wears[2][trackLen - 1], wears[3][trackLen - 1],
    ];

    const curve: ResampledWearCurve = { wears, totalWear, length: trackLen };
    this.recentWearCurves.push(curve);
    if (this.recentWearCurves.length > 3) this.recentWearCurves.shift();

    // Average the recent curves into the reference
    this.refWearCurve = this.averageWearCurves();
  }

  /** Point-wise average of recent wear curves. Uses the shortest track length. */
  private averageWearCurves(): ResampledWearCurve | null {
    const curves = this.recentWearCurves;
    if (curves.length === 0) return null;
    const len = Math.min(...curves.map(c => c.length));
    if (len < 100) return null;

    const wears: [Float64Array, Float64Array, Float64Array, Float64Array] = [
      new Float64Array(len), new Float64Array(len),
      new Float64Array(len), new Float64Array(len),
    ];
    const totalWear: [number, number, number, number] = [0, 0, 0, 0];
    const n = curves.length;

    for (let m = 0; m < len; m++) {
      for (let t = 0; t < 4; t++) {
        let sum = 0;
        for (const c of curves) sum += c.wears[t][m];
        wears[t][m] = sum / n;
      }
    }
    for (let t = 0; t < 4; t++) {
      for (const c of curves) totalWear[t] += c.totalWear[t];
      totalWear[t] /= n;
    }

    return { wears, totalWear, length: len };
  }

  /** Interpolate reference wear for a tire at a given lap distance. */
  private interpolateRefWear(lapDist: number, tireIndex: number): number {
    const ref = this.refWearCurve;
    if (!ref || ref.length < 2) return -1;
    const m = Math.floor(lapDist);
    if (m < 0) return 0;
    if (m >= ref.length - 1) return -1;
    const frac = lapDist - m;
    return ref.wears[tireIndex][m] + frac * (ref.wears[tireIndex][m + 1] - ref.wears[tireIndex][m]);
  }

  /** Expose reference wear curve for testing. */
  _getRefWearCurve(): ResampledWearCurve | null {
    return this.refWearCurve;
  }
}
