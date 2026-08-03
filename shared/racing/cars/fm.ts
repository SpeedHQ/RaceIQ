import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@shared/core/csv";
import { GAMES_DIR } from "@shared/platform/runtime/data-paths";

export interface FmCarInfo {
  year: number;
  make: string;
  model: string;
}

export interface FmCarSpecs {
  hp: number;
  torque: number;
  weightLbs: number;
  weightKg: number;
  displacement: number;
  engine: string;
  drivetrain: string;
  gears: number;
  aspiration: string;
  frontWeightPct: number;
  pi: number;
  speedRating: number;
  brakingRating: number;
  handlingRating: number;
  accelRating: number;
  price: number;
  division: string;
  topSpeedMph: number;
  quarterMile: number;
  zeroToSixty: number;
  zeroToHundred: number;
  braking60: number;
  braking100: number;
  lateralG60: number;
  lateralG120: number;
  imageUrl: string;
  wikiUrl: string;
  synopsis: string;
}

export const fmCarCatalog = new Map<number, FmCarInfo>();
export const fmCarSpecsCatalog = new Map<number, FmCarSpecs>();

const carsRaw = readFileSync(resolve(GAMES_DIR, "fm-2023/cars.csv"), "utf-8");
for (const line of carsRaw.split(/\r?\n/)) {
  const fields = parseCsvLine(line.trim());
  const ordinal = Number.parseInt(fields[0], 10);
  const year = Number.parseInt(fields[1], 10);
  if (!Number.isInteger(ordinal) || !Number.isInteger(year) || !fields[2]) continue;
  fmCarCatalog.set(ordinal, {
    year,
    make: fields[2],
    model: fields.slice(3).join(","),
  });
}

try {
  const specsRaw = readFileSync(resolve(GAMES_DIR, "fm-2023/car-specs.csv"), "utf-8");
  for (const line of specsRaw.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const ordinal = Number.parseInt(fields[0], 10);
    if (!Number.isInteger(ordinal)) continue;
    fmCarSpecsCatalog.set(ordinal, {
      hp: Number.parseInt(fields[1]) || 0,
      torque: Number.parseInt(fields[2]) || 0,
      weightLbs: Number.parseInt(fields[3]) || 0,
      weightKg: Number.parseInt(fields[4]) || 0,
      displacement: Number.parseFloat(fields[5]) || 0,
      engine: fields[6] ?? "",
      drivetrain: fields[7] ?? "",
      gears: Number.parseInt(fields[8]) || 0,
      aspiration: fields[9] ?? "",
      frontWeightPct: Number.parseInt(fields[10]) || 0,
      pi: Number.parseInt(fields[11]) || 0,
      speedRating: Number.parseFloat(fields[12]) || 0,
      brakingRating: Number.parseFloat(fields[13]) || 0,
      handlingRating: Number.parseFloat(fields[14]) || 0,
      accelRating: Number.parseFloat(fields[15]) || 0,
      price: Number.parseInt(fields[16]) || 0,
      division: fields[17] ?? "",
      topSpeedMph: Number.parseFloat(fields[18]) || 0,
      quarterMile: Number.parseFloat(fields[19]) || 0,
      zeroToSixty: Number.parseFloat(fields[20]) || 0,
      zeroToHundred: Number.parseFloat(fields[21]) || 0,
      braking60: Number.parseFloat(fields[22]) || 0,
      braking100: Number.parseFloat(fields[23]) || 0,
      lateralG60: Number.parseFloat(fields[24]) || 0,
      lateralG120: Number.parseFloat(fields[25]) || 0,
      imageUrl: fields[26] ?? "",
      wikiUrl: fields[27] ?? "",
      synopsis: fields[28] ?? "",
    });
  }
} catch {
  // Optional generated file; catalog remains usable without it.
}

export function getFmCarName(ordinal: number): string {
  const car = fmCarCatalog.get(ordinal);
  return car ? `${car.year} ${car.make} ${car.model}` : `Car #${ordinal}`;
}

export function getFmCarSpecs(ordinal: number): FmCarSpecs | undefined {
  return fmCarSpecsCatalog.get(ordinal);
}
