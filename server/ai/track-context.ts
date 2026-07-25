/**
 * Resolves a lap's curated track data (#84) for the AI prompts.
 *
 * Both the analyst and compare routes need the same three things — the meta
 * slug, the labelled segments, and the sector boundaries. Classification
 * (names, numbers, groups) is shared per layout and resolved by slug alone;
 * only the lap fractions are per-game, because each game's centerline places
 * the same corner at its own point around the lap.
 */
import type { GameId } from "../../shared/types";
import type { NamedSegment } from "../../shared/track-named-segments";
import { loadLabelledSegments, loadTrackSectorsFor, type TrackSectors } from "../../shared/track-data";
import { tryGetServerGame } from "../games/registry";

export interface TrackContext {
  /** Meta filename, e.g. "spa". Undefined when the game can't resolve one. */
  slug?: string;
  /** Named corners/straights in this game's lap fractions. Carries `numbers`. */
  segments?: NamedSegment[];
  /** Sector boundaries as lap fractions in this game's geometry. */
  sectors?: TrackSectors;
}

export function resolveTrackContext(gameId: GameId | undefined, trackOrdinal: number | null | undefined): TrackContext {
  if (!gameId || trackOrdinal == null) return {};
  const slug = tryGetServerGame(gameId)?.getSharedTrackName?.(trackOrdinal);
  if (!slug) return {};
  return {
    slug,
    segments: loadLabelledSegments(slug, gameId),
    sectors: loadTrackSectorsFor(slug, gameId),
  };
}
