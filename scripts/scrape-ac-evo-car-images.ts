#!/usr/bin/env bun
/**
 * Scrapes car images for AC Evo from the Assetto Corsa Evo wiki (fandom).
 *
 * For each car in shared/games/ac-evo/cars.csv it:
 *   1. Searches the wiki for the car's page
 *   2. Pulls the first high-res image from the page's infobox
 *   3. Downloads it as client/public/car-images/ac-evo-{id}.jpg
 *
 * Usage:
 *   bun scripts/scrape-ac-evo-car-images.ts
 *   bun scripts/scrape-ac-evo-car-images.ts --dry-run   # print URLs, no download
 *   bun scripts/scrape-ac-evo-car-images.ts --id 50     # single car by id
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "client/public/car-images");
const CARS_CSV = resolve(ROOT, "shared/games/ac-evo/cars.csv");

const WIKI_API = "https://assettocorsaevo.fandom.com/api.php";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SINGLE_ID = (() => {
  const idx = args.indexOf("--id");
  return idx !== -1 ? parseInt(args[idx + 1], 10) : null;
})();

// ── CSV parsing ──────────────────────────────────────────────────────────────

interface CarEntry {
  id: number;
  model: string;
  name: string;
  class: string;
}

function loadCars(): CarEntry[] {
  const text = Bun.file(CARS_CSV).toString();
  return text
    .trim()
    .split("\n")
    .slice(1) // skip header
    .map((line) => {
      const [id, model, ...rest] = line.split(",");
      // name may contain commas (e.g. "Mercedes-AMG GT3 2024")
      const lastField = rest.pop()!.trim();
      const name = rest.join(",").trim();
      return { id: parseInt(id, 10), model: model.trim(), name, class: lastField };
    });
}

// ── Wiki helpers ─────────────────────────────────────────────────────────────

async function searchPage(carName: string): Promise<string | null> {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", carName);
  url.searchParams.set("srlimit", "3");
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString(), { headers: { "User-Agent": "RaceIQ-scraper/1.0" } });
  const json = (await res.json()) as any;
  const results: any[] = json?.query?.search ?? [];
  if (results.length === 0) return null;
  return results[0].title as string;
}

async function getPageImages(title: string): Promise<string[]> {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("titles", title);
  url.searchParams.set("prop", "images");
  url.searchParams.set("imlimit", "20");
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString(), { headers: { "User-Agent": "RaceIQ-scraper/1.0" } });
  const json = (await res.json()) as any;
  const pages = Object.values(json?.query?.pages ?? {}) as any[];
  if (!pages.length) return [];
  return (pages[0].images ?? []).map((i: any) => i.title as string);
}

async function getImageUrl(fileTitle: string): Promise<string | null> {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("titles", fileTitle);
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url");
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString(), { headers: { "User-Agent": "RaceIQ-scraper/1.0" } });
  const json = (await res.json()) as any;
  const pages = Object.values(json?.query?.pages ?? {}) as any[];
  if (!pages.length) return null;
  return pages[0]?.imageinfo?.[0]?.url ?? null;
}

/** Pick the best image from a page's image list.
 *  Prefers images whose filename contains the car name words or "car", avoids icons/logos. */
function pickBestImage(images: string[], carName: string): string | null {
  const carWords = carName.toLowerCase().split(/\s+/);

  const scored = images.map((title) => {
    const lower = title.toLowerCase();
    // Skip small icons, logos, flags
    if (/icon|logo|flag|badge|symbol|wiki|favicon/i.test(lower)) return { title, score: -1 };
    // Skip SVG / gif
    if (/\.(svg|gif)$/i.test(lower)) return { title, score: -1 };

    let score = 0;
    for (const word of carWords) {
      if (lower.includes(word)) score += 2;
    }
    if (/\.(jpg|jpeg|png|webp)$/i.test(lower)) score += 1;
    if (/front|side|photo|render/i.test(lower)) score += 1;
    return { title, score };
  });

  const valid = scored.filter((s) => s.score >= 0).sort((a, b) => b.score - a.score);
  return valid[0]?.title ?? null;
}

// ── Download ─────────────────────────────────────────────────────────────────

async function downloadImage(imageUrl: string, destPath: string): Promise<void> {
  const res = await fetch(imageUrl, { headers: { "User-Agent": "RaceIQ-scraper/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${imageUrl}`);
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function processOne(car: CarEntry): Promise<void> {
  const outPath = resolve(OUT_DIR, `ac-evo-${car.id}.jpg`);

  if (!DRY_RUN && existsSync(outPath)) {
    console.log(`[skip]  ${car.name} (already exists)`);
    return;
  }

  console.log(`[fetch] ${car.name} (id=${car.id})`);

  const pageTitle = await searchPage(car.name);
  if (!pageTitle) {
    console.warn(`  ✗ no wiki page found for "${car.name}"`);
    return;
  }
  console.log(`  page: ${pageTitle}`);

  const images = await getPageImages(pageTitle);
  if (!images.length) {
    console.warn(`  ✗ no images on page`);
    return;
  }

  const chosen = pickBestImage(images, car.name);
  if (!chosen) {
    console.warn(`  ✗ no suitable image found (${images.length} candidates)`);
    return;
  }
  console.log(`  image: ${chosen}`);

  const imageUrl = await getImageUrl(chosen);
  if (!imageUrl) {
    console.warn(`  ✗ could not resolve image URL`);
    return;
  }
  console.log(`  url: ${imageUrl}`);

  if (DRY_RUN) {
    console.log(`  [dry-run] would save to ${outPath}`);
    return;
  }

  await downloadImage(imageUrl, outPath);
  console.log(`  ✓ saved ${outPath}`);
}

async function main() {
  if (!DRY_RUN) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

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
    // Polite delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\nDone.");
}

main();
