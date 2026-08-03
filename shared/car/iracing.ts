import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "../catalog/csv";
import { SHARED_DIR } from "../runtime/data-paths";

export interface IRacingCatalogCar {
  ordinal: number;
  name: string;
  path: string;
  category: string;
  imageUrl: string;
}

const cars = readFileSync(resolve(SHARED_DIR, "games/iracing/cars.csv"), "utf-8")
  .split(/\r?\n/)
  .slice(1)
  .map((line): IRacingCatalogCar | null => {
    if (!line.trim()) return null;
    const fields = parseCsvLine(line);
    const ordinal = Number(fields[0]);
    const name = fields[1]?.trim();
    const path = fields[2]?.trim();
    const category = fields[3]?.trim();
    const imageUrl = fields[4]?.trim();
    return Number.isInteger(ordinal) && name && path && category && imageUrl
      ? { ordinal, name, path, category, imageUrl }
      : null;
  })
  .filter((car): car is IRacingCatalogCar => car !== null);

export function getAllIRacingCars(): IRacingCatalogCar[] {
  return cars;
}
