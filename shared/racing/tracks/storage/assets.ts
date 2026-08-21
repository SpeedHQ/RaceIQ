import { getAccSharedTrackName } from "../catalogs/acc";
import { resolve } from "node:path";
import { GameIdSchema, type GameId } from "@shared/games/ids";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { getTrackRegistry, getTrackRegistryRevision } from "../registry";
import { canonicalTrackAssetPathComponents, parseVenueRevisionPath } from "../configuration";

export type GeometryAssetKind = "centerline" | "raceline" | "boundaries";

export interface TrackAssetIdentity {
  gameId: GameId;
  ordinal: number;
  venuePath: string;
  layoutSlug: string;
  factsSlug: string | null;
}

interface IdentityRow {
  venuePath: string;
  layoutSlug: string;
  factsSlug: string | null;
}

const identityCache = new Map<string, TrackAssetIdentity | null>();
let identityCacheRevision = -1;

function clearStaleIdentityCache(): void {
  const revision = getTrackRegistryRevision();
  if (identityCacheRevision === revision) return;
  identityCache.clear();
  identityCacheRevision = revision;
}

/** Registry-backed canonical venue/layout identity for a game track ordinal. */
export function getTrackAssetIdentity(gameId: string, ordinal: number): TrackAssetIdentity | null {
  const parsedGameId = GameIdSchema.safeParse(gameId);
  if (!parsedGameId.success || !Number.isInteger(ordinal) || ordinal < 0) return null;

  clearStaleIdentityCache();
  const key = `${parsedGameId.data}:${ordinal}`;
  const cached = identityCache.get(key);
  if (cached !== undefined) return cached;

  const row = getTrackRegistry()
    .query(`
    SELECT l.venue_path AS venuePath, l.slug AS layoutSlug, l.facts_slug AS factsSlug
      FROM game_tracks gt
      JOIN layouts l ON l.canonical_id = gt.layout_id
     WHERE gt.game_id = ? AND gt.track_ordinal = ?
  `)
    .get(parsedGameId.data, ordinal) as IdentityRow | null;
  const identity = row && {
    gameId: parsedGameId.data,
    ordinal,
    venuePath: row.venuePath,
    layoutSlug: row.layoutSlug,
    factsSlug: row.factsSlug,
  };
  identityCache.set(key, identity);
  return identity;
}

/** Every game assignment for one facts slug, optionally scoped to one game. */
export function findTrackAssetIdentities(factsSlug: string, gameFilter?: string): TrackAssetIdentity[] {
  const parsedGameId = gameFilter === undefined ? null : GameIdSchema.safeParse(gameFilter);
  if (parsedGameId && !parsedGameId.success) return [];
  return getTrackRegistry()
    .query(`
    SELECT gt.game_id AS gameId, gt.track_ordinal AS ordinal,
           l.venue_path AS venuePath, l.slug AS layoutSlug, l.facts_slug AS factsSlug
      FROM game_tracks gt
      JOIN layouts l ON l.canonical_id = gt.layout_id
     WHERE l.facts_slug = ?
       AND (? IS NULL OR gt.game_id = ?)
     ORDER BY gt.game_id, gt.track_ordinal
  `)
    .all(factsSlug, parsedGameId?.data ?? null, parsedGameId?.data ?? null) as TrackAssetIdentity[];
}

const LEGACY_GEOMETRY_GAME_PRIORITY: readonly GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"];

/** Canonical game assignment that owns one legacy baseline geometry asset. */
export function legacyGeometryOwnerIdentity(factsSlug: string): TrackAssetIdentity | null {
  const identities = findTrackAssetIdentities(factsSlug);
  for (const gameId of LEGACY_GEOMETRY_GAME_PRIORITY) {
    const identity = identities.find((candidate) => candidate.gameId === gameId);
    if (identity) return identity;
  }
  return null;
}

