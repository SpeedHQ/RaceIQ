import type { RacePlanBaseline, RacePlanStintInput } from "@raceiq/shared/racing/live/race-plan";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { supportsRaceRefueling } from "./race-rules";

const wholeLaps = (value: number) => Math.floor(value + Number.EPSILON * Math.max(1, Math.abs(value)) * 4);
/** Minimum-stop proposal respecting the game's refueling rule and measured resource limits. */
export function generateRacePlanStints(source: StintSummary | RacePlanBaseline, totalLaps: number, capacity: number, reserve: number,
  thresholds: (compound: string) => TireThresholds, energyReserveFraction = 0): RacePlanStintInput[] | null {
  const fuel = source.fuel;
  const isLmu = source.gameId === "lmu";
  const supportsRefueling = supportsRaceRefueling(source.gameId);
  if (!Number.isInteger(totalLaps) || totalLaps < 1 || totalLaps > 10_000 ||
      !Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(reserve) || reserve < 0 || reserve >= capacity ||
      source.fuelUnit === "tankFraction" && capacity > 1 ||
      !Number.isFinite(energyReserveFraction) || energyReserveFraction < 0 || energyReserveFraction >= 1 ||
      fuel.value == null || !Number.isFinite(fuel.value) || fuel.value < 0 || fuel.eligibleLaps < 1 ||
      fuel.unit !== (source.fuelUnit === "L" ? "L/lap" : "tankFraction/lap")) return null;
  const initialFuelDemand = fuel.value * totalLaps + reserve;
  const fuelTolerance = Number.EPSILON * Math.max(1, Math.abs(initialFuelDemand), Math.abs(capacity)) * 4;
  if (!supportsRefueling && initialFuelDemand - capacity > fuelTolerance) return null;
  let stintLaps = fuel.value === 0 || !supportsRefueling ? totalLaps : Math.min(totalLaps, wholeLaps((capacity - reserve) / fuel.value));
  if (isLmu) {
    const energy = source.virtualEnergy;
    if (!energy || energy.value == null || !Number.isFinite(energy.value) || energy.value < 0 ||
        energy.unit !== "energyFraction/lap" || energy.eligibleLaps < 1) return null;
    if (energy.value > 0) stintLaps = Math.min(stintLaps, wholeLaps((1 - energyReserveFraction) / energy.value));
  }
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
  let cumulativeFuel = 0;
  for (let start = 0; start < totalLaps; start += stintLaps) {
    const endLap = Math.min(totalLaps, start + stintLaps);
    stints.push({ endLap, startFuel: supportsRefueling ? Math.min(capacity, (endLap - start) * fuel.value + reserve) : capacity - cumulativeFuel,
      compounds: [...source.compounds], sourceSessionId: "sessionId" in source ? source.sessionId : null,
      sourceStintId: "id" in source ? source.id : null,
      ...("sources" in source ? { sourceStints: source.sources.map(({ sessionId, id }) => ({ sessionId, stintId: id })) } : {}) });
    cumulativeFuel += (endLap - start) * fuel.value;
  }
  return stints;
}
