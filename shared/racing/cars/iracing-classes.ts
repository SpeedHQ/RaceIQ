import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@shared/core/csv";
import { GAMES_DIR } from "@shared/platform/runtime/data-paths";

export interface IRacingCarClass {
  id: number;
  name: string;
  shortName: string;
  relativeSpeed: number;
  rainEnabled: boolean;
  /** Many-to-many membership. Session CarClassID selects actual context. */
  carIds: number[];
}

const carClasses = readFileSync(
  resolve(GAMES_DIR, "iracing/car-classes.csv"),
  "utf-8",
)
  .split(/\r?\n/)
  .slice(1)
  .map((line): IRacingCarClass | null => {
    if (!line.trim()) return null;
    const fields = parseCsvLine(line);
    const id = Number(fields[0]);
    const relativeSpeed = Number(fields[3]);
    const name = fields[1]?.trim();
    const shortName = fields[2]?.trim();
    if (
      !Number.isInteger(id) ||
      !name ||
      !shortName ||
      !Number.isFinite(relativeSpeed)
    ) {
      return null;
    }
    return {
      id,
      name,
      shortName,
      relativeSpeed,
      rainEnabled: fields[4] === "true",
      carIds: (fields[5] ?? "")
        .split("|")
        .filter(Boolean)
        .map(Number)
        .filter(Number.isInteger),
    };
  })
  .filter((carClass): carClass is IRacingCarClass => carClass !== null);

const carClassesById = new Map(
  carClasses.map((carClass) => [carClass.id, carClass]),
);

export function getAllIRacingCarClasses(): IRacingCarClass[] {
  return carClasses;
}

export function getIRacingCarClass(id: number): IRacingCarClass | undefined {
  return carClassesById.get(id);
}

export function getIRacingCarClassName(id: number): string | undefined {
  return getIRacingCarClass(id)?.shortName;
}
