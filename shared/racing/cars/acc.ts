import { loadKunosCarCatalog, type KunosCar, type KunosCarCatalog } from "./kunos-catalog";

let catalog: KunosCarCatalog | undefined;

function getCatalog(): KunosCarCatalog {
  return catalog ??= loadKunosCarCatalog("acc");
}

export function getAccCarName(ordinal: number): string {
  return getCatalog().byId.get(ordinal)?.name ?? `Car #${ordinal}`;
}

export function getAccCarByModel(model: string): KunosCar | undefined {
  return getCatalog().byModel.get(model);
}

export function getAccCarClass(ordinal: number): string | undefined {
  return getCatalog().byId.get(ordinal)?.class;
}

export function getAllAccCars(): KunosCar[] {
  return Array.from(getCatalog().byId.values());
}
