// @ts-ignore — Bun text import
import carsRaw from "./cars.csv" with { type: "text" };

// --- Car data ---

export interface CarInfo {
  year: number;
  make: string;
  model: string;
}

export const carMap = new Map<number, CarInfo>();
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

// --- Car specs ---

export interface CarSpecs {
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

export const carSpecsMap = new Map<number, CarSpecs>();

// Parse a CSV line respecting quoted fields
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { fields.push(current); current = ""; }
    else { current += ch; }
  }
  fields.push(current);
  return fields;
}

try {
  // @ts-ignore — Bun text import
  const { default: specsRaw } = await import("./car-specs.csv", { with: { type: "text" } });
  let firstLine = true;
  for (const line of specsRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || firstLine) { firstLine = false; continue; }
    const f = parseCsvLine(trimmed);
    const ordinal = parseInt(f[0], 10);
    if (isNaN(ordinal)) continue;
    carSpecsMap.set(ordinal, {
      hp:             parseInt(f[1]) || 0,
      torque:         parseInt(f[2]) || 0,
      weightLbs:      parseInt(f[3]) || 0,
      weightKg:       parseInt(f[4]) || 0,
      displacement:   parseFloat(f[5]) || 0,
      engine:         f[6] ?? "",
      drivetrain:     f[7] ?? "",
      gears:          parseInt(f[8]) || 0,
      aspiration:     f[9] ?? "",
      frontWeightPct: parseInt(f[10]) || 0,
      pi:             parseInt(f[11]) || 0,
      speedRating:    parseFloat(f[12]) || 0,
      brakingRating:  parseFloat(f[13]) || 0,
      handlingRating: parseFloat(f[14]) || 0,
      accelRating:    parseFloat(f[15]) || 0,
      price:          parseInt(f[16]) || 0,
      division:       f[17] ?? "",
      topSpeedMph:    parseFloat(f[18]) || 0,
      quarterMile:    parseFloat(f[19]) || 0,
      zeroToSixty:    parseFloat(f[20]) || 0,
      zeroToHundred:  parseFloat(f[21]) || 0,
      braking60:      parseFloat(f[22]) || 0,
      braking100:     parseFloat(f[23]) || 0,
      lateralG60:     parseFloat(f[24]) || 0,
      lateralG120:    parseFloat(f[25]) || 0,
      imageUrl:       f[26] ?? "",
      wikiUrl:        f[27] ?? "",
      synopsis:       f[28] ?? "",
    });
  }
} catch {
  // car-specs.csv not yet generated — run scripts/scrape-car-specs.ts
}

export function getCarSpecs(ordinal: number): CarSpecs | undefined {
  return carSpecsMap.get(ordinal);
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

// @ts-ignore — Bun text import
const { default: tracksRaw } = await import("./tracks.csv", { with: { type: "text" } });
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
