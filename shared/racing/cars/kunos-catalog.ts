import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@shared/core/csv";
import { GAMES_DIR } from "@shared/platform/runtime/data-paths";

export interface KunosCar {
  id: number;
  model: string;
  name: string;
  class: string;
}

export interface KunosCarCatalog {
  byId: Map<number, KunosCar>;
  byModel: Map<string, KunosCar>;
}

/** Load a four-column Kunos car catalog: id, model, display name, class. */
export function loadKunosCarCatalog(gameId: "acc" | "ac-evo"): KunosCarCatalog {
  const byId = new Map<number, KunosCar>();
  const byModel = new Map<string, KunosCar>();
  const raw = readFileSync(resolve(GAMES_DIR, gameId, "cars.csv"), "utf-8");

  for (const line of raw.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 4) continue;
    const id = Number.parseInt(fields[0], 10);
    if (!Number.isInteger(id)) continue;
    const car: KunosCar = {
      id,
      model: fields[1]?.trim() ?? "",
      name: fields.slice(2, -1).join(",").trim(),
      class: fields.at(-1)?.trim() ?? "",
    };
    byId.set(id, car);
    byModel.set(car.model, car);
  }

  return { byId, byModel };
}
