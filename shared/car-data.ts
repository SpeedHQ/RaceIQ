import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Car data ---

export interface CarInfo {
  year: number;
  make: string;
  model: string;
}

export const carMap = new Map<number, CarInfo>();

const carsPath = resolve(__dirname, "cars.csv");
const carsRaw = readFileSync(carsPath, "utf-8");
for (const line of carsRaw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const [ordStr, yearStr, make, ...modelParts] = trimmed.split(",");
  const ordinal = parseInt(ordStr, 10);
  const year = parseInt(yearStr, 10);
  const model = modelParts.join(","); // handle commas in model names
  if (!isNaN(ordinal) && !isNaN(year) && make) {
    carMap.set(ordinal, { year, make, model });
  }
}

export function getCarName(ordinal: number): string {
  const car = carMap.get(ordinal);
  if (!car) return `Car #${ordinal}`;
  return `${car.year} ${car.make} ${car.model}`;
}

// --- Track data ---

export interface TrackInfo {
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
}

export const trackMap = new Map<number, TrackInfo>();

const tracksPath = resolve(__dirname, "tracks.csv");
const tracksRaw = readFileSync(tracksPath, "utf-8");
for (const line of tracksRaw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const [ordStr, name, location, country, variant, lengthStr] = trimmed.split(",");
  const ordinal = parseInt(ordStr, 10);
  const lengthKm = parseFloat(lengthStr);
  if (!isNaN(ordinal) && name) {
    trackMap.set(ordinal, { name, location, country, variant, lengthKm: isNaN(lengthKm) ? 0 : lengthKm });
  }
}

export function getTrackName(ordinal: number): string {
  const track = trackMap.get(ordinal);
  if (!track) return `Track #${ordinal}`;
  return `${track.name} - ${track.variant}`;
}
