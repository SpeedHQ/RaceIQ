import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_OUTPUT = resolve(import.meta.dir, "../../shared/games/iracing/car-classes.csv");

interface IRacingDataApiCarClass {
  car_class_id?: unknown;
  cars_in_class?: unknown;
  name?: unknown;
  short_name?: unknown;
  relative_speed?: unknown;
  rain_enabled?: unknown;
}
interface IRacingDataApiCarInClass { car_id?: unknown }
interface SeedCarClass {
  id: number;
  name: string;
  shortName: string;
  relativeSpeed: number;
  rainEnabled: boolean;
  carIds: number[];
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function readSource(source: string): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { "User-Agent": "RaceIQ iRacing car class seed" } });
    if (!response.ok) throw new Error(`Could not download ${source}: ${response.status} ${response.statusText}`);
    return response.json();
  }
  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) throw new Error(`Seed source does not exist: ${sourcePath}`);
  return JSON.parse(readFileSync(sourcePath, "utf-8"));
}
function parseCarClasses(payload: unknown): SeedCarClass[] {
  if (!Array.isArray(payload)) throw new Error("Expected an array from the iRacing /data/carclass/get response");
  const classes = payload.map((value, index): SeedCarClass => {
    const row = value as IRacingDataApiCarClass;
    if (!Number.isInteger(row.car_class_id) || typeof row.name !== "string" || !row.name.trim() || typeof row.short_name !== "string" || !row.short_name.trim() || typeof row.relative_speed !== "number" || !Number.isFinite(row.relative_speed) || typeof row.rain_enabled !== "boolean" || !Array.isArray(row.cars_in_class)) {
      throw new Error(`Invalid /data/carclass/get row at index ${index}`);
    }
    const carIds = row.cars_in_class.map((value, carIndex) => {
      const member = value as IRacingDataApiCarInClass;
      if (!Number.isInteger(member.car_id)) throw new Error(`Invalid car membership at class index ${index}, car index ${carIndex}`);
      return member.car_id as number;
    });
    return {
      id: row.car_class_id as number,
      name: row.name.trim(),
      shortName: row.short_name.trim(),
      relativeSpeed: row.relative_speed,
      rainEnabled: row.rain_enabled,
      carIds: [...new Set(carIds)].sort((a, b) => a - b),
    };
  });
  const ids = new Set<number>();
  for (const carClass of classes) {
    if (ids.has(carClass.id)) throw new Error(`Duplicate iRacing car class ID ${carClass.id}`);
    ids.add(carClass.id);
  }
  return classes.sort((a, b) => a.id - b.id);
}
function writeCatalog(output: string, classes: SeedCarClass[]): void {
  const lines = [
    "id,name,shortName,relativeSpeed,rainEnabled,carIds",
    ...classes.map((carClass) => [carClass.id, carClass.name, carClass.shortName, carClass.relativeSpeed, carClass.rainEnabled, carClass.carIds.join("|")].map(csvCell).join(",")),
  ];
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${lines.join("\n")}\n`, "utf-8");
}
const source = optionValue("--source");
if (!source) throw new Error("Missing --source for an exported iRacing /data/carclass/get JSON file");
const output = resolve(optionValue("--output") ?? DEFAULT_OUTPUT);
const classes = parseCarClasses(await readSource(source));
writeCatalog(output, classes);
console.log(`[iRacing Car Classes] Seeded ${classes.length} classes to ${output}`);
console.log(`[iRacing Car Classes] Source: ${source}`);
