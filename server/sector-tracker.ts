/**
 * Server-side sector timing tracker.
 *
 * Computes live sector splits from the telemetry packet stream using
 * distance-fraction sector boundaries. Broadcast via WebSocket so the
 * client just renders numbers.
 */
import type { TelemetryPacket, GameId, LiveSectorData, LivePitData } from "../shared/types";
import { getTrackOutlineSectors } from "./db/queries";
import { getTrackSectorsByOrdinal, getTrackOutlineByOrdinal, loadSharedTrackMeta } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";

interface SectorBounds {
  s1End: number;
  s2End: number;
  trackLength: number;
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

  /** Reset for a new session — loads sector boundaries and track length. */
  async reset(trackOrdinal: number, gameId: GameId): Promise<void> {
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

    console.log(`[Sectors] Loaded for track ${trackOrdinal} (${gameId}): s1=${sectors.s1End}, s2=${sectors.s2End}, length=${trackLength.toFixed(0)}m`);
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
    }

    // Handle backward distance jump (demo loop / teleport)
    if (packet.DistanceTraveled < this.lapDistStart - 100) {
      this.lapDistStart = packet.DistanceTraveled;
      this.currentSector = 0;
      this.sectorStartTime = packet.CurrentLap;
      this.currentTimes = [0, 0, 0];
    }

    // Lap boundary crossed
    if (packet.LapNumber > this.lastLap && this.lastLap > 0) {
      if (this.currentTimes[0] > 0 && this.currentTimes[1] > 0) {
        this.lastTimes = [...this.currentTimes] as [number, number, number];
        this.lastTimes[2] = packet.LastLap - this.currentTimes[0] - this.currentTimes[1];
        if (this.lastTimes[2] < 0) this.lastTimes[2] = 0;

        for (let i = 0; i < 3; i++) {
          if (this.lastTimes[i] > 0 && this.lastTimes[i] < this.bestTimes[i]) {
            this.bestTimes[i] = this.lastTimes[i];
          }
        }
      }

      if (packet.LastLap > 0) {
        this.lastLapTime = packet.LastLap;
        if (packet.LastLap < this.bestLapTime) {
          this.bestLapTime = packet.LastLap;
        }
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

    // Estimated lap time
    const hasBests = this.bestTimes[0] < Infinity && this.bestTimes[1] < Infinity && this.bestTimes[2] < Infinity;
    let estimatedLap = 0;
    if (hasBests) {
      for (let i = 0; i < 3; i++) {
        if (i < this.currentSector) {
          estimatedLap += this.currentTimes[i];
        } else if (i === this.currentSector) {
          estimatedLap += currentSectorTime;
        } else {
          estimatedLap += this.bestTimes[i];
        }
      }
    }

    const deltaToBest = hasBests && packet.CurrentLap > 0 && this.bestLapTime < Infinity
      ? estimatedLap - this.bestLapTime
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
    };
  }

  /** Expose track length so PitTracker can use it */
  getTrackLength(): number {
    return this.bounds?.trackLength ?? 0;
  }
}

/**
 * Server-side pit strategy tracker.
 * Computes fuel/tire laps remaining from per-lap consumption history.
 */
export class PitTracker {
  private fuelHistory: number[] = []; // fuel used per lap (fraction or litres)
  private fuelAtLapStart = -1;
  private lastLap = -1;
  private avgFuelPerLap: number | null = null;

  reset(): void {
    this.fuelHistory = [];
    this.fuelAtLapStart = -1;
    this.lastLap = -1;
    this.avgFuelPerLap = null;
  }

  feed(packet: TelemetryPacket, trackLength: number): LivePitData {
    // Detect lap boundary → record fuel used
    if (this.lastLap >= 0 && packet.LapNumber > this.lastLap && this.fuelAtLapStart >= 0) {
      const used = this.fuelAtLapStart - packet.Fuel;
      if (used > 0 && used < packet.Fuel + used) { // sanity: used < total capacity
        this.fuelHistory.push(used);
        if (this.fuelHistory.length > 50) this.fuelHistory.shift();
        const recent = this.fuelHistory.slice(-5);
        this.avgFuelPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
      }
      this.fuelAtLapStart = packet.Fuel;
    }
    if (this.lastLap < 0 || packet.LapNumber !== this.lastLap) {
      if (this.fuelAtLapStart < 0) this.fuelAtLapStart = packet.Fuel;
      this.lastLap = packet.LapNumber;
    }

    const fuelPerLap = this.avgFuelPerLap ?? 0;
    const fuelLapsRemaining = fuelPerLap > 0 ? Math.floor((packet.Fuel / fuelPerLap) * 10) / 10 : null;
    const currentLapFuelUsed = this.fuelAtLapStart >= 0 ? this.fuelAtLapStart - packet.Fuel : 0;

    // Tire laps remaining: use worst tire wear rate
    const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
    const worstWear = Math.max(...wears);
    // Rough estimate: if we know fuel per lap and track length, extrapolate wear per lap
    // For now, simple: if wear > 0 and laps done > 0, estimate from average
    let tireLapsRemaining: number | null = null;
    if (this.fuelHistory.length > 0 && worstWear > 0) {
      // Estimate wear per lap from total wear / laps completed
      const lapsCompleted = this.fuelHistory.length;
      const wearPerLap = worstWear / lapsCompleted;
      if (wearPerLap > 0) {
        tireLapsRemaining = Math.floor(((1 - worstWear) / wearPerLap) * 10) / 10;
      }
    }

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

    return {
      fuelPerLap,
      fuelLapsRemaining,
      currentLapFuelUsed,
      tireLapsRemaining,
      pitInLaps,
      limitedBy,
      trackLength,
    };
  }
}
