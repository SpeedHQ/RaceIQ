#!/usr/bin/env bun
/**
 * Scrapes car specs from Forza Fandom Wiki (FM2023).
 * Step 1: Get all car page links from FM2023/Cars list
 * Step 2: Batch-fetch each car page (50/req, follow redirects)
 * Step 3: Parse CarInfobox + CarStats|fm23 + Synopsis
 * Step 4: Batch-fetch image URLs
 * Step 5: Join with cars.csv → shared/games/fm-2023/car-specs.csv
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = "https://forza.fandom.com/api.php";

const DIVISION_NAMES: Record<string, string> = {
  "488":    "488 Challenge Spec",
  "efr":    "Early Factory Racecars",
  "egtc":   "Exotic GT Classics",
  "elmp":   "Early LMP",
  "esc":    "Early Sport Compact",
  "f60":    "Formula 60s",
  "f70":    "Formula 70s",
  "fau":    "Forza AUS",
  "faufgt": "Forza AUS",
  "fd":     "Formula Drift",
  "fg2fgt": "Forza GT2",
  "fg3":    "Forza GT3",
  "fg3fgt": "Forza GT3",
  "fg4fgt": "Forza GT4",
  "fms":    "Formula Mazda Spec",
  "fp1":    "Forza P1",
  "fp2":    "Forza P2",
  "fph":    "Forza Proto-H",
  "fsp":    "Forza Specials",
  "ftafgt": "Forza T/A",
  "ftc":    "Forza Touring Cars",
  "g40":    "Ginetta G40 Junior Spec",
  "gpr":    "Grand Prix Rivals",
  "gtp":    "GTP/C",
  "gtx":    "GTX Sportscars",
  "hhi":    "Hot Hatch Icons",
  "megt":   "Modern Exotic GT",
  "mfr":    "Modern Factory Racecars",
  "mh":     "Modern Hypercars",
  "mhh":    "Modern Hot Hatch",
  "mrs":    "Mission R Spec",
  "mscm":   "Modern Sport Compact",
  "mscu":   "Modern Sport Coupe",
  "msgt":   "Modern Sport GT",
  "mst":    "Modern Sport Touring",
  "nas":    "NASCAR",
  "pgr":    "Prototype Group Racing",
  "sci":    "Sport Coupe Icons",
  "sdc":    "Street Drag Racers",
  "sgti":   "Sport GT Icons",
  "sl":     "Sport Luxury",
  "st":     "Super Trofeo",
  "stc":    "Sport Touring Classics",
  "tbogp":  "The Birth of Grand Prix",
  "tt":     "Track Toys",
  "vegt":   "Vintage Exotic GT",
  "vlmp":   "Vintage Le Mans Prototypes",
  "vlms":   "Vintage Le Mans Sportscars",
  "vm":     "Vintage Muscle",
  "vsc":    "Vintage Sport Compact",
  "vta":    "Vintage Trans Am",
};

// ─── Step 1: Scrape car page links from wikitext ──────────────────────────────
console.log("Step 1: Fetching car list...");
const listRes = await fetch(`${API}?action=parse&page=Forza_Motorsport_(2023)/Cars&prop=wikitext&format=json`);
const listData = await listRes.json() as any;
const wikitext: string = listData.parse.wikitext["*"];

const pageNames = new Set<string>();
for (const line of wikitext.split("\n")) {
  if (!line.includes("CarListStatsFM23")) continue;
  for (const m of line.matchAll(/\[\[([^\]|#]+)/g)) {
    const page = m[1].trim();
    if (page && !page.startsWith("Category:") && !page.startsWith("File:")) {
      pageNames.add(page);
    }
  }
}
const carPages = Array.from(pageNames);
console.log(`  Found ${carPages.length} car pages`);

// ─── Step 2 & 3: Batch-fetch pages, parse infoboxes ───────────────────────────
console.log("Step 2: Fetching individual car pages...");

interface WikiCar {
  pageName: string;
  year?: number;
  wikiMake?: string;
  wikiModel?: string;
  // CarInfobox fields
  hp?: number;
  torque?: number;
  weightLbs?: number;
  displacement?: number;
  engine?: string;
  drivetrain?: string;
  gears?: number;
  aspiration?: string;
  frontWeightPct?: number;
  imageFile?: string;
  directImageUrl?: string; // fallback from pageimages when imageFile is absent
  // CarStats|fm23 fields
  pi?: number;
  speedRating?: number;
  brakingRating?: number;
  handlingRating?: number;
  accelRating?: number;
  price?: number;
  division?: string;
  topSpeedMph?: number;
  quarterMile?: number;
  zeroToSixty?: number;
  zeroToHundred?: number;
  braking60?: number;
  braking100?: number;
  lateralG60?: number;
  lateralG120?: number;
  // Synopsis
  synopsis?: string;
}

function layoutToDrivetrain(layout: string): string {
  const l = layout.toLowerCase();
  if (["ff", "mf"].includes(l)) return "FWD";
  if (["ma", "fa", "4wd", "aa", "aw"].includes(l)) return "AWD";
  return "RWD";
}

// Parse positional args from a template call body
// e.g. "|fm23\n|4.7|6.7|..." → ["fm23","4.7","6.7",...]
function parsePositional(body: string): string[] {
  return body
    .split("|")
    .map(s => s.trim().replace(/\n/g, "").split("=")[0].trim())
    .filter(s => s && !s.includes("="));
}

function parsePage(content: string, pageName: string): WikiCar | null {
  const car: WikiCar = { pageName };

  // ── CarInfobox ──
  const infoboxMatch = content.match(/\{\{CarInfobox([\s\S]*?)\n\}\}/);
  if (infoboxMatch) {
    const body = infoboxMatch[1];
    function field(key: string): string | undefined {
      const m = body.match(new RegExp(`\\|\\s*${key}\\s*=\\s*([^\\n|{\\[]+)`));
      return m?.[1].trim() || undefined;
    }
    car.year = field("year") ? parseInt(field("year")!) : undefined;
    car.wikiMake = field("manufacturer");
    car.wikiModel = field("model");
    car.hp = field("power") ? parseInt(field("power")!) : undefined;
    car.torque = field("torque") ? parseInt(field("torque")!) : undefined;
    car.weightLbs = field("weight") ? parseInt(field("weight")!) : undefined;
    car.displacement = field("disp") ? parseFloat(field("disp")!) : undefined;
    car.engine = field("engine");
    car.drivetrain = layoutToDrivetrain((field("layout") ?? "fr").toLowerCase());
    car.gears = field("gears") ? parseInt(field("gears")!) : undefined;
    car.aspiration = field("aspiration");
    car.frontWeightPct = field("front") ? parseInt(field("front")!) : undefined;
    car.imageFile = field("image");
  }

  // ── CarStats|fm23 ──
  const statsMatch = content.match(/\{\{CarStats\|fm23([\s\S]*?)\}\}/);
  if (statsMatch) {
    const body = statsMatch[1];

    // Positional args: |speed|braking|handling|accel|PI
    const positional = body
      .split("\n")
      .join("|")
      .split("|")
      .map(s => s.trim())
      .filter(s => s && !s.includes("=") && /^[\d.]+$/.test(s));

    if (positional.length >= 5) {
      car.speedRating    = parseFloat(positional[0]);
      car.brakingRating  = parseFloat(positional[1]);
      car.handlingRating = parseFloat(positional[2]);
      car.accelRating    = parseFloat(positional[3]);
      car.pi             = parseInt(positional[4]);
    }

    // Named args
    function namedField(key: string): string | undefined {
      const m = body.match(new RegExp(`\\|\\s*${key}\\s*=\\s*([^\\n|]+)`));
      return m?.[1].trim().replace(/,/g, "") || undefined;
    }
    car.price         = namedField("price") ? parseInt(namedField("price")!) : undefined;
    car.division      = namedField("div");
    car.topSpeedMph   = namedField("ts")    ? parseFloat(namedField("ts")!)    : undefined;
    car.quarterMile   = namedField("mile")  ? parseFloat(namedField("mile")!)  : undefined;
    car.zeroToSixty   = namedField("a60")   ? parseFloat(namedField("a60")!)   : undefined;
    car.zeroToHundred = namedField("a100")  ? parseFloat(namedField("a100")!)  : undefined;
    car.braking60     = namedField("b60")   ? parseFloat(namedField("b60")!)   : undefined;
    car.braking100    = namedField("b100")  ? parseFloat(namedField("b100")!)  : undefined;
    car.lateralG60    = namedField("g60")   ? parseFloat(namedField("g60")!)   : undefined;
    car.lateralG120   = namedField("g120")  ? parseFloat(namedField("g120")!)  : undefined;
  }

  // ── Synopsis ──
  const synopsisMatch = content.match(/==Synopsis==\s*([\s\S]*?)(?:\n==|\{\{[A-Z])/);
  if (synopsisMatch) {
    // Strip wiki markup
    car.synopsis = synopsisMatch[1]
      .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2") // [[link|text]] → text
      .replace(/\{\{[^}]+\}\}/g, "")                  // remove templates
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")       // remove refs
      .replace(/'''([^']+)'''/g, "$1")                 // '''bold''' → bold
      .replace(/''([^']+)''/g, "$1")                   // ''italic'' → italic
      .replace(/\n+/g, " ")
      .trim()
      .slice(0, 500); // cap at 500 chars
  }

  if (!car.year && !car.hp && !car.pi) return null;
  return car;
}

const wikiCars: WikiCar[] = [];
const BATCH = 50;

for (let i = 0; i < carPages.length; i += BATCH) {
  const batch = carPages.slice(i, i + BATCH);
  const titlesParam = batch.map(p => encodeURIComponent(p)).join("|");
  const url = `${API}?action=query&prop=revisions|images|pageimages&rvprop=content&rvslots=main&imlimit=50&piprop=original&redirects=1&titles=${titlesParam}&format=json&formatversion=2`;

  process.stdout.write(`  Pages ${i + 1}–${Math.min(i + BATCH, carPages.length)} / ${carPages.length}...`);
  const res = await fetch(url);
  const data = await res.json() as any;

  let parsed = 0;
  for (const page of data.query.pages) {
    const content = page.revisions?.[0]?.slots?.main?.content ?? "";
    if (!content) continue;
    const car = parsePage(content, page.title);
    if (car) {
      // Clear invalid infobox image values (e.g. "<gallery>")
      if (car.imageFile?.startsWith("<")) car.imageFile = undefined;

      // Find best image from page images list: prefer FM23, then FH5, then FH4, then other game prefixes
      const pageImages: string[] = (page.images ?? []).map((img: any) => img.title.replace(/^File:/, ""));
      const fm23Img = pageImages.find(f => /^FM23[\s_]/i.test(f) && /\.(png|jpg|jpeg|webp)$/i.test(f));
      const fh5Img  = pageImages.find(f => /^FH5[\s_]/i.test(f)  && /\.(png|jpg|jpeg|webp)$/i.test(f));
      const fh4Img  = pageImages.find(f => /^FH4[\s_]/i.test(f)  && /\.(png|jpg|jpeg|webp)$/i.test(f));
      const anyGame = pageImages.find(f => /^F[HM]\d+[\s_]/i.test(f) && /\.(png|jpg|jpeg|webp)$/i.test(f));
      if (fm23Img) car.imageFile = fm23Img;
      else if (fh5Img) car.imageFile = fh5Img;
      else if (fh4Img) car.imageFile = fh4Img;
      else if (!car.imageFile && anyGame) car.imageFile = anyGame;
      // Always store pageimages URL as direct fallback (used if imageUrlMap lookup fails)
      if (page.original?.source) car.directImageUrl = page.original.source;
      wikiCars.push(car);
      parsed++;
    }
  }
  console.log(` ${parsed}/${batch.length} parsed (${wikiCars.length} total)`);

  if (i + BATCH < carPages.length) await Bun.sleep(300);
}

console.log(`\nStep 2 complete: ${wikiCars.length} / ${carPages.length} cars parsed`);

// ─── Step 3: HTML fallback for missing performance stats ──────────────────────
const missingPerf = wikiCars.filter(c => c.pi && c.pi > 0 && !c.topSpeedMph && !c.zeroToSixty);
console.log(`\nStep 3: Fetching HTML stats for ${missingPerf.length} cars missing performance data...`);

function parseHtmlStats(html: string, car: WikiCar) {
  const num = (pattern: RegExp) => { const m = html.match(pattern); return m ? parseFloat(m[1]) : undefined; };
  car.topSpeedMph   = num(/Top Speed:\s*([\d.]+)\s*mph/)           ?? car.topSpeedMph;
  car.quarterMile   = num(/1\/4 Mile:\s*([\d.]+)\s*secs/)          ?? car.quarterMile;
  car.zeroToSixty   = num(/0-60 mph[^:]*:\s*([\d.]+)\s*secs/)      ?? car.zeroToSixty;
  car.zeroToHundred = num(/0-100 mph[^:]*:\s*([\d.]+)\s*secs/)     ?? car.zeroToHundred;
  car.braking60     = num(/60-0 mph[^:]*:\s*([\d.]+)\s*ft/)        ?? car.braking60;
  car.braking100    = num(/100-0 mph[^:]*:\s*([\d.]+)\s*ft/)       ?? car.braking100;
  car.lateralG60    = num(/60 mph[^:]*:\s*([\d.]+)\s*g/)           ?? car.lateralG60;
  car.lateralG120   = num(/120 mph[^:]*:\s*([\d.]+)\s*g/)          ?? car.lateralG120;
}

let htmlFetched = 0;
const HTML_CONCURRENCY = 10;

async function fetchHtmlStats(car: WikiCar) {
  const url = `${API}?action=parse&page=${encodeURIComponent(car.pageName)}&prop=text&format=json`;
  try {
    const res = await fetch(url);
    const data = await res.json() as any;
    const html: string = data.parse?.text?.["*"] ?? "";
    const tableMatch = html.match(/<table[^>]*class="[^"]*fm23[^"]*"[^>]*>([\s\S]*?)<\/table>/);
    if (tableMatch) {
      const text = tableMatch[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
      parseHtmlStats(text, car);
      htmlFetched++;
    }
  } catch { /* skip */ }
}

