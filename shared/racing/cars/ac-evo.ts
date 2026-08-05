import { loadKunosCarCatalog, type KunosCar, type KunosCarCatalog } from "./kunos-catalog";

/** Runtime-only ordinals live above every bundled CSV id. */
export const DISCOVERED_CAR_ORDINAL_BASE = 100000;

let catalog: KunosCarCatalog | undefined;
const discoveredById = new Map<number, KunosCar>();

function getCatalog(): KunosCarCatalog {
  catalog ??= loadKunosCarCatalog("ac-evo");
  return catalog;
}

/** Overlay DB-discovered cars without changing bundled roster iteration. */
export function injectDiscoveredAcEvoCars(cars: { ordinal: number; name: string; model?: string }[]): void {
  for (const car of cars) {
    discoveredById.set(car.ordinal, {
      id: car.ordinal,
      model: car.model ?? "",
      name: car.name,
      class: "Discovered",
    });
  }
}

export function getAcEvoCarName(ordinal: number): string {
  if (ordinal < 0) return "Unknown Car";
  return getCatalog().byId.get(ordinal)?.name
    ?? discoveredById.get(ordinal)?.name
    ?? `Car #${ordinal}`;
}

export function getAcEvoCarByModel(model: string): KunosCar | undefined {
  return getCatalog().byModel.get(model);
}

export function getAcEvoCarByDisplayName(displayName: string): KunosCar | undefined {
  const cars = getCatalog().byId.values();
  const needle = displayName.toLowerCase().trim();
  for (const car of cars) {
    if (car.name.toLowerCase() === needle) return car;
  }

  const normalizedNeedle = needle.replace(/[-_\s]/g, "");
  if (!normalizedNeedle) return undefined;
  for (const car of getCatalog().byId.values()) {
    if (
      car.name.toLowerCase().replace(/[-_\s]/g, "") === normalizedNeedle
      || car.model.toLowerCase().replace(/[-_\s]/g, "") === normalizedNeedle
    ) {
      return car;
    }
  }
  return undefined;
}

export function getAcEvoCarClass(ordinal: number): string | undefined {
  return getCatalog().byId.get(ordinal)?.class ?? discoveredById.get(ordinal)?.class;
}

export function getAllAcEvoCars(): KunosCar[] {
  return Array.from(getCatalog().byId.values());
}
