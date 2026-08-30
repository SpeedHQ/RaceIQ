import { getAccSharedTrackName } from "../catalogs/acc";
import { resolve } from "node:path";
import { GameIdSchema, KNOWN_GAME_IDS, type GameId } from "@shared/games/ids";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { getTrackRegistry, getTrackRegistryIndexes, type TrackRegistryReadModel } from "../registry";
import { canonicalTrackAssetPathComponents, parseCanonicalTrackId, parseVenueRevisionPath } from "../configuration";

export type GeometryAssetKind = "centerline" | "raceline" | "boundaries";
export type SharedGeometrySource = "acc" | "tumftm";

export interface TrackAssetIdentity {
  gameId: GameId;
  ordinal: number;
  venuePath: string;
  layoutSlug: string;
  factsSlug: string | null;
}

type TrackAssignment = TrackRegistryReadModel["assignments"][number];

function identityFromAssignment(assignment: TrackAssignment): TrackAssetIdentity {
  const layout = getTrackRegistryIndexes().layoutsById.get(assignment.layoutId);
  if (!layout) throw new Error(`Track registry layout is missing for ${assignment.layoutId}`);
  const { venuePath, layoutSlug } = parseCanonicalTrackId(layout.id);
  return {
    gameId: assignment.gameId,
    ordinal: assignment.trackOrdinal,
    venuePath,
    layoutSlug,
    factsSlug: layout.factsSlug ?? null,
  };
}

function sortIdentities(a: TrackAssetIdentity, b: TrackAssetIdentity): number {
  return KNOWN_GAME_IDS.indexOf(a.gameId) - KNOWN_GAME_IDS.indexOf(b.gameId) || a.ordinal - b.ordinal;
}

/** Registry-backed canonical venue/layout identity for a game track ordinal. */
export function getTrackAssetIdentity(gameId: string, ordinal: number): TrackAssetIdentity | null {
  const parsedGameId = GameIdSchema.safeParse(gameId);
  if (!parsedGameId.success || !Number.isInteger(ordinal) || ordinal < 0) return null;
  const assignment = getTrackRegistryIndexes().assignmentsByGame.get(parsedGameId.data)?.get(ordinal);
  return assignment ? identityFromAssignment(assignment) : null;
}

/** Canonical venue/layout identity for one facts slug, or null when ambiguous. */
export function getTrackAssetIdentityForFactsSlug(factsSlug: string): TrackAssetIdentity | null {
  const indexes = getTrackRegistryIndexes();
  const layouts = indexes.layoutsByFactsSlug.get(factsSlug) ?? [];
  if (layouts.length !== 1) return null;
  const assignments = indexes.assignmentsByLayoutId.get(layouts[0]!.id) ?? [];
  const identities = assignments.map(identityFromAssignment).sort(sortIdentities);
  return identities[0] ?? null;
}

/** Every game assignment for one facts slug, optionally scoped to one game. */
export function findTrackAssetIdentities(factsSlug: string, gameFilter?: string): TrackAssetIdentity[] {
  const parsedGameId = gameFilter === undefined ? null : GameIdSchema.safeParse(gameFilter);
  if (parsedGameId && !parsedGameId.success) return [];
  const indexes = getTrackRegistryIndexes();
  return (indexes.layoutsByFactsSlug.get(factsSlug) ?? [])
    .flatMap((layout) => indexes.assignmentsByLayoutId.get(layout.id) ?? [])
    .filter((assignment) => !parsedGameId || assignment.gameId === parsedGameId.data)
    .map(identityFromAssignment)
    .sort(sortIdentities);
}

/** Every canonical game-track identity, optionally scoped to one game. */
export function listTrackAssetIdentities(gameFilter?: string): TrackAssetIdentity[] {
  const parsedGameId = gameFilter === undefined ? null : GameIdSchema.safeParse(gameFilter);
  if (parsedGameId && !parsedGameId.success) return [];
  return getTrackRegistry()
    .assignments.filter((assignment) => !parsedGameId || assignment.gameId === parsedGameId.data)
    .map(identityFromAssignment)
    .sort(sortIdentities);
}



const AC_EVO_ACC_FALLBACK_SLUGS: ReadonlySet<string> = new Set([
  "budapest",
  "catalunya",
  "misano",
  "silverstone",
  "zandvoort",
]);

/** AC Evo layouts whose installed game data has no ideal line and explicitly reuses ACC. */
export function usesAccGeometryFallback(identity: TrackAssetIdentity, factsSlug: string | null): boolean {
  return identity.gameId === "ac-evo" && factsSlug !== null && AC_EVO_ACC_FALLBACK_SLUGS.has(factsSlug);
}

/**
 * ACC ordinals 0–10 are original 2019 source layouts; 11–21 are their
 * 2023 aliases in identical order. All 22 resolve to 11 root shared assets.
 */
const ACC_SHARED_SOURCE_ORDINAL: Readonly<Record<number, number>> = {
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10,
  11: 0, 12: 1, 13: 2, 14: 3, 15: 4, 16: 5, 17: 6, 18: 7, 19: 8, 20: 9, 21: 10,
};

/** Whether ACC assignment uses one of the 11 shared 2019 source assets. */
export function isSharedAccGeometryAsset(identity: TrackAssetIdentity): boolean {
  return identity.gameId === "acc" && ACC_SHARED_SOURCE_ORDINAL[identity.ordinal] !== undefined;
}

/** Canonical shared ACC source slug for one of the 22 paired assignments. */
export function sharedAccGeometrySlug(identity: TrackAssetIdentity): string | null {
  if (identity.gameId !== "acc") return null;
  const sourceOrdinal = ACC_SHARED_SOURCE_ORDINAL[identity.ordinal];
  return sourceOrdinal === undefined ? null : getAccSharedTrackName(sourceOrdinal) ?? null;
}

/** Canonical bundled geometry path for one game-specific track layout. */
export function bundledGeometryPath(identity: TrackAssetIdentity, kind: GeometryAssetKind): string {
  return resolve(
    SHARED_DIR,
    "tracks",
    ...canonicalTrackAssetPathComponents(identity.venuePath, identity.layoutSlug),
    "geometry",
    identity.gameId,
    `${kind}.${kind === "boundaries" ? "json" : "csv"}`,
  );
}

/** Canonical root-venue path for shared ACC or TUMFTM geometry. */
export function bundledSharedGeometryPath(
  identity: TrackAssetIdentity,
  source: SharedGeometrySource,
  slug: string,
  kind: GeometryAssetKind,
): string | null {
  if (source === "tumftm" && kind === "raceline") return null;
  const { rootVenuePath } = parseVenueRevisionPath(identity.venuePath);
  if (!rootVenuePath || !slug) return null;
  return resolve(
    SHARED_DIR,
    "tracks",
    "venues",
    rootVenuePath,
    "geometry",
    source,
    `${slug}-${kind}.${kind === "boundaries" ? "json" : "csv"}`,
  );
}
