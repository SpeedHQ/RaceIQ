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

export function resolveTrackContext(gameId: GameId | undefined, trackOrdinal: number | null | undefined): TrackContext {
  if (!gameId || trackOrdinal == null) return {};
  const slug = tryGetServerGame(gameId)?.getSharedTrackName?.(trackOrdinal);
  if (!slug) return {};
  const meta = loadSharedTrackMeta(slug);
  if (!meta) return { slug };
  const perGame = meta.games?.[gameId];
  return {
    slug,
    segments: perGame?.segments ?? meta.segments,
    sectors: perGame?.sectors ?? meta.sectors,
  };
}
