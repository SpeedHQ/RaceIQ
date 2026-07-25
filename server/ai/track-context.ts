/**
 * Resolves a lap's curated track data (#84) for the AI prompts.
 *
 * Both the analyst and compare routes need the same three things — the meta
 * slug, the named segments, and the sector boundaries — and each must be
 * game-specific: a game's centerline has its own lap fractions, so the shared
 * segment list places boundaries in the wrong place for any game whose
 * centerline differs from it. `games[gameId]` wins; the shared set is the
 * fallback for tracks curated once.
 */
import type { GameId } from "../../shared/types";
import type { NamedSegment } from "../../shared/track-named-segments";
import { loadSharedTrackMeta, type TrackSectors } from "../../shared/track-data";
import { tryGetServerGame } from "../games/registry";

export interface TrackContext {
  /** Meta filename, e.g. "spa". Undefined when the game can't resolve one. */
  slug?: string;
  /** Named corners/straights, game-specific where curated. Carries `numbers`. */
  segments?: NamedSegment[];
  /** Sector boundaries as lap fractions, game-specific where curated. */
  sectors?: TrackSectors;
}

/** Games that share another game's curated geometry when they have no block of
 *  their own. AC Evo and ACC ship the same Kunos track meshes, so an ACC
 *  override is correct for AC Evo — and closer than the shared/base set, which
 *  is curated against whichever centerline was digitised first. */
const GEOMETRY_ALIAS: Partial<Record<GameId, GameId>> = { "ac-evo": "acc" };

/**
 * Single resolution chain for curated per-track meta fields.
 *
 * Priority: `games[gameId]` → aliased game (`ac-evo` → `acc`) → shared/base.
 *
 * Every consumer must go through this. When the review dashboard resolved
 * segments without the alias while the track detail page resolved them with it,
 * the two views drew different corner fractions and turn numbers for the same
 * lap (AC Evo Imola: base 0.1546 vs ACC 0.1061 for Tamburello).
 */
export function resolveMetaField<K extends "segments" | "sectors">(
  meta: { games?: Record<string, { segments?: NamedSegment[]; sectors?: TrackSectors } | undefined>; segments?: NamedSegment[]; sectors?: TrackSectors } | null | undefined,
  gameId: GameId | undefined,
  field: K,
): (K extends "segments" ? NamedSegment[] : TrackSectors) | undefined {
  if (!meta) return undefined;
  const direct = gameId ? meta.games?.[gameId]?.[field] : undefined;
  if (direct != null) return direct as never;
  const alias = gameId ? GEOMETRY_ALIAS[gameId] : undefined;
  const aliased = alias ? meta.games?.[alias]?.[field] : undefined;
  if (aliased != null) return aliased as never;
  return meta[field] as never;
}

export function resolveTrackContext(gameId: GameId | undefined, trackOrdinal: number | null | undefined): TrackContext {
  if (!gameId || trackOrdinal == null) return {};
  const slug = tryGetServerGame(gameId)?.getSharedTrackName?.(trackOrdinal);
  if (!slug) return {};
  const meta = loadSharedTrackMeta(slug);
  if (!meta) return { slug };
  return {
    slug,
    segments: resolveMetaField(meta, gameId, "segments"),
    sectors: resolveMetaField(meta, gameId, "sectors"),
  };
}