for (let i = 0; i < missingPerf.length; i += HTML_CONCURRENCY) {
  await Promise.all(missingPerf.slice(i, i + HTML_CONCURRENCY).map(fetchHtmlStats));
  process.stdout.write(`\r  ${Math.min(i + HTML_CONCURRENCY, missingPerf.length)}/${missingPerf.length}`);
}
console.log(`\n  Filled stats for ${htmlFetched} / ${missingPerf.length} cars`);

// ─── Step 4: Resolve image URLs ───────────────────────────────────────────────
console.log("\nStep 4: Resolving image URLs...");
const imageFiles = [...new Set(wikiCars.map(c => c.imageFile).filter(Boolean) as string[])];
const imageUrlMap = new Map<string, string>();

for (let i = 0; i < imageFiles.length; i += BATCH) {
  const batch = imageFiles.slice(i, i + BATCH);
  const titlesParam = batch.map(f => encodeURIComponent(`File:${f}`)).join("|");
  const url = `${API}?action=query&titles=${titlesParam}&prop=imageinfo&iiprop=url&format=json`;

  process.stdout.write(`  Images ${i + 1}–${Math.min(i + BATCH, imageFiles.length)} / ${imageFiles.length}...`);
  const res = await fetch(url);
  const data = await res.json() as any;

  let resolved = 0;
  for (const page of Object.values(data.query.pages) as any[]) {
    const imageUrl = page.imageinfo?.[0]?.url;
    const title: string = page.title?.replace(/^File:/, "");
    if (imageUrl && title) { imageUrlMap.set(title, imageUrl); resolved++; }
  }
  console.log(` ${resolved} resolved`);

  if (i + BATCH < imageFiles.length) await Bun.sleep(300);
}

