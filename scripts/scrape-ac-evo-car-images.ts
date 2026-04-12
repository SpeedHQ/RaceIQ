#!/usr/bin/env bun
/**
 * Scrapes car images for AC Evo from Wikipedia.
 *
 * For each car in shared/games/ac-evo/cars.csv it fetches the Wikipedia
 * page summary (which includes originalimage URL) and downloads it as
 * client/public/car-images/ac-evo-{id}.jpg
 *
 * Usage:
 *   bun scripts/scrape-ac-evo-car-images.ts
 *   bun scripts/scrape-ac-evo-car-images.ts --dry-run   # print URLs, no download
 *   bun scripts/scrape-ac-evo-car-images.ts --id 50     # single car by id
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "client/public/car-images");
const CARS_CSV = resolve(ROOT, "shared/games/ac-evo/cars.csv");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SINGLE_ID = (() => {
  const idx = args.indexOf("--id");
  return idx !== -1 ? parseInt(args[idx + 1], 10) : null;
})();

const WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const HEADERS = { "User-Agent": "RaceIQ-scraper/1.0 (github.com/SpeedHQ/RaceIQ)" };

// Manual overrides for cars whose names don't match Wikipedia article titles
const WIKI_OVERRIDES: Record<string, string> = {
  "Lamborghini Huracan EVO":       "Lamborghini_Huracán",
  "Lamborghini Huracan STO":       "Lamborghini_Huracán",
  "Lamborghini Huracan GT3 EVO2":  "Lamborghini_Huracán_GT3_Evo",
  "Lamborghini Revuelto":          "Lamborghini_Revuelto",
  "BMW M4 GT3":                    "BMW_M4_GT3",
  "BMW M4 Competition":            "BMW_M4",
  "BMW M4 CSL":                    "BMW_M4_CSL",
  "Mercedes-AMG GT3 2024":         "Mercedes-AMG_GT3",
  "Audi R8 LMS EVO II":            "Audi_R8_LMS",
  "Honda NSX GT3 Evo":             "Honda_NSX_(NC1)",
  "McLaren 720S GT3 EVO":          "McLaren_720S",
  "Porsche 992 GT3 R":             "Porsche_992",
  "Alfa Romeo Giulia GTA":         "Alfa_Romeo_Giulia",
  "Abarth 695":                    "Abarth_695",
  "Lotus Emira V6":                "Lotus_Emira",
};

// ── CSV parsing ──────────────────────────────────────────────────────────────

interface CarEntry {
  id: number;
  model: string;
  name: string;
  class: string;
}

function loadCars(): CarEntry[] {
  const text = readFileSync(CARS_CSV, "utf8");
  return text
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const parts = line.split(",");
      const id = parseInt(parts[0], 10);
      const model = parts[1].trim();
      const cls = parts[parts.length - 1].trim();
      const name = parts.slice(2, parts.length - 1).join(",").trim();
      return { id, model, name, class: cls };
    });
}

// ── Wikipedia ────────────────────────────────────────────────────────────────

interface WikiSummary {
  title: string;
  thumbnail?: { source: string };
  originalimage?: { source: string };
}

async function fetchWikiSummary(title: string): Promise<WikiSummary | null> {
  const url = WIKI_SUMMARY + encodeURIComponent(title);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  return res.json() as Promise<WikiSummary>;
}

function wikiTitle(car: CarEntry): string {
  if (WIKI_OVERRIDES[car.name]) return WIKI_OVERRIDES[car.name];
  return car.name.replace(/ /g, "_");
}

// ── Download ─────────────────────────────────────────────────────────────────

async function downloadAsJpeg(imageUrl: string, destPath: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(imageUrl, { headers: HEADERS });
    if (res.status === 429) {
      const wait = attempt * 3000;
      console.log(`  rate limited, waiting ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    writeFileSync(destPath, Buffer.from(buf));
    return;
  }
  throw new Error("gave up after 4 attempts (rate limited)");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function processOne(car: CarEntry): Promise<void> {
  const outPath = resolve(OUT_DIR, `ac-evo-${car.id}.jpg`);

  if (!DRY_RUN && existsSync(outPath)) {
    console.log(`[skip]  ${car.name} (already exists)`);
    return;
  }

  const title = wikiTitle(car);
  console.log(`[fetch] ${car.name} (id=${car.id}) → Wikipedia:${title}`);

  const summary = await fetchWikiSummary(title);
  if (!summary) {
    console.warn(`  ✗ not found on Wikipedia`);
    return;
  }

  const imageUrl = summary.originalimage?.source ?? summary.thumbnail?.source;
  if (!imageUrl) {
    console.warn(`  ✗ no image on Wikipedia page "${summary.title}"`);
    return;
  }

  console.log(`  url: ${imageUrl}`);

  if (DRY_RUN) {
    console.log(`  [dry-run] → ${outPath}`);
    return;
  }

  await downloadAsJpeg(imageUrl, outPath);
  console.log(`  ✓ saved`);
}

async function main() {
  if (!DRY_RUN) mkdirSync(OUT_DIR, { recursive: true });

  const cars = loadCars();
  const targets = SINGLE_ID !== null ? cars.filter((c) => c.id === SINGLE_ID) : cars;

  if (targets.length === 0) {
    console.error(`No car found with id=${SINGLE_ID}`);
    process.exit(1);
  }

  for (const car of targets) {
    try {
      await processOne(car);
    } catch (err) {
      console.error(`  ✗ error for ${car.name}:`, err);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }

  console.log("\nDone.");
}

main();
