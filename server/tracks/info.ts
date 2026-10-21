import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import type { TrackFacts } from "@raceiq/shared/racing/tracks/facts";
import type { TrackGeometry } from "@raceiq/shared/racing/tracks/geometry";
import type { TrackSectors } from "@raceiq/shared/racing/tracks/sectors";
import { getTrackLengthMetersById, getTrackOutlineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import {
  loadLabelledSegments,
  loadTrackFacts,
  loadTrackGeometry,
} from "@raceiq/shared/racing/tracks/storage/meta";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { tryGetServerGame } from "../games/registry";

interface Point {
  x: number;
  z: number;
}

/** Everything known about one game's take on one track layout. */
interface TrackInfo {
  /** Meta slug naming the layout, e.g. `silverstone`. Undefined when the game can't resolve one. */
  slug?: string;
  /** Display name for the track. Always present — falls back to the game's own roster name. */
  name: string;
  /** Game-agnostic facts: turn numbers, names, groups, layout identity. */
  facts: TrackFacts | null;
  /** This game's fractions and sector boundaries. */
  geometry: TrackGeometry | null;
  /** Labelled segments — this game's fractions carrying the layout's shared names. `[]` when the game has no geometry. */
  segments: NamedSegment[];
  /** Sector boundaries, always resolved: curated for this game, else bundled, else thirds. */
  sectors: TrackSectors;
  /** Centerline points. Lazy — reads and parses a CSV, so only paid for when touched. */
  readonly outline: Point[] | null;
  /** Lap length in metres, or null when no outline exists. Lazy, same cost as `outline`. */
  readonly lengthMeters: number | null;
}

/**
 * Resolve everything known about one game's track from its string ID.
 * Numeric catalog IDs remain strings here; game/catalog adapters own any
 * protocol-boundary conversion required for metadata lookup.
 *
 * `outline` and `lengthMeters` are getters rather than fields: they parse a
 * centerline CSV, and most callers only want names and fractions. Everything
 * else here is already cached by `shared/racing/tracks/geometry` and `shared/racing/tracks/storage`, so a call is cheap.
 */
export function resolveTrack(gameId: string | undefined, trackId: string | null | undefined): TrackInfo {
  const id = trackId ?? null;
  const slug = gameId && id != null ? (tryGetServerGame(gameId)?.getSharedTrackName?.(id) ?? undefined) : undefined;

  const facts = slug ? loadTrackFacts(slug) : null;
  const geometry = slug && gameId ? loadTrackGeometry(slug, gameId) : null;
  const segments = slug && gameId ? loadLabelledSegments(slug, gameId) : [];
  const sectors = geometry?.sectors ?? { s1End: 1 / 3, s2End: 2 / 3 };

  return {
    slug,
    name: facts?.name ?? (id != null ? resolveTrackName(id, gameId) : ""),
    facts,
    geometry,
    segments,
    sectors,
    get outline() {
      return gameId && id != null ? getTrackOutlineById(id, gameId, slug) : null;
    },
    get lengthMeters() {
      return gameId && id != null ? getTrackLengthMetersById(id, gameId, slug) : null;
    },
  };
}
