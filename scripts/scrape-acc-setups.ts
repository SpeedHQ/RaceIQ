/**
 * Scrapes accsetups.com for ACC setup metadata.
 * Outputs to shared/data/tunes/acc/accsetups-com/{track}/{car}.json
 *
 * Usage: bun run scripts/scrape-acc-setups.ts
 */
import * as cheerio from "cheerio";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";


const BASE = "https://accsetups.com";
const MAX_PER_CAR_TRACK = 10;
const DELAY_MS = 400;
const SOURCE_SLUG = "accsetups-com";

interface ScrapedSetup {
  name: string;
  carModel: string;
  carClass: string;
  trackName: string;
  downloadUrl: string;
  videoUrl: string;
  pageUrl: string;
  author: string;
  lapTime: string;
  date: string;
  hasRace: boolean;
  hasQuali: boolean;
  hasSafe: boolean;
  hasWet: boolean;
}

async function pooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const next = async (): Promise<void> => { while (i < items.length) { const item = items[i++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

/** Convert "10 months ago", "1 year ago", "2 years ago" etc. → ISO date string (approximate) */
function relativeToDate(text: string): string {
  const now = new Date();
  const m = text.trim().match(/^(\d+)\s+(day|week|month|year)s?\s+ago$/i);
  if (!m) return "";
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  const d = new Date(now);
  if (unit === "day") d.setDate(d.getDate() - n);
  else if (unit === "week") d.setDate(d.getDate() - n * 7);
  else if (unit === "month") d.setMonth(d.getMonth() - n);
  else if (unit === "year") d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 7); // "YYYY-MM"
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RaceIQ-SetupScraper/1.0",
    },
  });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

async function getCarUrls(): Promise<{ slug: string; name: string }[]> {
  const html = await fetchPage(BASE);
  const $ = cheerio.load(html);
  const cars: { slug: string; name: string }[] = [];
  const seen = new Set<string>();
  $('a[href*="/games/assetto-corsa-competizione/cars/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const match = href.match(/\/cars\/([\w-]+)\/?$/);
    if (!match) return;
    const slug = match[1];
    if (seen.has(slug)) return;
    seen.add(slug);
    const title = $(el).attr("title") || "";
    const name = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
    cars.push({ slug, name: name || slug });
  });
  return cars;
}

async function scrapeCarSetups(carSlug: string, carName: string): Promise<ScrapedSetup[]> {
  const url = `${BASE}/games/assetto-corsa-competizione/cars/${carSlug}/`;
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const setups: ScrapedSetup[] = [];

  // Walk all children of the setup list container to track date group headlines
  let currentDate = "";
  $(".setup-list__row--item, .dividing-headline").each((_, el) => {
    const $el = $(el);
    if ($el.hasClass("dividing-headline")) {
      currentDate = relativeToDate($el.text().trim());
      return;
    }
    const $row = $el;
    const trackName = $row.find(".setup-list__track a").text().trim();
    const carClass = $row.find(".setup-list__class").text().trim();
    const author = $row.find(".setup-list__author a").text().trim();
    const lapTime = $row.find(".setup-list__time").text().replace(/[^\d:.]/g, "").trim();
    const downloadHref = $row.find("a.setup-list__download").attr("href") || "";
    const downloadUrl = downloadHref.startsWith("http") ? downloadHref : downloadHref ? `${BASE}${downloadHref}` : "";
    const videoHref = $row.find("a.setup-list__hotlap-icon").attr("href") || "";
    const videoUrl = videoHref.startsWith("http") ? videoHref : videoHref ? `${BASE}${videoHref}` : "";
    const pagePath = $row.find("a.setup-list__link").attr("href") || "";
    const pageUrl = pagePath ? `${BASE}${pagePath}` : "";
    const hasRace = $row.find(".setup-list__variants__race svg").length > 0;
    const hasQuali = $row.find(".setup-list__variants__quali svg").length > 0;
    const hasSafe = $row.find(".setup-list__variants__safe svg").length > 0;
    const hasWet = $row.find(".setup-list__variants__wet svg").length > 0;
    if (trackName) {
      setups.push({ name: `${carName} ${trackName}`, carModel: carSlug, carClass, trackName, downloadUrl, videoUrl, pageUrl, author, lapTime, date: currentDate, hasRace, hasQuali, hasSafe, hasWet });
    }
  });
  return setups;
}

function slugify(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").replace(/^-+/, "");
}

const DOWNLOAD_HOSTS = ["drive.google.com", "docs.google.com", "onedrive.live.com", "1drv.ms", "dropbox.com", "mega.nz", "mega.co.nz"];

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
  } catch {}
  return null;
}

function findDownloadLink(description: string): string {
  const links = description.match(/https?:\/\/[^\s]+/g) ?? [];
  for (const link of links) {
    try {
      const host = new URL(link).hostname;
      if (DOWNLOAD_HOSTS.some(h => host.includes(h))) return link;
    } catch {}
  }
  return "";
}

