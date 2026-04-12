import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AcEvoCar {
  id: number;
  model: string;
  name: string;
  class: string;
}

let carMap: Map<number, AcEvoCar> | null = null;
let modelMap: Map<string, AcEvoCar> | null = null;

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
  ensureLoaded();
  const car = carMap!.get(ordinal);
  return car ? car.name : `Car #${ordinal}`;
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

export function getAcEvoCarClass(ordinal: number): string | undefined {
  ensureLoaded();
  return carMap!.get(ordinal)?.class;
}

export function getAllAcEvoCars(): AcEvoCar[] {
  ensureLoaded();
  return Array.from(carMap!.values());
}
