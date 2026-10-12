import { loadKunosCarCatalog, type KunosCar, type KunosCarCatalog } from "@raceiq/shared/racing/cars/kunos-catalog";

export type AcEvoCar = Omit<KunosCar, "id"> & { id: string };

let catalog: KunosCarCatalog | undefined;
const discoveredById = new Map<string, AcEvoCar>();
const discoveredBySource = new Map<string, AcEvoCar>();

function getCatalog(): KunosCarCatalog {
  catalog ??= loadKunosCarCatalog("ac-evo");
  return catalog;
}

export function injectDiscoveredAcEvoCars(cars: { id: string; name: string; model?: string }[]): void {
  for (const car of cars) {
    const entry = { id: car.id, model: car.model ?? "", name: car.name, class: "Discovered" };
    discoveredById.set(car.id, entry);
    discoveredBySource.set(car.name.trim().normalize("NFC").toLowerCase(), entry);
  }
}

export function getAcEvoCarName(id: string): string {
  return discoveredById.get(id)?.name ?? getAcEvoCarByDisplayName(id)?.name ?? id;
}

export function getAcEvoCarByModel(model: string): AcEvoCar | undefined {
  const car = getCatalog().byModel.get(model);
  if (car) return { ...car, id: car.name.trim() };
  for (const entry of discoveredById.values()) {
    if (entry.model === model) return entry;
  }
  return undefined;
}

export function getAcEvoCarByDisplayName(displayName: string): AcEvoCar | undefined {
  const needle = displayName.trim().normalize("NFC").toLowerCase();
  if (!needle) return undefined;
  const discovered = discoveredBySource.get(needle);
  if (discovered) return discovered;
  for (const car of getCatalog().byId.values()) {
    if (car.name.trim().normalize("NFC").toLowerCase() === needle) {
      return { ...car, id: displayName.trim() };
    }
  }
  return undefined;
}

export function getAcEvoCarClass(id: string): string | undefined {
  return discoveredById.get(id)?.class ?? getAcEvoCarByDisplayName(id)?.class;
}

export function getAllAcEvoCars(): AcEvoCar[] {
  const carsById = new Map<string, AcEvoCar>();
  for (const car of getCatalog().byId.values()) {
    const id = car.name.trim();
    carsById.set(id, { ...car, id });
  }
  for (const [id, car] of discoveredById) carsById.set(id, car);
  return [...carsById.values()];
}
