import type { SemanticLapTelemetry } from "../hooks/laps";

export interface LapOverviewStats {
  wear: readonly (number | null)[];
  temperatures: readonly { id: string; min: number | null; max: number | null }[];
  deployed: number | null;
  recovered: number | null;
  topSpeed: number | null;
  startingFuel: number | null;
  fuelUsed: number | null;
}


const TEMPERATURE_IDS = [
  "tire.temperature.surface.representative",
  "tire.temperature.core",
  "tire.temperature.carcass.representative",
  "tire.temperature.surface.inner",
  "tire.temperature.surface.middle",
  "tire.temperature.surface.outer",
  "tire.temperature.carcass.left",
  "tire.temperature.carcass.middle",
  "tire.temperature.carcass.right",
  "brakes.brake-temp",
] as const;
const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const wheelValue = (value: unknown, index: number): unknown => Array.isArray(value)
  ? value[index]
  : value && typeof value === "object" ? (value as Record<string, unknown>)[WHEELS[index]!] : undefined;

/** Single pass over native samples; never sum held readings or spread dense recordings. */
export function summarizeLapOverview(replay: SemanticLapTelemetry | undefined): LapOverviewStats {
  const temperatures = TEMPERATURE_IDS.map((id) => ({ id, min: null as number | null, max: null as number | null }));
  const temperatureById = new Map<string, typeof temperatures[number]>(temperatures.map((entry) => [entry.id, entry]));
  const wear = WHEELS.map(() => ({ first: null as number | null, last: null as number | null, count: 0, reset: false }));
  const counters = new Map<string, number | null>(["fuel.ers-deployed", "fuel.ers-harvested"].map((id) => [id, null]));
  let startingFuel: number | null = null;
  let lastFuel: number | null = null;
  let fuelReadings = 0;
  let fuelIncreased = false;
  let topSpeed: number | null = null;
  for (const frame of replay?.envelopes ?? []) {
    for (const entry of frame.values) {
      if ((entry.state != null && entry.state !== "ok") || (entry.freshness != null && entry.freshness !== "fresh")) continue;
      const { semanticId: id, value } = entry;
      if (id === "motion.speed" && finite(value) && value >= 0) topSpeed = Math.max(topSpeed ?? value, value);
      // Native ERS counters already mean "this lap"; resets and corrections
      // are legitimate. The final valid reading is authoritative.
      if (counters.has(id) && finite(value) && value >= 0) counters.set(id, value);
      if (id === "tires.tire-wear") {
        for (let index = 0; index < 4; index++) {
          const current = wheelValue(value, index), wheel = wear[index]!;
          if (!finite(current) || current < 0 || current > 1) continue;
          if (wheel.last !== null && current < wheel.last) wheel.reset = true;
          wheel.first ??= current;
          wheel.last = current;
          wheel.count++;
        }
      }
      if (id === "fuel.fuel" && finite(value) && value >= 0) {
        if (lastFuel !== null && value > lastFuel) fuelIncreased = true;
        startingFuel ??= value;
        lastFuel = value;
        fuelReadings++;
      }
      const temperature = temperatureById.get(id);
      if (temperature) {
        for (let index = 0; index < 4; index++) {
          const current = wheelValue(value, index);
          if (!finite(current)) continue;
          temperature.min = Math.min(temperature.min ?? current, current);
          temperature.max = Math.max(temperature.max ?? current, current);
        }
      }
    }
  }
  return {
    wear: wear.map((wheel) => wheel.count < 2 || wheel.reset ? null : wheel.last! - wheel.first!),
    temperatures,
    deployed: counters.get("fuel.ers-deployed") ?? null,
    recovered: counters.get("fuel.ers-harvested") ?? null,
    topSpeed,
    startingFuel,
    fuelUsed: fuelReadings >= 2 && !fuelIncreased ? startingFuel! - lastFuel! : null,
  };
}