async function fetchYouTubeMeta(videoId: string): Promise<{ uploadDate: string; downloadUrl: string }> {
  const html = await fetchPage(`https://www.youtube.com/watch?v=${videoId}`);

  const dateM = html.match(/"uploadDate":"([^"]+)"/);
  const uploadDate = dateM ? dateM[1].slice(0, 10) : "";

  // shortDescription is JSON-encoded in the page's inline JS
  const marker = '"shortDescription":"';
  const idx = html.indexOf(marker);
  let downloadUrl = "";
  if (idx !== -1) {
    let desc = "";
    let i = idx + marker.length;
    while (i < html.length) {
      const c = html[i], c2 = html[i + 1];
      if (c === "\\" && c2 === '"') { desc += '"'; i += 2; }
      else if (c === "\\" && c2 === "n") { desc += "\n"; i += 2; }
      else if (c === "\\" && c2 === "\\") { desc += "\\"; i += 2; }
      else if (c === '"') break;
      else { desc += c; i++; }
    }
    downloadUrl = findDownloadLink(desc);
  }

  return { uploadDate, downloadUrl };
}

async function enrichWithYouTube(setups: ScrapedSetup[]): Promise<void> {
  // Collect unique YouTube video IDs
  const videoIds = new Set<string>();
  for (const s of setups) {
    const id = extractYouTubeId(s.downloadUrl) || extractYouTubeId(s.videoUrl);
    if (id) videoIds.add(id);
  }
  if (videoIds.size === 0) return;

  console.log(`\nFetching YouTube metadata for ${videoIds.size} unique videos...`);
  const metaCache = new Map<string, { uploadDate: string; downloadUrl: string }>();

  let done = 0;
  await pooled([...videoIds], 5, async (id) => {
    try {
      metaCache.set(id, await fetchYouTubeMeta(id));
    } catch {
      metaCache.set(id, { uploadDate: "", downloadUrl: "" });
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`  ${done}/${videoIds.size}...\n`);
    await sleep(150);
  });

  let datesAdded = 0, linksFound = 0;
  for (const s of setups) {
    const id = extractYouTubeId(s.downloadUrl) || extractYouTubeId(s.videoUrl);
    if (!id) continue;
    const meta = metaCache.get(id);
    if (!meta) continue;
    if (meta.uploadDate && !s.date) { s.date = meta.uploadDate; datesAdded++; }
    if (meta.downloadUrl) { s.downloadUrl = meta.downloadUrl; linksFound++; }
  }
  console.log(`  Dates added: ${datesAdded}, download links found: ${linksFound}`);
}

async function main() {
  console.log("Fetching car list from accsetups.com...");
  const cars = await getCarUrls();
  console.log(`Found ${cars.length} cars\n`);

  const allSetups: ScrapedSetup[] = [];
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    process.stdout.write(`[${i + 1}/${cars.length}] ${car.name} ... `);
    try {
      const setups = await scrapeCarSetups(car.slug, car.name);
      console.log(`${setups.length} setups`);
      allSetups.push(...setups);
    } catch (err: any) {
      console.log(`FAILED: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nTotal raw setups: ${allSetups.length}`);

  // Enrich with YouTube metadata (upload date + description download links)
  await enrichWithYouTube(allSetups);

  // Filter base setups
  const filtered = allSetups.filter((s) => {
    const t = s.trackName.toLowerCase();
    return t !== "base setup" && t !== "base";
  });

  // Group by car+track, sort by lap time, limit per combo
  const grouped = new Map<string, ScrapedSetup[]>();
  for (const s of filtered) {
    const key = `${s.carModel}::${s.trackName}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  // Write to shared/data/tunes/acc/{source}/{track}/{car}.json
  const outBase = resolve(import.meta.dir, "../shared/data/tunes/acc", SOURCE_SLUG);
  if (!existsSync(outBase)) mkdirSync(outBase, { recursive: true });

  // Write _source.json
  writeFileSync(resolve(outBase, "_source.json"), JSON.stringify({
    name: "ACC Setups",
    slug: SOURCE_SLUG,
    domain: "accsetups.com",
    url: BASE + "/",
    lastScraped: new Date().toISOString(),
  }, null, 2));

  let fileCount = 0;
  let totalSetups = 0;
  for (const [, setups] of grouped) {
    setups.sort((a, b) => {
      if (!a.lapTime && !b.lapTime) return 0;
      if (!a.lapTime) return 1;
      if (!b.lapTime) return -1;
      return a.lapTime.localeCompare(b.lapTime);
    });
    const limited = setups.slice(0, MAX_PER_CAR_TRACK);
    const trackSlug = slugify(limited[0].trackName);
    const carSlug = limited[0].carModel;
    const trackDir = resolve(outBase, trackSlug);
    if (!existsSync(trackDir)) mkdirSync(trackDir, { recursive: true });
    writeFileSync(resolve(trackDir, carSlug + ".json"), JSON.stringify(limited, null, 2));
    fileCount++;
    totalSetups += limited.length;
  }

  const uniqueCars = new Set(filtered.map((s) => s.carModel)).size;
  const uniqueTracks = new Set(filtered.map((s) => slugify(s.trackName))).size;
  // Update lastScraped in _source.json
  const metaPath = resolve(outBase, "_source.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  meta.lastScraped = new Date().toISOString();
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`\nWritten ${fileCount} files (${totalSetups} setups) to ${outBase}`);
  console.log(`${uniqueCars} cars, ${uniqueTracks} tracks`);
}

main().catch(console.error);
