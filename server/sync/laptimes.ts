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
 * See docs/integrations/community-tunes.md.
 */

const DEFAULT_BASE_URL = "https://speedhq-tunes.pages.dev";
const MANIFEST_PATH = "/manifest.json";
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

const MANIFEST_ENTRIES = Object.entries(MANIFEST_KEY_BY_GAME) as Array<
  [GameId, string]
>;

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

type LaptimeEntry = z.infer<typeof LaptimeEntrySchema>;
type LaptimeManifest = z.infer<typeof ManifestSchema>;
type LaptimeSyncResult = {
  synced: boolean;
  count: number;
  version: string | null;
};

const cache = new Map<GameId, LaptimeEntry[]>();
let cachedVersion: string | null = null;
let syncInProgress = false;

export function getLaptimes(gameId: GameId): LaptimeEntry[] {
  return cache.get(gameId) ?? [];
}

function resolveManifestUrl(base: string): string {
  return `${base}${MANIFEST_PATH}`;
}

function resolveLaptimeUrl(base: string, path: string): string {
  return new URL(path, `${base}/`).toString();
}

function skippedResult(version: string | null): LaptimeSyncResult {
  return { synced: false, count: totalCached(), version };
}

async function fetchManifest(): Promise<LaptimeManifest | null> {
  const manifestRes = await fetch(resolveManifestUrl(baseUrl()));
  if (!manifestRes.ok) {
    console.warn(`[Laptimes] manifest fetch failed: HTTP ${manifestRes.status}`);
    return null;
  }
  return ManifestSchema.parse(await manifestRes.json());
}

async function fetchGamePayload(
  manifestKey: string,
  path: string,
): Promise<{ value: unknown } | null> {
  const laptimesUrl = resolveLaptimeUrl(baseUrl(), path);
  const res = await fetch(laptimesUrl);
  if (!res.ok) {
    console.warn(`[Laptimes] ${manifestKey} fetch failed: HTTP ${res.status}; keeping cache`);
    return null;
  }
  return { value: await res.json() };
}

function parseLaptimeRows(manifestKey: string, raw: unknown): LaptimeEntry[] | null {
  if (!Array.isArray(raw)) {
    console.warn(`[Laptimes] ${manifestKey} payload is not an array; keeping cache`);
    return null;
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

  return rows;
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
    return skippedResult(cachedVersion);
  }
  syncInProgress = true;
  try {
    const manifest = await fetchManifest();
    if (!manifest) {
      return skippedResult(cachedVersion);
    }

    if (!options.force && manifest.version === cachedVersion) {
      return skippedResult(cachedVersion);
    }

    let total = 0;
    for (const [gameId, manifestKey] of MANIFEST_ENTRIES) {
      const entry = manifest.laptimes?.[manifestKey];
      if (!entry) {
        console.warn(`[Laptimes] manifest has no leaderboard entry for "${manifestKey}"`);
        continue;
      }

      const payload = await fetchGamePayload(manifestKey, entry.path);
      if (!payload) {
        continue;
      }

      const rows = parseLaptimeRows(manifestKey, payload.value);
      if (!rows) {
        continue;
      }

      cache.set(gameId, rows);
      total += rows.length;
      console.log(`[Laptimes] synced ${rows.length} entry(ies) for ${gameId}`);
    }

    cachedVersion = manifest.version;
    console.log(
      `[Laptimes] sync complete: ${total} total entry(ies) at version ${manifest.version}`,
    );
    return { synced: true, count: total, version: manifest.version };
  } catch (err) {
    console.warn("[Laptimes] sync failed; keeping existing cache:", err instanceof Error ? err.message : err);
    return skippedResult(cachedVersion);
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
