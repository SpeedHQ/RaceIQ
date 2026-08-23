/**
 * Server-side sector timing tracker.
 *
 * Computes live sector splits from the telemetry packet stream using
 * distance-fraction sector boundaries. Broadcast via WebSocket so the
 * client just renders numbers.
 */
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { LiveSectorData } from "../../shared/racing/live/types";
import { getGame } from "../../shared/games/registry";
import type { GameAdapter } from "../../shared/games/types";
import { resolveTrack } from "../tracks/info";
import { semanticNumber } from "../telemetry/semantic-samples";
import { interpolateMonotonic, sectorFromDistanceFraction } from "./tracker-math";

interface SectorBounds {
  starts: number[];
  trackLength: number;
}

/** Reference lap distance-time curve for interpolation-based delta. */
interface ReferenceLap {
  distances: Float64Array; // per-lap distance (meters from lap start)
  times: Float64Array; // elapsed time at each distance point
  lapTime: number;
}
export interface LiveNativeSectorLayout {
  starts: readonly number[];
  lapFraction?: number;
  trackLengthM?: number;
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
    this.resetLapProgress(0);
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

    console.log(
      `[Sectors] Loaded for track ${trackOrdinal} (${gameId}): s1=${sectors.s1End}, s2=${sectors.s2End}, length=${trackLength.toFixed(0)}m, seeded best=${this.bestLapTime === Infinity ? "none" : this.bestLapTime.toFixed(3)}`,
    );
  }

  /** Native adapter ingress. Normal live consumers use feedSemantic. */
  feed(packet: TelemetryPacket): LiveSectorData | null {
    return this.feedValues(packet.DistanceTraveled, packet.LapNumber, packet.CurrentLap, packet.LastLap, this.currentGame?.getNativeSectorLayout?.(packet), packet.acc?.currentSectorIndex);
  }

  /** Resolver-backed live sector context. Missing layout/value abstains. */
  feedSemantic(sample: SemanticTelemetrySample, nativeLayout?: LiveNativeSectorLayout): LiveSectorData | null {
    const distanceTraveled = semanticNumber(sample, "timing.distance-traveled");
    const lapNumber = semanticNumber(sample, "timing.lap-number");
    const currentLap = semanticNumber(sample, "timing.current-lap");
    if (distanceTraveled === null || lapNumber === null || currentLap === null) return null;
    if (this.currentGame?.nativeSectors && nativeLayout === undefined) return null;
    return this.feedValues(distanceTraveled, lapNumber, currentLap, semanticNumber(sample, "timing.last-lap"), nativeLayout, semanticNumber(sample, "timing.sector.current-index"));
  }

  private feedValues(
    distanceTraveled: number,
    lapNumber: number,
    currentLap: number,
    lastLapTime: number | null,
    nativeLayout?: LiveNativeSectorLayout,
    semanticSectorIndex?: number | null,
  ): LiveSectorData | null {
    if (this.currentGame?.nativeSectors) {
      const starts = nativeLayout?.starts;
      if (starts && starts.length >= 2 && Number.isFinite(starts[0]) && starts[0] >= 0 && starts[0] < 1e-6) {
        const trackLength = nativeLayout?.trackLengthM ?? 0;
        this.setNativeSectorLayout([...starts], trackLength);
        if (this.lapDistTotal <= 0 && trackLength > 0) {
          this.lapDistTotal = trackLength;
        }
      } else {
        return null;
      }
    }
    if (!this.bounds) return null;

    if (!this.initialized) {
      this.initialized = true;
      this.lapDistStart = distanceTraveled;
      this.lastLap = lapNumber;
      this.sectorStartTime = currentLap;
      this.prevCurrentLap = currentLap;
    }
    if (distanceTraveled < this.lapDistStart - 100) {
      this.lapDistStart = distanceTraveled;
      this.resetLapProgress(currentLap);
    }

    const currentLapReset = this.prevCurrentLap > 5 && currentLap < 1;
    this.prevCurrentLap = currentLap;
    if (lapNumber > this.lastLap || currentLapReset) {
      const hasCompletedSectors = this.currentTimes.slice(0, this.sectorCount - 1).every((time) => time > 0);
      if (hasCompletedSectors && lastLapTime !== null) {
        this.lastTimes = [...this.currentTimes];
        const completedTime = this.currentTimes.slice(0, this.sectorCount - 1).reduce((sum, time) => sum + time, 0);
        this.lastTimes[this.sectorCount - 1] = Math.max(0, lastLapTime - completedTime);
      }
      if (lastLapTime !== null && lastLapTime > 0) {
        this.lastLapTime = lastLapTime;
      }

      const completedDist = distanceTraveled - this.lapDistStart;
      const minPlausibleLap = this.currentGameId === "acc" && this.bounds ? this.bounds.trackLength * 0.5 : 100;
      if (!this.currentGame?.authoritativeTrackLength && completedDist > minPlausibleLap) {
        this.lapDistTotal = completedDist;
      }
      this.lapDistStart = distanceTraveled;
      this.resetLapProgress(0);
    }
    this.lastLap = lapNumber;
    const canonicalSector =
      semanticSectorIndex !== null && semanticSectorIndex !== undefined && Number.isInteger(semanticSectorIndex) && semanticSectorIndex >= 0 && semanticSectorIndex < this.sectorCount
        ? semanticSectorIndex
        : undefined;
    const fraction = this.currentGame?.nativeSectors ? nativeLayout?.lapFraction : this.lapDistTotal > 0 ? (distanceTraveled - this.lapDistStart) / this.lapDistTotal : undefined;
    const expectedSector = canonicalSector ?? (fraction === undefined ? this.currentSector : sectorFromDistanceFraction(this.bounds.starts, fraction));
    this.advanceSector(expectedSector, currentLap);

    const currentSectorTime = currentLap - this.sectorStartTime;
    let estimatedLap = 0;
    let deltaToBest = 0;
    if (this.refLap && currentLap > 0) {
      const lapDist = distanceTraveled - this.lapDistStart;
      if (lapDist > 0) {
        const refTime = interpolateMonotonic(this.refLap.times, this.refLap.distances, lapDist);
        if (refTime !== null && refTime >= 0) {
          deltaToBest = currentLap - refTime;
          estimatedLap = this.refLap.lapTime + deltaToBest;
        }
      }
    }
    const deltaToLast = estimatedLap > 0 && this.lastLapTime > 0 ? estimatedLap - this.lastLapTime : 0;
    return {
      sectorCount: this.sectorCount,
      currentSector: this.currentSector,
      currentSectorTime,
      currentTimes: [...this.currentTimes],
      lastTimes: [...this.lastTimes],
      bestTimes: this.bestTimes.map((time) => (time === Infinity ? 0 : time)),
      lastLapTime: this.lastLapTime,
      bestLapTime: this.bestLapTime === Infinity ? 0 : this.bestLapTime,
      estimatedLap,
      deltaToBest,
      deltaToLast,
    };
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
  private buildRefLapFromSemanticSamples(samples: readonly SemanticTelemetrySample[], lapTime: number): ReferenceLap | null {
    const distances: number[] = [];
    const times: number[] = [];
    let lapDistStart: number | undefined;
    for (const sample of samples) {
      const distance = semanticNumber(sample, "timing.distance-traveled");
      const currentLap = semanticNumber(sample, "timing.current-lap");
      if (distance === null || currentLap === null) continue;
      lapDistStart ??= distance;
      distances.push(distance - lapDistStart);
      times.push(currentLap);
    }
    if (distances.length === 0) return null;
    return {
      distances: Float64Array.from(distances),
      times: Float64Array.from(times),
      lapTime,
    };
  }

  private updateReferenceLap(reference: ReferenceLap | null, lapTime: number, sectors?: number[] | null): void {
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
    if (!reference || (this.refLap && lapTime >= this.refLap.lapTime)) return;
    this.refLap = reference;
  }

  private resetLapProgress(sectorStartTime: number): void {
    this.currentSector = 0;
    this.sectorStartTime = sectorStartTime;
    this.currentTimes = Array(this.sectorCount).fill(0);
  }
  private advanceSector(nextSector: number, currentLapTime: number): void {
    if (nextSector <= this.currentSector || nextSector >= this.sectorCount) {
      return;
    }
    this.currentTimes[this.currentSector] = currentLapTime - this.sectorStartTime;
    this.sectorStartTime = currentLapTime;
    this.currentSector = nextSector;
  }

  private setNativeSectorLayout(starts: readonly number[], trackLength: number): void {
    const previousStarts = this.bounds?.starts;
    const changed = !previousStarts || previousStarts.length !== starts.length || starts.some((start, index) => start !== previousStarts[index]);
    const resolvedTrackLength = trackLength > 0 ? trackLength : (this.bounds?.trackLength ?? 0);
    if (!changed) {
      if (this.bounds && this.bounds.trackLength !== resolvedTrackLength) {
        this.bounds = {
          starts: this.bounds.starts,
          trackLength: resolvedTrackLength,
        };
      }
      return;
    }
    this.bounds = { starts: [...starts], trackLength: resolvedTrackLength };

    this.sectorCount = starts.length;
    this.resetLapProgress(this.sectorStartTime);
    this.lastTimes = Array(this.sectorCount).fill(0);
    this.bestTimes = Array(this.sectorCount).fill(Infinity);
  }

  /** Update reference lap and bests from a just-completed detector lap. */
  updateRefLap(packets: TelemetryPacket[], lapTime: number, sectors?: number[] | null): void {
    this.updateReferenceLap(this.buildRefLapFromPackets(packets, lapTime), lapTime, sectors);
  }

  /** Update live reference pacing only from resolver-backed semantic samples. */
  updateRefLapFromSemanticSamples(samples: readonly SemanticTelemetrySample[], lapTime: number, sectors?: number[] | null): void {
    this.updateReferenceLap(this.buildRefLapFromSemanticSamples(samples, lapTime), lapTime, sectors);
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

  /** Expose track length to telemetry consumers. */
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
