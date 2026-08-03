/**
 * Scrape F1 25 leaderboards from f1laps.com and write into source folder.
 * Writes to shared/data/tunes/f1-25/f1laps/{track}/_meta.json
 *
 * Usage: bun scripts/scrape-f1-leaderboards.ts
 */
import { existsSync, readFileSync, mkdirSync } from "fs";

const TRACK_SLUGS = [
  "australia", "china", "japan", "bahrain", "saudi_arabia", "miami",
  "imola", "monaco", "spain", "canada", "austria", "silverstone",
  "spa", "hungary", "netherlands", "monza", "azerbaijan", "singapore",
  "usa", "mexico", "brazil", "las_vegas", "qatar", "abudhabi",
];

const F1LAPS = "https://www.f1laps.com";
const OUT_DIR = "shared/data/tunes/f1-25/f1laps";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "RaceIQ-LeaderboardScraper/1.0" },
      });
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      return res.text();
    } catch (err) {
      if (attempt < retries - 1) { await sleep(2000 * (attempt + 1)); continue; }
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function pooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

interface LeaderboardEntry {
  rank: number;
  date: string;
  lapTime: string;
  player: string;
  team: string;
  sessionType: string;
}

function parseLeaderboard(html: string): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  const rowRe = /<tr class="[^"]*hover[^"]*">([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(t =>
      t[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
    );
    if (tds.length < 6) continue;
    const rank = parseInt(tds[0]) || 0;
    if (rank <= 0) continue;
    entries.push({
      rank,
      date: tds[1],
      lapTime: tds[2],
      player: tds[3],
      team: tds[4],
      sessionType: tds[5],
    });
  }
  return entries;
}

async function main() {
  console.log(`Scraping leaderboards for ${TRACK_SLUGS.length} tracks (6 concurrent)...\n`);

  let total = 0;
  await pooled(TRACK_SLUGS, 6, async (slug) => {
    try {
      const html = await fetchText(`${F1LAPS}/f1-25/leaderboard/${slug}/`);
      const leaderboard = parseLeaderboard(html);

      // Write leaderboard.json in f1laps source folder
      const dir = `${OUT_DIR}/${slug}`;
      mkdirSync(dir, { recursive: true });
      await Bun.write(`${dir}/_leaderboard.json`, JSON.stringify(leaderboard, null, 2));

      total += leaderboard.length;
      console.log(`  ✓ ${slug.padEnd(14)} ${leaderboard.length} entries`);
    } catch (err) {
      console.log(`  ✗ ${slug.padEnd(14)} ${(err as Error).message}`);
    }
  });

  // Update lastScraped in _source.json
  const metaPath = `${OUT_DIR}/_source.json`;
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.lastScraped = new Date().toISOString();
    await Bun.write(metaPath, JSON.stringify(meta, null, 2));
  }
  console.log(`\nDone! ${total} leaderboard entries across ${TRACK_SLUGS.length} tracks`);
}

main().catch(console.error);
