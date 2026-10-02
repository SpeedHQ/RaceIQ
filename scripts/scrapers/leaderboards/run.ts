import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchText } from "../../lib/http";
import { runPool } from "../../lib/pool";

const TRACK_SLUGS = ["australia", "china", "japan", "bahrain", "saudi_arabia", "miami", "imola", "monaco", "spain", "canada", "austria", "silverstone", "spa", "hungary", "netherlands", "monza", "azerbaijan", "singapore", "usa", "mexico", "brazil", "las_vegas", "qatar", "abudhabi"];
const F1LAPS = "https://www.f1laps.com";
const OUT_DIR = resolve(import.meta.dir, "../../../shared/data/tunes/f1-25/f1laps");
const HEADERS = { "User-Agent": "RaceIQ-LeaderboardScraper/1.0" };
export interface LeaderboardEntry { rank: number; date: string; lapTime: string; player: string; team: string; sessionType: string; }
export function parseLeaderboard(html: string): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  const rowRe = /<tr class="[^"]*hover[^"]*">([\s\S]*?)<\/tr>/gi;
  while (true) {
    const match = rowRe.exec(html);
    if (match === null) break;
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
    if (cells.length < 6) continue;
    const rank = parseInt(cells[0], 10) || 0;
    if (rank > 0) entries.push({ rank, date: cells[1], lapTime: cells[2], player: cells[3], team: cells[4], sessionType: cells[5] });
  }
  return entries;
}
export async function main(): Promise<void> { console.log(`Scraping leaderboards for ${TRACK_SLUGS.length} tracks (6 concurrent)...\n`); let total = 0; await runPool(TRACK_SLUGS, 6, async slug => { try { const html = await fetchText(`${F1LAPS}/f1-25/leaderboard/${slug}/`, { headers: HEADERS, retries: 3, retryDelayMs: attempt => 2000 * (attempt + 1) }); const leaderboard = parseLeaderboard(html); const dir = resolve(OUT_DIR, slug); mkdirSync(dir, { recursive: true }); await Bun.write(resolve(dir, "_leaderboard.json"), JSON.stringify(leaderboard, null, 2)); total += leaderboard.length; console.log(`  ✓ ${slug.padEnd(14)} ${leaderboard.length} entries`); } catch (error) { console.log(`  ✗ ${slug.padEnd(14)} ${(error as Error).message}`); } }); const metaPath = resolve(OUT_DIR, "_source.json"); if (existsSync(metaPath)) { const meta = JSON.parse(readFileSync(metaPath, "utf-8")); meta.lastScraped = new Date().toISOString(); await Bun.write(metaPath, JSON.stringify(meta, null, 2)); } console.log(`\nDone! ${total} leaderboard entries across ${TRACK_SLUGS.length} tracks`); }
