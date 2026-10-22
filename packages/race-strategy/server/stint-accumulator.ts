import type { GameId } from "@raceiq/shared/games/ids";
import type { CompatibilityContext, FourWheels, MetricRate, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { STRATEGY_ALGORITHM_VERSION, type LapMetricContribution } from "./lap-metrics";

export interface StintIdentity {
  id: string; sessionId: number; driverKey: string; ordinal: number; gameId: GameId; trackId: string; carId: string;
  pi: number | null; compounds: FourWheels<string | null>; compatibility: CompatibilityContext;
  fuelUnit: "L" | "tankFraction"; startedAt: string;
}
export interface StrategyTotals {
  fuel: number; fuelCount: number; tire0: number; tire1: number; tire2: number; tire3: number;
  tireCounts: FourWheels<number>; measuredFuel: number; measuredLaps: number; completeFuelLaps: number; pace: number; paceCount: number;
  virtualEnergy: number; virtualEnergyCount: number;
}
type RateStatistics = { median: number | null; peak: number | null };
function insertSample(samples: number[], value: number): void {
  let low = 0, high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle]! < value) low = middle + 1;
    else high = middle;
  }
  samples.splice(low, 0, value);
}
function statistics(samples: number[]): RateStatistics {
  const middle = samples.length >>> 1;
  return {
    median: samples.length === 0 ? null : samples.length % 2 === 1 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2,
    peak: samples.at(-1) ?? null,
  };
}
export class StintMetricAccumulator {
  private summary: StintSummary;
  private sums: StrategyTotals = { fuel: 0, fuelCount: 0, tire0: 0, tire1: 0, tire2: 0, tire3: 0, tireCounts: [0, 0, 0, 0], measuredFuel: 0, measuredLaps: 0, completeFuelLaps: 0, pace: 0, paceCount: 0, virtualEnergy: 0, virtualEnergyCount: 0 };
  private fuelSamples: number[] = [];
  private energySamples: number[] = [];
  private tireSamples: FourWheels<number[]> = [[], [], [], []];
  private fuelPopulation: number[] = [];
  private tirePopulations: FourWheels<number[]> = [[], [], [], []];
  private exclusions = new Map<string, number>();
  constructor(identity: StintIdentity) {
    const unavailable = (unit: MetricRate["unit"]): MetricRate => ({ value: null, unit, eligibleLaps: 0, source: null, provisional: false, unavailableReason: "no-current-samples" });
    this.summary = { ...identity, status: "active", endedAt: null, firstLapNumber: null, lastLapNumber: null,
      boundary: { reason: "session-start", confidence: "unknown" }, completedLaps: 0,
      fuel: unavailable(identity.fuelUnit === "L" ? "L/lap" : "tankFraction/lap"),
      tires: [unavailable("wearFraction/lap"), unavailable("wearFraction/lap"), unavailable("wearFraction/lap"), unavailable("wearFraction/lap")],
      virtualEnergy: unavailable("energyFraction/lap"),
      measuredFuelUsed: null, fuelCoverage: "unavailable", averageLapSeconds: null, paceLaps: 0,
      rateStatistics: { fuel: statistics(this.fuelPopulation), tires: this.tirePopulations.map(statistics) as FourWheels<RateStatistics> },
      exclusions: [], algorithmVersion: STRATEGY_ALGORITHM_VERSION, revision: 0 };
  }
  snapshot(): StintSummary { return structuredClone(this.summary); }
  fork(): StintMetricAccumulator {
    const copy = Object.create(StintMetricAccumulator.prototype) as StintMetricAccumulator;
    copy.summary = structuredClone(this.summary);
    copy.sums = structuredClone(this.sums);
    copy.fuelSamples = [...this.fuelSamples];
    copy.tireSamples = this.tireSamples.map((samples) => [...samples]) as FourWheels<number[]>;
    copy.fuelPopulation = [...this.fuelPopulation];
    copy.tirePopulations = this.tirePopulations.map((samples) => [...samples]) as FourWheels<number[]>;
    copy.exclusions = new Map(this.exclusions);
    copy.energySamples = [...this.energySamples];
    return copy;
  }
  totals(): StrategyTotals { return structuredClone(this.sums); }
  close(reason: string, confidence: StintSummary["boundary"]["confidence"], endedAt: string, interrupted = false): StintSummary {
    this.summary.status = interrupted ? "interrupted" : "completed";
    this.summary.endedAt = endedAt;
    this.summary.boundary = { reason, confidence };
    this.summary.revision++;
    return this.snapshot();
  }
  rollingRates(): { fuel: MetricRate; tires: FourWheels<MetricRate>; virtualEnergy: MetricRate } {
    const rate = (samples: number[], metric: MetricRate): MetricRate => ({ ...metric, value: samples.length ? samples.reduce((sum, sample) => sum + sample, 0) / samples.length : null });
    return { fuel: rate(this.fuelSamples, this.summary.fuel), tires: [rate(this.tireSamples[0], this.summary.tires[0]), rate(this.tireSamples[1], this.summary.tires[1]), rate(this.tireSamples[2], this.summary.tires[2]), rate(this.tireSamples[3], this.summary.tires[3])], virtualEnergy: rate(this.energySamples, this.summary.virtualEnergy!) };
  }
  add(lapNumber: number, metrics: LapMetricContribution): StintSummary {
    this.summary.completedLaps++;
    this.summary.firstLapNumber ??= lapNumber;
    this.summary.lastLapNumber = lapNumber;
    const note = (reason: string | null) => { if (reason) this.exclusions.set(reason, (this.exclusions.get(reason) ?? 0) + 1); };
    if (metrics.fuelUsed != null) {
      this.sums.fuel += metrics.fuelUsed; this.sums.fuelCount++;
      this.fuelSamples.push(metrics.fuelUsed); if (this.fuelSamples.length > 5) this.fuelSamples.shift();
      insertSample(this.fuelPopulation, metrics.fuelUsed);
    }
    if (metrics.virtualEnergyUsed != null) {
      this.sums.virtualEnergy += metrics.virtualEnergyUsed; this.sums.virtualEnergyCount++;
      this.energySamples.push(metrics.virtualEnergyUsed); if (this.energySamples.length > 5) this.energySamples.shift();
    }
    if (metrics.measuredFuelUsed != null) { this.sums.measuredFuel += metrics.measuredFuelUsed; this.sums.measuredLaps++; }
    if (metrics.fuelCoverage === "complete") this.sums.completeFuelLaps++;
    const keys = ["tire0", "tire1", "tire2", "tire3"] as const;
    for (let wheel = 0; wheel < 4; wheel++) {
      const value = metrics.tireWear[wheel];
      if (value != null) {
        this.sums[keys[wheel]] += value; this.sums.tireCounts[wheel]++;
        this.tireSamples[wheel].push(value); if (this.tireSamples[wheel].length > 3) this.tireSamples[wheel].shift();
        insertSample(this.tirePopulations[wheel], value);
      }
      note(metrics.tireExcludedReasons[wheel]);
      const count = this.sums.tireCounts[wheel];
      this.summary.tires[wheel] = { value: count ? this.sums[keys[wheel]] / count : null, unit: "wearFraction/lap", eligibleLaps: count, source: count ? "current-stint" : null, provisional: false, unavailableReason: count ? null : metrics.tireExcludedReasons[wheel] ?? "no-current-samples" };
    }
    note(metrics.virtualEnergyExcludedReason ?? null);
    note(metrics.fuelExcludedReason); note(metrics.exclusionReason);
    if (metrics.lapTimeSeconds != null) { this.sums.pace += metrics.lapTimeSeconds; this.sums.paceCount++; }
    this.summary.fuel = { value: this.sums.fuelCount ? this.sums.fuel / this.sums.fuelCount : null, unit: this.summary.fuel.unit, eligibleLaps: this.sums.fuelCount, source: this.sums.fuelCount ? "current-stint" : null, provisional: false, unavailableReason: this.sums.fuelCount ? null : metrics.fuelExcludedReason ?? "no-current-samples" };
    this.summary.measuredFuelUsed = this.sums.measuredLaps ? this.sums.measuredFuel : null;
    this.summary.fuelCoverage = !this.sums.measuredLaps ? "unavailable" : this.sums.completeFuelLaps === this.summary.completedLaps ? "complete" : "partial";
    this.summary.virtualEnergy = { value: this.sums.virtualEnergyCount ? this.sums.virtualEnergy / this.sums.virtualEnergyCount : null, unit: "energyFraction/lap", eligibleLaps: this.sums.virtualEnergyCount, source: this.sums.virtualEnergyCount ? "current-stint" : null, provisional: false, unavailableReason: this.sums.virtualEnergyCount ? null : metrics.virtualEnergyExcludedReason ?? "no-current-samples" };
    this.summary.averageLapSeconds = this.sums.paceCount ? this.sums.pace / this.sums.paceCount : null;
    this.summary.paceLaps = this.sums.paceCount;
    this.summary.exclusions = [...this.exclusions].map(([reason, count]) => ({ reason, count }));
    this.summary.revision++;
    this.summary.rateStatistics = { fuel: statistics(this.fuelPopulation), tires: this.tirePopulations.map(statistics) as FourWheels<RateStatistics> };
    return this.snapshot();
  }
}
export function rebuildStintSummary(identity: StintIdentity, contributions: readonly { lapNumber: number; metrics: LapMetricContribution }[]): StintSummary {
  const accumulator = new StintMetricAccumulator(identity);
  for (const contribution of contributions) accumulator.add(contribution.lapNumber, contribution.metrics);
  return accumulator.snapshot();
}
