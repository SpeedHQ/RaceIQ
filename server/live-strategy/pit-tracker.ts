import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { LivePitData } from "../../shared/live/types";
import type { LapMeta } from "../../shared/sessions/types";
import { getLaps, getLapById } from "../db/lap-read-queries";
import type { ServerGameRuntimePolicy } from "../games/types";
import {
  appendWithCap,
  interpolateGrid,
  lapsUntilThreshold,
  linearInterpolate,
  rollingAverage,
} from "./tracker-math";

const CRITICAL_HEALTH_THRESHOLD = 0.20;

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

  // Health thresholds supplied by the active adapter.
  private badHealthThreshold = 0.40;

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
   * Seed enabled fuel and tire histories from previous sessions.
   * The active adapter decides which historical signals are comparable.
   */
  async seedFromHistory(
    trackOrdinal: number,
    carOrdinal: number,
    pi: number,
    gameId: GameId,
    policy: ServerGameRuntimePolicy["pit"],
  ): Promise<void> {
    const seedFuel = policy.seedFuelFromHistory;
    const seedTires = policy.seedTireWearFromHistory;
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

        // Tire wear is only read when the adapter marks history comparable.
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
      const avg = rollingAverage(this.lapTimeHistory, 5);
      // Abnormally long = formation/safety car/pit lap; abnormally short =
      // cut-track or rewind artifact.
      if (lapTime > avg * 2 || lapTime < avg * 0.3) return true;
    }
    return false;
  }

  feed(packet: TelemetryPacket, trackLength: number, lapDistStart: number = 0): LivePitData {
    // Detect lap boundary
    if (this.lastLap >= 0 && packet.LapNumber > this.lastLap) {
      const lapTime = this.lastCurrentLap; // CurrentLap at end of previous lap

      // Fuel
      const fuelUsed = this.fuelAtLapStart >= 0 ? this.fuelAtLapStart - packet.Fuel : 0;
      const outlier = this.isOutlier(fuelUsed, lapTime);

      if (!outlier && fuelUsed > 0) {
        appendWithCap(this.fuelHistory, fuelUsed, 50);
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
          appendWithCap(this.tireWearHistory, worn, 50);
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
        appendWithCap(this.lapTimeHistory, lapTime, 20);
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
    const fuelPerLap = rollingAverage(this.fuelHistory, 5);
    const fuelLapsRemaining = fuelPerLap > 0 ? Math.floor((packet.Fuel / fuelPerLap) * 10) / 10 : null;
    const currentLapFuelUsed = this.fuelAtLapStart >= 0 ? this.fuelAtLapStart - packet.Fuel : 0;

    // Tire estimates: curve-based when available, rolling average fallback
    const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
    const toCliff: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    const toDead: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    const projectedWearPerLap = [0, 0, 0, 0]; // per-tire projected full-lap wear

    const lapDist = packet.DistanceTraveled - lapDistStart;

    if (this.refWearCurve && lapDist > 0) {
      // Curve-based: interpolate expected wear at this distance, compute delta, project
      const liveStart = this.liveWearAtLapStart;
      const liveStartArr = [liveStart.fl, liveStart.fr, liveStart.rl, liveStart.rr];
      for (let i = 0; i < 4; i++) {
        const refWear = interpolateGrid(this.refWearCurve.wears[i], lapDist);
        if (refWear >= 0) {
          const actualWearDelta = wears[i] - liveStartArr[i]; // actual wear so far this lap
          const wearDeviation = actualWearDelta - refWear;     // ahead/behind reference
          projectedWearPerLap[i] = Math.max(0, this.refWearCurve.totalWear[i] + wearDeviation);
        }
      }
    }

    // Fallback / floor: use rolling average from per-lap history.
    // Also serves as a minimum — curve projection at lap start can be too low.
    const historyStart = Math.max(0, this.tireWearHistory.length - 3);
    const recentCount = this.tireWearHistory.length - historyStart;
    if (recentCount > 0) {
      const avgFromHistory = [0, 0, 0, 0];
      for (let i = historyStart; i < this.tireWearHistory.length; i++) {
        const wear = this.tireWearHistory[i];
        avgFromHistory[0] += wear.fl;
        avgFromHistory[1] += wear.fr;
        avgFromHistory[2] += wear.rl;
        avgFromHistory[3] += wear.rr;
      }
      for (let i = 0; i < 4; i++) {
        avgFromHistory[i] /= recentCount;
        // Use whichever is higher: curve projection or historical average.
        projectedWearPerLap[i] = Math.max(projectedWearPerLap[i], avgFromHistory[i]);
      }
    }
    const worstWearPerLap = Math.max(...projectedWearPerLap);

    // Per-tire estimates
    for (let i = 0; i < 4; i++) {
      const health = 1 - wears[i];
      toCliff[i] = lapsUntilThreshold(
        health,
        this.badHealthThreshold,
        projectedWearPerLap[i],
      );
      toDead[i] = lapsUntilThreshold(
        health,
        CRITICAL_HEALTH_THRESHOLD,
        projectedWearPerLap[i],
      );
    }

    // Worst-tire summary
    const worstWear = Math.max(...wears);
    const health = 1 - worstWear;
    const tireLapsToBad = lapsUntilThreshold(
      health,
      this.badHealthThreshold,
      worstWearPerLap,
    );
    const tireLapsToCritical = lapsUntilThreshold(
      health,
      CRITICAL_HEALTH_THRESHOLD,
      worstWearPerLap,
    );

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
      deadPct: Math.round(CRITICAL_HEALTH_THRESHOLD * 100),
    };
  }

  /** Inject fuel/tire history for testing. */
  _seedForTest(fuel: number[], tires: { fl: number; fr: number; rl: number; rr: number }[]): void {
    this.fuelHistory.push(...fuel);
    this.tireWearHistory.push(...tires);
  }

  /**
   * Called by live telemetry processing on valid lap completion.
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
        const interpolated = linearInterpolate(pktWears[t][0], pktWears[t][1], frac);
        wears[t][m] = interpolated - startWear[t]; // delta from lap start
      }
    }

    const totalWear: [number, number, number, number] = [
      wears[0][trackLen - 1], wears[1][trackLen - 1],
      wears[2][trackLen - 1], wears[3][trackLen - 1],
    ];

    const curve: ResampledWearCurve = { wears, totalWear, length: trackLen };
    appendWithCap(this.recentWearCurves, curve, 3);

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

  /** Expose reference wear curve for testing. */
  _getRefWearCurve(): ResampledWearCurve | null {
    return this.refWearCurve;
  }

  getDebugState(): Record<string, unknown> {
    return {
      fuelHistoryLength: this.fuelHistory.length,
      fuelAtLapStart: this.fuelAtLapStart,
      lastLap: this.lastLap,
      tireWearHistoryLength: this.tireWearHistory.length,
      wearAtLapStart: this.wearAtLapStart,
      recentWearCurvesLength: this.recentWearCurves.length,
      refWearCurveLength: this.refWearCurve ? this.refWearCurve.wears[0]?.length ?? 0 : 0,
      liveWearAtLapStart: this.liveWearAtLapStart,
      lapTimeHistoryLength: this.lapTimeHistory.length,
      lastCurrentLap: this.lastCurrentLap,
      sessionLapCount: this.sessionLapCount,
      badHealthThreshold: this.badHealthThreshold,
      criticalHealth: CRITICAL_HEALTH_THRESHOLD,
    };
  }
}