// ─── Step 5: Join with cars.csv ───────────────────────────────────────────────
console.log("\nStep 5: Matching to cars.csv...");
const carsRaw = readFileSync(resolve(__dirname, "../shared/games/fm-2023/cars.csv"), "utf-8");

interface OurCar { ordinal: number; year: number; make: string; model: string; }
const ourCars: OurCar[] = [];
for (const line of carsRaw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const [ordStr, yearStr, make, ...modelParts] = trimmed.split(",");
  const ordinal = parseInt(ordStr, 10);
  const year = parseInt(yearStr, 10);
  const model = modelParts.join(",");
  if (!isNaN(ordinal) && !isNaN(year) && make) ourCars.push({ ordinal, year, make, model });
}

function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/mercedes-benz/g, "mercedes")
    .replace(/mercedes-amg/g, "mercedes")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/#\s*\d+\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const wikiByYear = new Map<number, WikiCar[]>();
for (const wc of wikiCars) {
  if (!wc.year) continue;
  if (!wikiByYear.has(wc.year)) wikiByYear.set(wc.year, []);
  wikiByYear.get(wc.year)!.push(wc);
}

function wordOverlap(rawA: string, rawB: string): number {
  // Tokenize on word boundaries BEFORE full normalization
  const tokens = (s: string) => new Set(
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .map(w => w.replace(/^#+/, ""))
      .filter(w => w.length >= 3)
  );
  const ta = tokens(rawA), tb = tokens(rawB);
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size === 0) return 0;
  let hits = 0;
  for (const t of small) if (large.has(t)) hits++;
  return hits / small.size;
}

function score(our: OurCar, wiki: WikiCar): number {
  if (our.year !== wiki.year) return 0;
  const ourRaw = `${our.make} ${our.model}`;
  const ourFull = normalize(ourRaw);
  const wikiRaws = [
    `${wiki.wikiMake ?? ""} ${wiki.wikiModel ?? ""}`,
    wiki.pageName,
  ];
  for (let i = 0; i < wikiRaws.length; i++) {
    const wikiStr = normalize(wikiRaws[i]);
    if (!wikiStr) continue;
    if (ourFull === wikiStr) return 4;
    if (ourFull.includes(wikiStr) || wikiStr.includes(ourFull)) return 3;
    const [s, l] = ourFull.length < wikiStr.length ? [ourFull, wikiStr] : [wikiStr, ourFull];
    if (s.length >= 6 && l.includes(s)) return 2;
    // Word-overlap fallback for racing cars with team names in page title
    if (wordOverlap(ourRaw, wikiRaws[i]) >= 0.8) return 1;
  }
  return 0;
}

const rows: any[] = [];
const unmatched: string[] = [];

for (const our of ourCars) {
  const candidates = wikiByYear.get(our.year) ?? [];
  let best: WikiCar | null = null;
  let bestScore = 0;
  for (const wiki of candidates) {
    const s = score(our, wiki);
    if (s > bestScore) { bestScore = s; best = wiki; }
  }

  if (best && bestScore > 0) {
    rows.push({
      ordinal: our.ordinal,
      // Car specs
      hp:              best.hp ?? 0,
      torque:          best.torque ?? 0,
      weightLbs:       best.weightLbs ?? 0,
      weightKg:        Math.round((best.weightLbs ?? 0) * 0.453592),
      displacement:    best.displacement ?? 0,
      engine:          best.engine ?? "",
      drivetrain:      best.drivetrain ?? "",
      gears:           best.gears ?? 0,
      aspiration:      best.aspiration ?? "",
      frontWeightPct:  best.frontWeightPct ?? 0,
      // FM23 performance stats
      pi:              best.pi ?? 0,
      speedRating:     best.speedRating ?? 0,
      brakingRating:   best.brakingRating ?? 0,
      handlingRating:  best.handlingRating ?? 0,
      accelRating:     best.accelRating ?? 0,
      price:           best.price ?? 0,
      division:        DIVISION_NAMES[best.division ?? ""] ?? best.division ?? "",
      topSpeedMph:     best.topSpeedMph ?? 0,
      quarterMile:     best.quarterMile ?? 0,
      zeroToSixty:     best.zeroToSixty ?? 0,
      zeroToHundred:   best.zeroToHundred ?? 0,
      braking60:       best.braking60 ?? 0,
      braking100:      best.braking100 ?? 0,
      lateralG60:      best.lateralG60 ?? 0,
      lateralG120:     best.lateralG120 ?? 0,
      // Image & synopsis (imageUrl filled in during download step)
      cdnImageUrl: best.imageFile ? (imageUrlMap.get(best.imageFile.replace(/ /g, "_")) ?? best.directImageUrl ?? "") : (best.directImageUrl ?? ""),
      wikiUrl:   best.pageName ? `https://forza.fandom.com/wiki/${best.pageName.replace(/ /g, "_")}` : "",
      synopsis:  (best.synopsis ?? "").replace(/"/g, "'"),
    });
  } else {
    unmatched.push(`${our.year} ${our.make} ${our.model} (ordinal ${our.ordinal})`);
  }
}

console.log(`  Matched: ${rows.length} / ${ourCars.length} (unmatched: ${unmatched.length})`);
for (const u of unmatched) console.log(`    ${u}`);

// ─── Step 6: Download images locally ──────────────────────────────────────────
console.log("\nStep 6: Downloading car images...");
const imgDir = resolve(__dirname, "../client/public/car-images");
mkdirSync(imgDir, { recursive: true });

const CONCURRENCY = 10;
let downloaded = 0, skipped = 0, failed = 0;

async function downloadImage(row: any) {
  const cdnUrl: string = row.cdnImageUrl;
  if (!cdnUrl) { row.imageUrl = ""; return; }
  const ext = cdnUrl.match(/\.(png|jpg|jpeg|webp)/i)?.[1] ?? "png";
  const localFile = resolve(imgDir, `${row.ordinal}.${ext}`);
  row.imageUrl = `/car-images/${row.ordinal}.${ext}`;
  if (existsSync(localFile)) { skipped++; return; }
  try {
    const res = await fetch(cdnUrl);
    if (!res.ok) { failed++; row.imageUrl = ""; return; }
    const buf = await res.arrayBuffer();
    writeFileSync(localFile, Buffer.from(buf));
    downloaded++;
  } catch { failed++; row.imageUrl = ""; }
}

for (let i = 0; i < rows.length; i += CONCURRENCY) {
  await Promise.all(rows.slice(i, i + CONCURRENCY).map(downloadImage));
  process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} (${downloaded} new, ${skipped} cached, ${failed} failed)`);
}
console.log(`\n  Done.`);

// ─── Write CSV ────────────────────────────────────────────────────────────────
const header = "ordinal,hp,torque,weightLbs,weightKg,displacement,engine,drivetrain,gears,aspiration,frontWeightPct,pi,speedRating,brakingRating,handlingRating,accelRating,price,division,topSpeedMph,quarterMile,zeroToSixty,zeroToHundred,braking60,braking100,lateralG60,lateralG120,imageUrl,wikiUrl,synopsis";
const lines = rows.map(r =>
  [
    r.ordinal, r.hp, r.torque, r.weightLbs, r.weightKg, r.displacement,
    `"${r.engine}"`, r.drivetrain, r.gears, r.aspiration, r.frontWeightPct,
    r.pi, r.speedRating, r.brakingRating, r.handlingRating, r.accelRating,
    r.price, `"${r.division}"`, r.topSpeedMph, r.quarterMile,
    r.zeroToSixty, r.zeroToHundred, r.braking60, r.braking100,
    r.lateralG60, r.lateralG120,
    `"${r.imageUrl}"`, `"${r.wikiUrl}"`, `"${r.synopsis}"`
  ].join(",")
);
const outPath = resolve(__dirname, "../shared/games/fm-2023/car-specs.csv");
writeFileSync(outPath, [header, ...lines].join("\n") + "\n");
console.log(`\nWritten: shared/games/fm-2023/car-specs.csv (${rows.length} rows)`);
