import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AcEvoCar {
  id: number;
  model: string;
  name: string;
  class: string;
}

/**
 * Generated ordinals for cars discovered at runtime (not in cars.csv) start
 * here — far above any CSV id so the two ranges can never collide.
 */
export const DISCOVERED_CAR_ORDINAL_BASE = 100000;

let carMap: Map<number, AcEvoCar> | null = null;
let modelMap: Map<string, AcEvoCar> | null = null;

// Runtime-discovered cars (from the discovered_cars table). Kept separate
// from the CSV maps so getAllAcEvoCars()/CSV reload semantics stay unchanged.
const discoveredById = new Map<number, AcEvoCar>();

/**
 * Register runtime-discovered cars (server-side, from discovered_cars rows)
 * so name/class lookups resolve for cars that aren't in cars.csv yet.
 */
export function injectDiscoveredAcEvoCars(
  cars: { ordinal: number; name: string; model?: string }[],
): void {
  for (const c of cars) {
    discoveredById.set(c.ordinal, {
      id: c.ordinal,
      model: c.model ?? "",
      name: c.name,
      class: "Discovered",
    });
  }
}

function ensureLoaded(): void {
  if (carMap) return;
  carMap = new Map();
  modelMap = new Map();
  const csv = readFileSync(resolve(SHARED_DIR, "games/ac-evo/cars.csv"), "utf-8");
  const lines = csv.trim().split("\n").slice(1); // skip header
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: id,model,name,class (comma-separated)
    const parts = trimmed.split(",");
    if (parts.length < 4) continue;
    const id = parseInt(parts[0], 10);
    const model = parts[1].trim();
    // Name may contain commas, so rejoin middle parts
    const carClass = parts[parts.length - 1].trim();
    const name = parts.slice(2, parts.length - 1).join(",").trim();
    if (!isNaN(id)) {
      const car: AcEvoCar = { id, model, name, class: carClass };
      carMap.set(id, car);
      modelMap!.set(model, car);
    }
  }
}

export function getAcEvoCarName(ordinal: number): string {
  if (ordinal < 0) return "Unknown Car"; // -1 sentinel: car never identified
  ensureLoaded();
  return carMap!.get(ordinal)?.name ?? discoveredById.get(ordinal)?.name ?? `Car #${ordinal}`;
}

export function getAcEvoCarNameByModel(model: string): string {
  ensureLoaded();
  const car = modelMap!.get(model);
  return car ? car.name : model;
}

export function getAcEvoCarByModel(model: string): AcEvoCar | undefined {
  ensureLoaded();
  return modelMap!.get(model);
}

/**
 * Find a car by its shared memory display name (e.g. "Porsche 911 GT3 Cup (992)").
 * Returns undefined when the car isn't in cars.csv — callers should default the
 * ordinal and emit a warning so the CSV can be updated.
 */
export function getAcEvoCarByDisplayName(displayName: string): AcEvoCar | undefined {
  ensureLoaded();
  const needle = displayName.toLowerCase().trim();
  for (const car of carMap!.values()) {
    if (car.name.toLowerCase() === needle) return car;
  }
  // Fallback: normalized compare (strip spaces/hyphens/underscores) against
  // both display name and model slug — the shm string sometimes arrives as
  // the model slug ("lotus_exige_v6_cup") rather than the display name.
  const normNeedle = needle.replace(/[-_\s]/g, "");
  if (!normNeedle) return undefined;
  for (const car of carMap!.values()) {
    if (
      car.name.toLowerCase().replace(/[-_\s]/g, "") === normNeedle ||
      car.model.toLowerCase().replace(/[-_\s]/g, "") === normNeedle
    ) {
      return car;
    }
  }
  return undefined;
}

export function getAcEvoCarClass(ordinal: number): string | undefined {
  ensureLoaded();
  return carMap!.get(ordinal)?.class ?? discoveredById.get(ordinal)?.class;
}

export function getAllAcEvoCars(): AcEvoCar[] {
  ensureLoaded();
  return Array.from(carMap!.values());
}
