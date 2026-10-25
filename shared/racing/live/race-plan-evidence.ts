import type { RacePlanBaseline, RacePlanWeather, RacePlanWeatherCategory } from "./race-plan";
import type { MetricRate, StintSummary } from "./strategy";

export function classifyRacePlanWeather(value: string | null): RacePlanWeatherCategory {
  if (value === "dry" || value === "0" || value === "1" || value === "2") return "dry";
  if (value === "wet" || value === "3" || value === "4" || value === "5") return "wet";
  return "unknown";
}

function weightedRate(sources: readonly StintSummary[], select: (source: StintSummary) => MetricRate): MetricRate {
  let weight = 0;
  let total = 0;
  for (const source of sources) {
    const rate = select(source);
    if (rate.value === null || !Number.isFinite(rate.value) || rate.eligibleLaps < 1) continue;
    weight += rate.eligibleLaps;
    total += rate.value * rate.eligibleLaps;
  }
  const first = select(sources[0]!);
  return { ...first, value: weight ? total / weight : null, eligibleLaps: weight, source: weight ? "history" : null, provisional: false,
    unavailableReason: weight ? null : first.unavailableReason ?? "no-compatible-measurements" };
}

export function aggregateRacePlanEvidence(sources: readonly StintSummary[], requestedWeather: RacePlanWeather): RacePlanBaseline | null {
  const eligible = sources.filter((source) => {
    if (source.status === "active" || source.endedAt === null || source.compatibility.fuelSemanticVersion === null ||
        source.compatibility.tireSemanticVersions.some((version) => version === null) ||
        source.gameId === "lmu" && (source.compatibility.virtualEnergySemanticVersion == null || source.virtualEnergy == null ||
          source.virtualEnergy.value == null || source.virtualEnergy.value < 0 || source.virtualEnergy.eligibleLaps < 1 ||
          source.virtualEnergy.unit !== "energyFraction/lap") ||
        source.fuel.value === null || source.fuel.value < 0 || source.fuel.eligibleLaps < 1 ||
        source.fuel.unit !== (source.fuelUnit === "L" ? "L/lap" : "tankFraction/lap") ||
        source.tires.some((rate) => rate.value === null || rate.value < 0 || rate.eligibleLaps < 1 || rate.unit !== "wearFraction/lap") ||
        source.compounds.some((compound) => compound === null)) return false;
    const weather = classifyRacePlanWeather(source.compatibility.conditions.weather);
    return requestedWeather === "any" || weather === requestedWeather;
  });
  const newest = eligible[0];
  if (!newest) return null;
  const weather = classifyRacePlanWeather(newest.compatibility.conditions.weather);
  const compatible = eligible.filter((source) => source.gameId === newest.gameId && source.carId === newest.carId && source.trackId === newest.trackId &&
    source.pi === newest.pi && source.fuelUnit === newest.fuelUnit && JSON.stringify(source.compounds) === JSON.stringify(newest.compounds) &&
    source.compatibility.fuelSemanticVersion === newest.compatibility.fuelSemanticVersion &&
    JSON.stringify(source.compatibility.tireSemanticVersions) === JSON.stringify(newest.compatibility.tireSemanticVersions) &&
    source.compatibility.virtualEnergySemanticVersion === newest.compatibility.virtualEnergySemanticVersion &&
    source.compatibility.setupKey === newest.compatibility.setupKey &&
    classifyRacePlanWeather(source.compatibility.conditions.weather) === weather).slice(0, 100);
  const pace = compatible.filter((source) => source.averageLapSeconds !== null && source.paceLaps > 0);
  const paceLaps = pace.reduce((sum, source) => sum + source.paceLaps, 0);
  return {
    gameId: newest.gameId, carId: newest.carId, trackId: newest.trackId, pi: newest.pi, fuelUnit: newest.fuelUnit,
    compounds: [...newest.compounds], compatibility: newest.compatibility, fuel: weightedRate(compatible, (source) => source.fuel),
    tires: [0, 1, 2, 3].map((wheel) => weightedRate(compatible, (source) => source.tires[wheel]!)) as RacePlanBaseline["tires"],
    ...(newest.virtualEnergy === undefined ? {} : { virtualEnergy: weightedRate(compatible.filter((source) => source.virtualEnergy), (source) => source.virtualEnergy!) }),
    averageLapSeconds: paceLaps ? pace.reduce((sum, source) => sum + source.averageLapSeconds! * source.paceLaps, 0) / paceLaps : null,
    paceLaps, weather, sources: compatible,
  };
}
