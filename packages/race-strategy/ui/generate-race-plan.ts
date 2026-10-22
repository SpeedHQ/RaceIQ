import type { RacePlanStintInput } from "@raceiq/shared/racing/live/race-plan";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";

const wholeLaps = (value: number) => Math.floor(value + Number.EPSILON * Math.max(1, Math.abs(value)) * 4);
/** Minimum-stop proposal for constant measured rates, fresh tires and refueling at each stop. */
export function generateRacePlanStints(source: StintSummary, totalLaps: number, capacity: number, reserve: number,
  thresholds: (compound: string) => TireThresholds): RacePlanStintInput[] | null {
  const fuel = source.fuel;
  if (!Number.isInteger(totalLaps) || totalLaps < 1 || totalLaps > 10_000 ||
      !Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(reserve) || reserve < 0 || reserve >= capacity ||
      source.fuelUnit === "tankFraction" && capacity > 1 ||
      fuel.value == null || !Number.isFinite(fuel.value) || fuel.value < 0 || fuel.eligibleLaps < 1 ||
      fuel.unit !== (source.fuelUnit === "L" ? "L/lap" : "tankFraction/lap")) return null;
  let stintLaps = fuel.value === 0 ? totalLaps : Math.min(totalLaps, wholeLaps((capacity - reserve) / fuel.value));
  for (let wheel = 0; wheel < 4; wheel++) {
    const rate = source.tires[wheel]!;
    const compound = source.compounds[wheel];
    if (rate.value == null || !Number.isFinite(rate.value) || rate.value < 0 || rate.eligibleLaps < 1 ||
        rate.unit !== "wearFraction/lap" || compound == null) return null;
    const { cliffPct } = thresholds(compound);
    if (!Number.isFinite(cliffPct) || cliffPct < 0 || cliffPct >= 100) return null;
    if (rate.value > 0) stintLaps = Math.min(stintLaps, wholeLaps((1 - cliffPct / 100) / rate.value));
  }
  if (stintLaps < 1 || Math.ceil(totalLaps / stintLaps) > 100) return null;
  const stints: RacePlanStintInput[] = [];
  for (let start = 0; start < totalLaps; start += stintLaps) {
    const endLap = Math.min(totalLaps, start + stintLaps);
    stints.push({ endLap, startFuel: Math.min(capacity, (endLap - start) * fuel.value + reserve),
      compounds: [...source.compounds], sourceSessionId: source.sessionId, sourceStintId: source.id });
  }
  return stints;
}
