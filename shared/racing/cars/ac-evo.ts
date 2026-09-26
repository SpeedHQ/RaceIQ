import { loadKunosCarCatalog, type KunosCar, type KunosCarCatalog } from "./kunos-catalog";


let catalog: KunosCarCatalog | undefined;

function getCatalog(): KunosCarCatalog {
  catalog ??= loadKunosCarCatalog("ac-evo");
  return catalog;
}


export function getAcEvoCarName(ordinal: number): string {
  if (ordinal < 0) return "Unknown Car";
  return getCatalog().byId.get(ordinal)?.name ?? `Car #${ordinal}`;
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
  return getCatalog().byId.get(ordinal)?.class;
}

export function getAllAcEvoCars(): KunosCar[] {
  return Array.from(getCatalog().byId.values());
}
