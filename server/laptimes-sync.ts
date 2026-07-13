import { z } from "zod";
import type { GameId } from "@shared/types";

/**
 * Community leaderboard CDN sync.
 *
 * Fetches the per-game leaderboard files published alongside community tunes
 * on the Cloudflare Pages deployment — flat lists of best-known lap times per
 * car/track from the community hotlap spreadsheets. Purely reference datasets
 * shown standalone in the UI; never joined onto individual tunes (car/track
 * name matching between the two sources isn't reliable enough for that).
 * Cached in memory only — a restart just re-fetches once.
 *
 * See docs/specs/2026-07-11-community-tunes-cdn-design.md.
 */

const DEFAULT_BASE_URL = "https://speedhq-tunes.pages.dev";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Maps a RaceIQ gameId to the key the CDN manifest uses under `laptimes`.
 * The manifest also publishes `lmu` (Le Mans Ultimate), which RaceIQ doesn't
 * support — so it's absent here and simply never fetched.
 */
const MANIFEST_KEY_BY_GAME: Partial<Record<GameId, string>> = {
  "fm-2023": "forza",
  acc: "acc",
  "ac-evo": "ac-evo",
};

function baseUrl(): string {
  return process.env.COMMUNITY_TUNES_URL ?? DEFAULT_BASE_URL;
}

const ManifestSchema = z.object({
  version: z.string(),
  laptimes: z
    .record(z.string(), z.object({ count: z.number().optional(), path: z.string() }))
    .optional(),
});

const LaptimeEntrySchema = z.object({
  track: z.string(),
  carClass: z.string().optional().default(""),
  car: z.string(),
  driver: z.string().optional().default(""),
  laptime: z.string(),
});

export type LaptimeEntry = z.infer<typeof LaptimeEntrySchema>;

const cache = new Map<GameId, LaptimeEntry[]>();
let cachedVersion: string | null = null;
let syncInProgress = false;

export function getLaptimes(gameId: GameId): LaptimeEntry[] {
  return cache.get(gameId) ?? [];
}

export interface LaptimeSyncResult {
  synced: boolean;
  count: number;
  version: string | null;
}

/**
 * Run one sync pass across every game the CDN publishes leaderboards for.
 * Skips re-fetching when the manifest version is unchanged, unless `force`
 * is set. Per-game failures are isolated: a bad payload for one game keeps
 * that game's existing cache and doesn't abort the others.
 */
export async function syncLaptimes(
  options: { force?: boolean } = {},
): Promise<LaptimeSyncResult> {
  if (syncInProgress) {
    return { synced: false, count: totalCached(), version: cachedVersion };
  }
  syncInProgress = true;
  try {
    const manifestRes = await fetch(`${baseUrl()}/manifest.json`);
    if (!manifestRes.ok) {
      console.warn(`[Laptimes] manifest fetch failed: HTTP ${manifestRes.status}`);
      return { synced: false, count: totalCached(), version: cachedVersion };
    }
    const manifest = ManifestSchema.parse(await manifestRes.json());

    if (!options.force && manifest.version === cachedVersion) {
      return { synced: false, count: totalCached(), version: cachedVersion };
    }

    let total = 0;
    for (const [gameId, manifestKey] of Object.entries(MANIFEST_KEY_BY_GAME) as [
      GameId,
      string,
    ][]) {
      const entry = manifest.laptimes?.[manifestKey];
      if (!entry) {
        console.warn(`[Laptimes] manifest has no leaderboard entry for "${manifestKey}"`);
        continue;
      }

      const laptimesUrl = new URL(entry.path, `${baseUrl()}/`).toString();
      const res = await fetch(laptimesUrl);
      if (!res.ok) {
        console.warn(`[Laptimes] ${manifestKey} fetch failed: HTTP ${res.status}; keeping cache`);
        continue;
      }

      const raw = await res.json();
      if (!Array.isArray(raw)) {
        console.warn(`[Laptimes] ${manifestKey} payload is not an array; keeping cache`);
        continue;
      }

      const rows: LaptimeEntry[] = [];
      let skipped = 0;
      for (const item of raw) {
        const parsed = LaptimeEntrySchema.safeParse(item);
        if (!parsed.success) {
          skipped++;
          continue;
        }
        rows.push(parsed.data);
      }
      if (skipped > 0) {
        console.warn(`[Laptimes] ${manifestKey}: skipped ${skipped} invalid row(s)`);
      }

      cache.set(gameId, rows);
      total += rows.length;
      console.log(`[Laptimes] synced ${rows.length} entry(ies) for ${gameId}`);
    }

    cachedVersion = manifest.version;
    console.log(`[Laptimes] sync complete: ${total} total entry(ies) at version ${manifest.version}`);
    return { synced: true, count: total, version: manifest.version };
  } catch (err) {
    console.warn("[Laptimes] sync failed; keeping existing cache:", err instanceof Error ? err.message : err);
    return { synced: false, count: totalCached(), version: cachedVersion };
  } finally {
    syncInProgress = false;
  }
}

function totalCached(): number {
  let n = 0;
  for (const rows of cache.values()) n += rows.length;
  return n;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Kick off a non-blocking startup sync and schedule the recurring 6h refresh.
 * Safe to call once during server bootstrap.
 */
export function startLaptimesSync(): void {
  void syncLaptimes();
  if (!intervalHandle) {
    intervalHandle = setInterval(() => {
      void syncLaptimes();
    }, SYNC_INTERVAL_MS);
  }
}
