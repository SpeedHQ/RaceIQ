import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { GameId } from "../../shared/games/ids";
import type { LivePitData } from "../../shared/racing/live/types";
import type { EligibilityDecisionSet } from "../../shared/racing/quality/contracts";
import { isEligibilityUsable, isTimedLapEligibilityUsable } from "../../shared/racing/quality/policies";
import { getLapMetaForPitHistory } from "../db/lap-read-queries";
import { queryLapTelemetryBySemanticId } from "../telemetry/replay";
import { semanticFixedNumbers, semanticNumber, semanticSamplesFromReplay } from "../telemetry/semantic-samples";
import { appendWithCap, interpolateGrid, lapsUntilThreshold, linearInterpolate, rollingAverage } from "./tracker-math";
import type { ServerGameRuntimePolicy } from "../games/types";

const CRITICAL_HEALTH_THRESHOLD = 0.2;
type FourWheelNumbers = readonly [number, number, number, number];
const WHEEL_INDICES = [0, 1, 2, 3] as const;

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
  private completedLapEligibility: EligibilityDecisionSet | null = null;

  // Health thresholds supplied by the active adapter.
  private badHealthThreshold = 0.4;

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
    this.completedLapEligibility = null;
  }

  setTireThresholds(yellow: number): void {
    this.badHealthThreshold = yellow;
  }

  /**
   * Seed enabled fuel and tire histories from previous sessions.
   * The active adapter decides which historical signals are comparable.
   */
  async seedFromHistory(trackOrdinal: number, carOrdinal: number, pi: number, gameId: GameId, policy: ServerGameRuntimePolicy["pit"]): Promise<void> {
    if (!Number.isInteger(trackOrdinal) || trackOrdinal < 0 || !Number.isInteger(carOrdinal) || carOrdinal < 0 || !Number.isFinite(pi)) {
      return;
    }
    const seedFuel = policy.seedFuelFromHistory;
    const seedTires = policy.seedTireWearFromHistory;
    try {
      const matching = await getLapMetaForPitHistory(trackOrdinal, carOrdinal, pi, gameId, 200);

      const fuelRates: number[] = [];
      const wearRates: { fl: number; fr: number; rl: number; rr: number }[] = [];

      for (const lapMeta of matching) {
        const needsFuel = seedFuel && fuelRates.length < 2;
        const needsTires = seedTires && wearRates.length < 1;
        if (!needsFuel && !needsTires) break;
        const fuelEligible = needsFuel && isTimedLapEligibilityUsable(lapMeta, "fuel-burn");
        const tireEligible = needsTires && isTimedLapEligibilityUsable(lapMeta, "tire-analysis");
        if (!fuelEligible && !tireEligible) continue;
        const replay = await queryLapTelemetryBySemanticId(lapMeta.id, ["fuel.fuel", "tires.tire-wear"]);
        if (!replay) continue;
        const samples = semanticSamplesFromReplay(replay);
        if (samples.length < 50) continue;

        let firstFuel: number | null = null;
        let lastFuel: number | null = null;
        let firstWear: FourWheelNumbers | null = null;
        let lastWear: FourWheelNumbers | null = null;
        for (const sample of samples) {
          const fuel = semanticNumber(sample, "fuel.fuel");
          if (fuel !== null) {
            firstFuel ??= fuel;
            lastFuel = fuel;
          }
          const wear = semanticFixedNumbers(sample, "tires.tire-wear", 4);
          if (wear) {
            firstWear ??= wear;
            lastWear = wear;
          }
        }

        // Fuel
        if (fuelEligible && firstFuel !== null && lastFuel !== null && fuelRates.length < 2) {
          const fuelUsed = firstFuel - lastFuel;
          if (fuelUsed > 0) fuelRates.push(fuelUsed);
        }

        // Tire wear is only read when the adapter marks history comparable.
        if (tireEligible && firstWear && lastWear && wearRates.length < 1) {
          const worn = {
            fl: Math.max(0, lastWear[0] - firstWear[0]),
            fr: Math.max(0, lastWear[1] - firstWear[1]),
            rl: Math.max(0, lastWear[2] - firstWear[2]),
            rr: Math.max(0, lastWear[3] - firstWear[3]),
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
  acceptCompletedLap(eligibility: EligibilityDecisionSet): void {
    this.completedLapEligibility = eligibility;
  }

  private isLapTimeOutlier(lapTime: number): boolean {
    if (this.lapTimeHistory.length >= 2) {
      const avg = rollingAverage(this.lapTimeHistory, 5);
      if (lapTime > avg * 2 || lapTime < avg * 0.3) return true;
    }
    return false;
  }

  private isFuelOutlier(fuelUsed: number, lapTime: number): boolean {
    return fuelUsed <= 0 || this.isLapTimeOutlier(lapTime);
  }

  /** Native adapter ingress. Normal live consumers use feedSemantic. */
  feed(packet: TelemetryPacket, trackLength: number, lapDistStart: number = 0): LivePitData {
    return this.feedValues(
      packet.LapNumber,
      packet.CurrentLap,
      packet.Fuel,
      [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR],
      packet.DistanceTraveled,
      trackLength,
      lapDistStart,
    );
  }

  /** Resolver-backed live pit context. Missing required channels omit context. */
  feedSemantic(sample: SemanticTelemetrySample, trackLength: number, lapDistStart: number = 0): LivePitData | null {
    const lapNumber = semanticNumber(sample, "timing.lap-number");
    const currentLap = semanticNumber(sample, "timing.current-lap");
    const fuel = semanticNumber(sample, "fuel.fuel");
    const distanceTraveled = semanticNumber(sample, "timing.distance-traveled");
    const tires = semanticFixedNumbers(sample, "tires.tire-wear", 4);
    if (lapNumber === null || currentLap === null || fuel === null || distanceTraveled === null || tires === null) {
      return null;
    }
    return this.feedValues(lapNumber, currentLap, fuel, tires as readonly [number, number, number, number], distanceTraveled, trackLength, lapDistStart);
  }

  private feedValues(
    lapNumber: number,
    currentLap: number,
    fuel: number,
    tireWears: readonly [number, number, number, number],
    distanceTraveled: number,
    trackLength: number,
    lapDistStart: number,
  ): LivePitData {
    if (this.lastLap >= 0 && lapNumber > this.lastLap) {
      const fuelUsable = isEligibilityUsable(this.completedLapEligibility?.["fuel-burn"]);
      const tireUsable = isEligibilityUsable(this.completedLapEligibility?.["tire-analysis"]);
      const normalPaceUsable = isEligibilityUsable(this.completedLapEligibility?.["normal-pace"]);
      this.completedLapEligibility = null;
      const lapTime = this.lastCurrentLap;

      const fuelUsed = this.fuelAtLapStart >= 0 ? this.fuelAtLapStart - fuel : 0;
      const lapTimeOutlier = this.isLapTimeOutlier(lapTime);
      const fuelOutlier = this.isFuelOutlier(fuelUsed, lapTime);
      if (fuelUsable && fuelUsed > 0 && !fuelOutlier) {
        appendWithCap(this.fuelHistory, fuelUsed, 50);
        this.sessionLapCount++;
      }
      this.fuelAtLapStart = fuel;

      if (tireUsable && !lapTimeOutlier && this.wearAtLapStart.fl >= 0) {
        const worn = {
          fl: tireWears[0] - this.wearAtLapStart.fl,
          fr: tireWears[1] - this.wearAtLapStart.fr,
          rl: tireWears[2] - this.wearAtLapStart.rl,
          rr: tireWears[3] - this.wearAtLapStart.rr,
        };
        if (Math.max(worn.fl, worn.fr, worn.rl, worn.rr) > 0) {
          appendWithCap(this.tireWearHistory, worn, 50);
        }
      }
      this.wearAtLapStart = {
        fl: tireWears[0],
        fr: tireWears[1],
        rl: tireWears[2],
        rr: tireWears[3],
      };
      this.liveWearAtLapStart = { ...this.wearAtLapStart };
      if (normalPaceUsable && lapTime > 10) {
        appendWithCap(this.lapTimeHistory, lapTime, 20);
      }
    }

    if (this.lastLap < 0 || lapNumber !== this.lastLap) {
      if (this.fuelAtLapStart < 0) this.fuelAtLapStart = fuel;
      if (this.wearAtLapStart.fl < 0) {
        this.wearAtLapStart = {
          fl: tireWears[0],
          fr: tireWears[1],
          rl: tireWears[2],
          rr: tireWears[3],
        };
        this.liveWearAtLapStart = { ...this.wearAtLapStart };
      }
      this.lastLap = lapNumber;
    }
    this.lastCurrentLap = currentLap;

    const fuelPerLap = rollingAverage(this.fuelHistory, 5);
    const fuelLapsRemaining = fuelPerLap > 0 ? Math.floor((fuel / fuelPerLap) * 10) / 10 : null;
    const currentLapFuelUsed = this.fuelAtLapStart >= 0 ? this.fuelAtLapStart - fuel : 0;

    const toCliff: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    const toDead: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    const projectedWearPerLap = [0, 0, 0, 0];
    const lapDist = distanceTraveled - lapDistStart;

    if (this.refWearCurve && lapDist > 0) {
      const liveStart = this.liveWearAtLapStart;
      const liveStartArr = [liveStart.fl, liveStart.fr, liveStart.rl, liveStart.rr];
      for (let index = 0; index < 4; index++) {
        const refWear = interpolateGrid(this.refWearCurve.wears[index], lapDist);
        if (refWear >= 0) {
          const actualWearDelta = tireWears[index] - liveStartArr[index];
          const wearDeviation = actualWearDelta - refWear;
          projectedWearPerLap[index] = Math.max(0, this.refWearCurve.totalWear[index] + wearDeviation);
        }
      }
    }

    const historyStart = Math.max(0, this.tireWearHistory.length - 3);
    const recentCount = this.tireWearHistory.length - historyStart;
    if (recentCount > 0) {
      const avgFromHistory = [0, 0, 0, 0];
      for (let index = historyStart; index < this.tireWearHistory.length; index++) {
        const wear = this.tireWearHistory[index];
        avgFromHistory[0] += wear.fl;
        avgFromHistory[1] += wear.fr;
        avgFromHistory[2] += wear.rl;
        avgFromHistory[3] += wear.rr;
      }
      for (let index = 0; index < 4; index++) {
        avgFromHistory[index] /= recentCount;
        projectedWearPerLap[index] = Math.max(projectedWearPerLap[index], avgFromHistory[index]);
      }
    }
    const worstWearPerLap = Math.max(...projectedWearPerLap);

    for (let index = 0; index < 4; index++) {
      const health = 1 - tireWears[index];
      toCliff[index] = lapsUntilThreshold(health, this.badHealthThreshold, projectedWearPerLap[index]);
      toDead[index] = lapsUntilThreshold(health, CRITICAL_HEALTH_THRESHOLD, projectedWearPerLap[index]);
    }

    const worstWear = Math.max(...tireWears);
    const health = 1 - worstWear;
    const tireLapsToBad = lapsUntilThreshold(health, this.badHealthThreshold, worstWearPerLap);
    const tireLapsToCritical = lapsUntilThreshold(health, CRITICAL_HEALTH_THRESHOLD, worstWearPerLap);
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
    const estimateSource: "history" | "session" | null = !hasEstimates ? null : this.sessionLapCount > 0 ? "session" : "history";
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

  /** Dev replay-only native helper. Normal live completion uses semantic samples. */
  updateWearCurves(packets: TelemetryPacket[], lapDistStart: number): void {
    if (packets.length < 50) return;
    const startDist = lapDistStart;
    const endDist = packets[packets.length - 1].DistanceTraveled;
    const trackLen = Math.round(endDist - startDist);
    if (trackLen < 100) return;

    // Extract raw per-tire wear deltas relative to lap start
    const startWear = [packets[0].TireWearFL, packets[0].TireWearFR, packets[0].TireWearRL, packets[0].TireWearRR];

    // Resample onto 1-meter grid via linear interpolation
    const wears: [Float64Array, Float64Array, Float64Array, Float64Array] = [new Float64Array(trackLen), new Float64Array(trackLen), new Float64Array(trackLen), new Float64Array(trackLen)];

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

    const totalWear: [number, number, number, number] = [wears[0][trackLen - 1], wears[1][trackLen - 1], wears[2][trackLen - 1], wears[3][trackLen - 1]];

    const curve: ResampledWearCurve = { wears, totalWear, length: trackLen };
    appendWithCap(this.recentWearCurves, curve, 3);

    // Average the recent curves into the reference
    this.refWearCurve = this.averageWearCurves();
  }
  /** Build distance-based wear curves from resolver-backed completed-lap samples. */
  updateWearCurvesFromSemanticSamples(samples: readonly SemanticTelemetrySample[]): void {
    const distances: number[] = [];
    const tireWears: FourWheelNumbers[] = [];
    for (const sample of samples) {
      const distance = semanticNumber(sample, "timing.distance-traveled");
      const tireWear = semanticFixedNumbers(sample, "tires.tire-wear", 4);
      if (distance === null || tireWear === null) continue;
      distances.push(distance);
      tireWears.push(tireWear);
    }
    if (distances.length < 50) return;
    const startDist = distances[0];
    const endDist = distances.at(-1);
    const startWear = tireWears[0];
    if (startDist === undefined || endDist === undefined || startWear === undefined) return;
    const trackLen = Math.round(endDist - startDist);
    if (trackLen < 100) return;

    const wears: [Float64Array, Float64Array, Float64Array, Float64Array] = [new Float64Array(trackLen), new Float64Array(trackLen), new Float64Array(trackLen), new Float64Array(trackLen)];
    let sampleIndex = 0;
    for (let metre = 0; metre < trackLen; metre++) {
      const targetDist = startDist + metre;
      while (sampleIndex < distances.length - 2) {
        const nextDistance = distances[sampleIndex + 1];
        if (nextDistance === undefined || nextDistance > targetDist) break;
        sampleIndex++;
      }
      const nextIndex = Math.min(sampleIndex + 1, distances.length - 1);
      const currentDistance = distances[sampleIndex];
      const nextDistance = distances[nextIndex];
      const firstWears = tireWears[sampleIndex];
      const nextWears = tireWears[nextIndex];
      if (currentDistance === undefined || nextDistance === undefined || firstWears === undefined || nextWears === undefined) return;
      const distanceRange = nextDistance - currentDistance;
      const fraction = distanceRange > 0 ? (targetDist - currentDistance) / distanceRange : 0;
      for (const tire of WHEEL_INDICES) {
        wears[tire][metre] = linearInterpolate(firstWears[tire], nextWears[tire], fraction) - startWear[tire];
      }
    }
    const finalIndex = trackLen - 1;
    const [frontLeft, frontRight, rearLeft, rearRight] = [wears[0][finalIndex], wears[1][finalIndex], wears[2][finalIndex], wears[3][finalIndex]];
    if (frontLeft === undefined || frontRight === undefined || rearLeft === undefined || rearRight === undefined) return;
    const totalWear: [number, number, number, number] = [frontLeft, frontRight, rearLeft, rearRight];
    appendWithCap(this.recentWearCurves, { wears, totalWear, length: trackLen }, 3);
    this.refWearCurve = this.averageWearCurves();
  }

  /** Point-wise average of recent wear curves. Uses the shortest track length. */
  private averageWearCurves(): ResampledWearCurve | null {
    const curves = this.recentWearCurves;
    if (curves.length === 0) return null;
    const len = Math.min(...curves.map((c) => c.length));
    if (len < 100) return null;

    const wears: [Float64Array, Float64Array, Float64Array, Float64Array] = [new Float64Array(len), new Float64Array(len), new Float64Array(len), new Float64Array(len)];
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
      refWearCurveLength: this.refWearCurve ? (this.refWearCurve.wears[0]?.length ?? 0) : 0,
      liveWearAtLapStart: this.liveWearAtLapStart,
      lapTimeHistoryLength: this.lapTimeHistory.length,
      lastCurrentLap: this.lastCurrentLap,
      sessionLapCount: this.sessionLapCount,
      badHealthThreshold: this.badHealthThreshold,
      criticalHealth: CRITICAL_HEALTH_THRESHOLD,
    };
  }
}
