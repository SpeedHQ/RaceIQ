import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_SOURCE = "https://raw.githubusercontent.com/jasondilworth56/iracingdataapi/main/tests/mock_return_data/get_cars.json";
const DEFAULT_OUTPUT = resolve(import.meta.dir, "../shared/games/iracing/cars.csv");

interface IRacingDataApiCar {
  car_id?: unknown;
  car_name?: unknown;
  car_dirpath?: unknown;
  categories?: unknown;
  folder?: unknown;
  small_image?: unknown;
  retired?: unknown;
}

interface SeedCar {
  ordinal: number;
  name: string;
  path: string;
  category: string;
  imageUrl: string;
  retired: boolean;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function imageUrl(folder: string, image: string): string {
  const normalizedFolder = folder.trim().replace(/\/+$/, "");
  const normalizedImage = image.trim().replace(/^\/+/, "");
  const slash = normalizedFolder.startsWith("/") ? "" : "/";
  return `https://images-static.iracing.com${slash}${normalizedFolder}/${normalizedImage}`;
}

async function readSource(source: string): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { "User-Agent": "RaceIQ iRacing car catalog seed" },
    });
    if (!response.ok) {
      throw new Error(`Could not download ${source}: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Seed source does not exist: ${sourcePath}`);
  }
  return JSON.parse(readFileSync(sourcePath, "utf-8"));
}

function parseCars(payload: unknown, includeRetired: boolean): SeedCar[] {
  if (!Array.isArray(payload)) {
    throw new Error("Expected an array from the iRacing /data/car/get response");
  }

  const cars = payload.map((value, index): SeedCar => {
    const row = value as IRacingDataApiCar;
    if (
      !Number.isInteger(row.car_id) ||
      typeof row.car_name !== "string" ||
      !row.car_name.trim() ||
      typeof row.car_dirpath !== "string" ||
      !row.car_dirpath.trim() ||
      !Array.isArray(row.categories) ||
      row.categories.length !== 1 ||
      typeof row.categories[0] !== "string" ||
      !row.categories[0].trim() ||
      typeof row.folder !== "string" ||
      !row.folder.trim() ||
      typeof row.small_image !== "string" ||
      !row.small_image.trim() ||
      typeof row.retired !== "boolean"
    ) {
      throw new Error(
        `Invalid /data/car/get row at index ${index}: expected car_id, car_name, car_dirpath, one category, folder, small_image, and retired`,
      );
    }
    return {
      ordinal: row.car_id as number,
      name: row.car_name.trim(),
      path: `cars\\${row.car_dirpath.replaceAll("/", "\\")}`,
      category: row.categories[0].trim(),
      imageUrl: imageUrl(row.folder, row.small_image),
      retired: row.retired,
    };
  });

  const filtered = includeRetired ? cars : cars.filter((car) => !car.retired);
  const ids = new Set<number>();
  const paths = new Set<string>();
  for (const car of filtered) {
    const normalizedPath = car.path.toLocaleLowerCase();
    if (ids.has(car.ordinal)) {
      throw new Error(`Duplicate iRacing car ID ${car.ordinal}`);
    }
    if (paths.has(normalizedPath)) {
      throw new Error(`Duplicate iRacing car path ${car.path}`);
    }
    ids.add(car.ordinal);
    paths.add(normalizedPath);
  }

  return filtered.sort((a, b) => a.ordinal - b.ordinal);
}

function writeCatalog(output: string, cars: SeedCar[]): void {
  const lines = [
    "ordinal,name,path,category,imageUrl",
    ...cars.map((car) =>
      [
        csvCell(car.ordinal),
        csvCell(car.name),
        csvCell(car.path),
        csvCell(car.category),
        csvCell(car.imageUrl),
      ].join(","),
    ),
  ];
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${lines.join("\n")}\n`, "utf-8");
}

const source = optionValue("--source") ?? DEFAULT_SOURCE;
const output = resolve(optionValue("--output") ?? DEFAULT_OUTPUT);
const includeRetired = process.argv.includes("--include-retired");
const cars = parseCars(await readSource(source), includeRetired);
writeCatalog(output, cars);

console.log(`[iRacing Cars] Seeded ${cars.length} ${includeRetired ? "total" : "non-retired"} cars to ${output}`);
console.log(`[iRacing Cars] Source: ${source}`);
