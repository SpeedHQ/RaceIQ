import { loadKunosCarCatalog, type KunosCar, type KunosCarCatalog } from "@raceiq/shared/racing/cars/kunos-catalog";

export const DISCOVERED_CAR_ORDINAL_BASE = 100000;

let catalog: KunosCarCatalog | undefined;
const discoveredById = new Map<number, KunosCar>();
const discoveredBySource = new Map<string, KunosCar>();

function getCatalog(): KunosCarCatalog {
  catalog ??= loadKunosCarCatalog("ac-evo");
  return catalog;
}

export function injectDiscoveredAcEvoCars(cars: { ordinal: number; name: string; model?: string }[]): void {
  for (const car of cars) {
    const entry = { id: car.ordinal, model: car.model ?? "", name: car.name, class: "Discovered" };
    discoveredById.set(car.ordinal, entry);
    discoveredBySource.set(car.name.trim().normalize("NFC").toLowerCase(), entry);
  }
}

export function getAcEvoCarName(ordinal: number): string {
  if (ordinal < 0) return "Unknown Car";
  return discoveredById.get(ordinal)?.name ?? getCatalog().byId.get(ordinal)?.name ?? `Car #${ordinal}`;
}

export function getAcEvoCarByModel(model: string): KunosCar | undefined {
  return getCatalog().byModel.get(model);
}

export function getAcEvoCarByDisplayName(displayName: string): KunosCar | undefined {
  const needle = displayName.trim().normalize("NFC").toLowerCase();
  if (!needle) return undefined;
  const discovered = discoveredBySource.get(needle);
  if (discovered) return discovered;
  for (const car of getCatalog().byId.values()) {
    if (car.name.trim().normalize("NFC").toLowerCase() === needle) return car;
  }
  return undefined;
}

export function getAcEvoCarClass(ordinal: number): string | undefined {
  return discoveredById.get(ordinal)?.class ?? getCatalog().byId.get(ordinal)?.class;
}

export function getAllAcEvoCars(): KunosCar[] {
  const carsByOrdinal = new Map(getCatalog().byId);
  for (const [ordinal, car] of discoveredById) carsByOrdinal.set(ordinal, car);
  return [...carsByOrdinal.values()];
}
