import { z } from "zod";

/**
 * Community leaderboard CDN sync.
 *
 * Fetches the `forza` leaderboard file published alongside community tunes
 * on the Cloudflare Pages deployment — a flat list of best-known lap times
 * per car/track from the community hotlap spreadsheet. Purely a reference
 * dataset shown standalone in the UI; never joined onto individual tunes
 * (car/track name matching between the two sources isn't reliable enough for
 * that). Cached in memory only — a restart just re-fetches once.
 *
 * See docs/specs/2026-07-11-community-tunes-cdn-design.md.
 */

const DEFAULT_BASE_URL = "https://speedhq-tunes.pages.dev";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LEADERBOARD_GAME_ID = "forza"; // key used in the CDN manifest, not RaceIQ's "fm-2023"

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

let cache: LaptimeEntry[] = [];
let cachedVersion: string | null = null;
let syncInProgress = false;

export function getLaptimes(): LaptimeEntry[] {
  return cache;
}

export interface LaptimeSyncResult {
  synced: boolean;
  count: number;
  version: string | null;
}

/**
 * Run one sync pass. Skips re-fetching the leaderboard file when the
 * manifest version is unchanged, unless `force` is set.
 */
export async function syncLaptimes(
  options: { force?: boolean } = {},
): Promise<LaptimeSyncResult> {
  if (syncInProgress) {
    return { synced: false, count: cache.length, version: cachedVersion };
  }
  syncInProgress = true;
  try {
    const manifestRes = await fetch(`${baseUrl()}/manifest.json`);
    if (!manifestRes.ok) {
      console.warn(`[Laptimes] manifest fetch failed: HTTP ${manifestRes.status}`);
      return { synced: false, count: cache.length, version: cachedVersion };
    }
    const manifest = ManifestSchema.parse(await manifestRes.json());

    if (!options.force && manifest.version === cachedVersion) {
      return { synced: false, count: cache.length, version: cachedVersion };
    }

    const entry = manifest.laptimes?.[LEADERBOARD_GAME_ID];
    if (!entry) {
      console.warn(`[Laptimes] manifest has no leaderboard entry for "${LEADERBOARD_GAME_ID}"`);
      return { synced: false, count: cache.length, version: cachedVersion };
    }

    const laptimesUrl = new URL(entry.path, `${baseUrl()}/`).toString();
    const res = await fetch(laptimesUrl);
    if (!res.ok) {
      console.warn(`[Laptimes] fetch failed: HTTP ${res.status}; keeping cache`);
      return { synced: false, count: cache.length, version: cachedVersion };
    }

    const raw = await res.json();
    if (!Array.isArray(raw)) {
      console.warn("[Laptimes] payload is not an array; keeping cache");
      return { synced: false, count: cache.length, version: cachedVersion };
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
      console.warn(`[Laptimes] skipped ${skipped} invalid row(s)`);
    }

    cache = rows;
    cachedVersion = manifest.version;
    console.log(`[Laptimes] synced ${rows.length} entry(ies) at version ${manifest.version}`);
    return { synced: true, count: rows.length, version: manifest.version };
  } catch (err) {
    console.warn("[Laptimes] sync failed; keeping existing cache:", err instanceof Error ? err.message : err);
    return { synced: false, count: cache.length, version: cachedVersion };
  } finally {
    syncInProgress = false;
  }
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
