import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@shared/core/csv";
import { GAMES_DIR } from "@shared/platform/runtime/data-paths";

export interface IRacingCatalogCar {
  ordinal: number;
  name: string;
  path: string;
  category: string;
  imageUrl: string;
  shortName: string;
  hp: number;
  weightLb: number;
  hasHeadlights: boolean;
  rainEnabled: boolean;
  hasMultipleDryTireTypes: boolean;
  searchTerms: string;
}

const cars = readFileSync(resolve(GAMES_DIR, "iracing/cars.csv"), "utf-8")
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
    const shortName = fields[5]?.trim();
    const hp = Number(fields[6]);
    const weightLb = Number(fields[7]);
    const hasHeadlights = fields[8] === "true";
    const rainEnabled = fields[9] === "true";
    const hasMultipleDryTireTypes = fields[10] === "true";
    const searchTerms = fields[11]?.trim() ?? "";
    return Number.isInteger(ordinal) &&
      name &&
      path &&
      category &&
      imageUrl &&
      shortName &&
      Number.isFinite(hp) &&
      Number.isFinite(weightLb)
      ? {
          ordinal,
          name,
          path,
          category,
          imageUrl,
          shortName,
          hp,
          weightLb,
          hasHeadlights,
          rainEnabled,
          hasMultipleDryTireTypes,
          searchTerms,
        }
      : null;
  })
  .filter((car): car is IRacingCatalogCar => car !== null);

export function getAllIRacingCars(): IRacingCatalogCar[] {
  return cars;
}
