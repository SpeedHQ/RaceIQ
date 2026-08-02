import { z } from "zod";
import {
  getCommunityTunesSyncState,
  setCommunityTunesSyncState,
} from "../runtime/config/settings";
import {
  replaceCommunityTunes,
  type CommunityTuneRow,
} from "../db/community-tune-queries";

/**
 * Community-tunes CDN sync.
 *
 * Fetches a manifest + per-game tune payload from the Cloudflare Pages
 * deployment and mirrors it into the local `community_tunes` table via a
 * transactional replace-all. The cache is persistent and never expires: any
 * network or validation failure leaves the previously-synced rows in place.
 *
 * See docs/integrations/community-tunes.md.
 */

const DEFAULT_BASE_URL = "https://speedhq-tunes.pages.dev";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Games the CDN publishes today. Built-in catalog is FM-only, matching this. */
const SYNCED_GAME_IDS = ["fm-2023"] as const;

function baseUrl(): string {
  return process.env.COMMUNITY_TUNES_URL ?? DEFAULT_BASE_URL;
}

const ManifestSchema = z.object({
  version: z.string(),
  generatedAt: z.string().optional(),
  games: z.record(
    z.string(),
    z.object({ count: z.number().optional(), path: z.string() }),
  ),
});

// Incoming CatalogTune rows. We validate structure but only persist the columns
// the community_tunes table carries; extra fields (strengths, weaknesses, …)
// are accepted and dropped.
const CdnTuneSchema = z.object({
  id: z.string().min(1),
  gameId: z.string().min(1),
  carOrdinal: z.number().int(),
  trackOrdinal: z.number().int().nullable().optional(),
  name: z.string().min(1),
  author: z.string().min(1),
  category: z.string().min(1),
  description: z.string().optional().default(""),
  sourceName: z.string().optional().default(""),
  settings: z.record(z.string(), z.unknown()),
});

interface SyncResult {
  synced: boolean;
  count: number;
  version: string | null;
}

let syncInProgress = false;

/**
 * Run one sync pass. Returns `{synced:false}` when the manifest version matches
 * the stored version (no work done) or when a failure keeps the existing cache.
 *
 * Pass `{ force: true }` to re-fetch and replace even when the manifest version
 * is unchanged — used by the manual "Refresh" endpoint so it always pulls the
 * latest, and to recover when the stored version drifts out of sync with the
 * actually-persisted rows.
 */
export async function syncCommunityTunes(
  options: { force?: boolean } = {},
): Promise<SyncResult> {
  const stored = getCommunityTunesSyncState();
  if (syncInProgress) {
    return { synced: false, count: 0, version: stored.version };
  }
  syncInProgress = true;
  try {
    const manifestRes = await fetch(`${baseUrl()}/manifest.json`);
    if (!manifestRes.ok) {
      console.warn(
        `[CommunityTunes] manifest fetch failed: HTTP ${manifestRes.status}`,
      );
      return { synced: false, count: 0, version: stored.version };
    }
    const manifest = ManifestSchema.parse(await manifestRes.json());

    if (!options.force && manifest.version === stored.version) {
      return { synced: false, count: 0, version: stored.version };
    }

    let total = 0;
    for (const gameId of SYNCED_GAME_IDS) {
      const entry = manifest.games[gameId];
      if (!entry) {
        // Game absent from manifest → treat as full takedown for that game.
        console.warn(
          `[CommunityTunes] manifest has no entry for ${gameId}; clearing its rows`,
        );
        await replaceCommunityTunes(gameId, []);
        continue;
      }

      const tunesUrl = new URL(entry.path, `${baseUrl()}/`).toString();
      const tunesRes = await fetch(tunesUrl);
      if (!tunesRes.ok) {
        console.warn(
          `[CommunityTunes] tunes fetch failed for ${gameId}: HTTP ${tunesRes.status}; keeping cache`,
        );
        return { synced: false, count: 0, version: stored.version };
      }

      const raw = await tunesRes.json();
      if (!Array.isArray(raw)) {
        console.warn(
          `[CommunityTunes] tunes payload for ${gameId} is not an array; keeping cache`,
        );
        return { synced: false, count: 0, version: stored.version };
      }

      const rows: CommunityTuneRow[] = [];
      let skipped = 0;
      for (const item of raw) {
        const parsed = CdnTuneSchema.safeParse(item);
        if (!parsed.success) {
          skipped++;
          continue;
        }
        const t = parsed.data;
        rows.push({
          id: t.id,
          gameId: t.gameId,
          carOrdinal: t.carOrdinal,
          trackOrdinal: t.trackOrdinal ?? null,
          name: t.name,
          author: t.author,
          category: t.category,
          description: t.description,
          sourceName: t.sourceName,
          settings: JSON.stringify(t.settings),
        });
      }

      if (skipped > 0) {
        console.warn(
          `[CommunityTunes] ${gameId}: skipped ${skipped} invalid row(s)`,
        );
      }
      if (rows.length === 0) {
        console.warn(
          `[CommunityTunes] ${gameId}: zero valid rows — treating as full takedown`,
        );
      }

      const written = await replaceCommunityTunes(gameId, rows);
      total += written;
    }

    setCommunityTunesSyncState(manifest.version);
    console.log(
      `[CommunityTunes] synced ${total} tune(s) at version ${manifest.version}`,
    );
    return { synced: true, count: total, version: manifest.version };
  } catch (err) {
    console.warn(
      "[CommunityTunes] sync failed; keeping existing cache:",
      err instanceof Error ? err.message : err,
    );
    return { synced: false, count: 0, version: stored.version };
  } finally {
    syncInProgress = false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Kick off a non-blocking startup sync and schedule the recurring 6h refresh.
 * Safe to call once during server bootstrap.
 */
export function startCommunityTunesSync(): void {
  void syncCommunityTunes();
  if (!intervalHandle) {
    intervalHandle = setInterval(() => {
      void syncCommunityTunes();
    }, SYNC_INTERVAL_MS);
  }
}