/** Every canonical game-track identity, optionally scoped to one game. */
export function listTrackAssetIdentities(gameFilter?: string): TrackAssetIdentity[] {
  const parsedGameId = gameFilter === undefined ? null : GameIdSchema.safeParse(gameFilter);
  if (parsedGameId && !parsedGameId.success) return [];
  return getTrackRegistry()
    .query(`
    SELECT gt.game_id AS gameId, gt.track_ordinal AS ordinal,
           l.venue_path AS venuePath, l.slug AS layoutSlug, l.facts_slug AS factsSlug
      FROM game_tracks gt
      JOIN layouts l ON l.canonical_id = gt.layout_id
     WHERE (? IS NULL OR gt.game_id = ?)
     ORDER BY gt.game_id, gt.track_ordinal
  `)
    .all(parsedGameId?.data ?? null, parsedGameId?.data ?? null) as TrackAssetIdentity[];
}

const AC_EVO_ACC_FALLBACK_SLUGS: ReadonlySet<string> = new Set(["budapest", "catalunya", "misano", "silverstone", "zandvoort"]);

/** AC Evo layouts whose installed game data has no ideal line and explicitly reuses ACC. */
export function usesAccGeometryFallback(identity: TrackAssetIdentity, factsSlug: string | null): boolean {
  return identity.gameId === "ac-evo" && factsSlug !== null && AC_EVO_ACC_FALLBACK_SLUGS.has(factsSlug);
}

/**
 * ACC ordinals 0–10 are original 2019 source layouts; 11–21 are their
 * 2023 aliases in identical order. All 22 resolve to 11 root shared assets.
 */
const ACC_SHARED_SOURCE_ORDINAL: Readonly<Record<number, number>> = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 0,
  12: 1,
  13: 2,
  14: 3,
  15: 4,
  16: 5,
  17: 6,
  18: 7,
  19: 8,
  20: 9,
  21: 10,
};

/** Whether ACC assignment uses one of the 11 shared 2019 source assets. */
export function isSharedAccGeometryAsset(identity: TrackAssetIdentity): boolean {
  return identity.gameId === "acc" && ACC_SHARED_SOURCE_ORDINAL[identity.ordinal] !== undefined;
}

/** Canonical shared ACC source slug for one of the 22 paired assignments. */
export function sharedAccGeometrySlug(identity: TrackAssetIdentity): string | null {
  if (identity.gameId !== "acc") return null;
  const sourceOrdinal = ACC_SHARED_SOURCE_ORDINAL[identity.ordinal];
  return sourceOrdinal === undefined ? null : (getAccSharedTrackName(sourceOrdinal) ?? null);
}

/** Canonical bundled geometry path for one game-specific track layout. */
export function bundledGeometryPath(identity: TrackAssetIdentity, kind: GeometryAssetKind): string {
  return resolve(SHARED_DIR, "tracks", ...canonicalTrackAssetPathComponents(identity.venuePath, identity.layoutSlug), "geometry", identity.gameId, `${kind}.${kind === "boundaries" ? "json" : "csv"}`);
}

/** Canonical root-venue path for one of the shared ACC source assets. */
export function bundledSharedAccGeometryPath(identity: TrackAssetIdentity, slug: string, kind: GeometryAssetKind): string | null {
  const { rootVenuePath } = parseVenueRevisionPath(identity.venuePath);
  if (!rootVenuePath || !slug) return null;
  return resolve(SHARED_DIR, "tracks", "venues", rootVenuePath, "geometry", "acc", `${slug}-${kind}.${kind === "boundaries" ? "json" : "csv"}`);
}

/** Game-owned path for a legacy baseline centerline or boundary snapshot. */
export function bundledLegacyGeometryPath(identity: TrackAssetIdentity, kind: Exclude<GeometryAssetKind, "raceline">): string {
  return resolve(
    SHARED_DIR,
    "tracks",
    ...canonicalTrackAssetPathComponents(identity.venuePath, identity.layoutSlug),
    "geometry",
    identity.gameId,
    `legacy-${kind}.${kind === "boundaries" ? "json" : "csv"}`,
  );
}
