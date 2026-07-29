import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHARED_DIR } from "./resolve-data";

export interface IRacingCatalogCar {
  ordinal: number;
  name: string;
  path: string;
  category: string;
  imageUrl: string;
}

/**
 * Minimal offline snapshot generated from an iRacing /data/car/get response.
 * See scripts/seed-iracing-cars.ts for the public seed and local export paths.
 *
 * The bundled catalog includes every row where the Data API reports
 * `retired: false`; legacy content remains present when iRacing still marks it
 * active.
 */
const cars = readFileSync(resolve(SHARED_DIR, "games/iracing/cars.csv"), "utf-8")
  .split(/\r?\n/)
  .slice(1)
  .map((line): IRacingCatalogCar | null => {
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        fields.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    fields.push(field);

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
