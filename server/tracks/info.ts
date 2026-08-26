import type { NamedSegment } from "../../shared/racing/tracks/named-segments";
import type { TrackFacts } from "../../shared/racing/tracks/facts";
import type { TrackGeometry } from "../../shared/racing/tracks/geometry";
import type { TrackSectors } from "../../shared/racing/tracks/sectors";
import { getTrackSectorsByOrdinal } from "../../shared/racing/tracks/storage/sectors";
import { getTrackLengthMeters, getTrackOutlineByOrdinal } from "../../shared/racing/tracks/recording/outlines";
import { loadLabelledSegments, loadTrackFacts, loadTrackGeometry } from "../../shared/racing/tracks/storage/meta";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import { resolveTrackSharedName } from "./identity";

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
 * One lookup for everything about a track, given the two things a lap actually
 * carries: its game and its track ordinal.
 *
 * This exists because the resolution chain was open-coded at a dozen call sites
 * and the copies drifted. Two ways in particular:
 *
 * - Slug resolution asked two different registries. Both work once startup has
 *   run both `init` calls, but only because the server adapters supply the real
 *   implementations — every shared adapter returns `undefined` on its own, so a
 *   copy reaching for the shared registry silently resolves nothing.
 * - The sector fallback (`curated ?? bundled ?? thirds`) was retyped at five
 *   sites, each spelling the final default as a bare `1 / 3` and `2 / 3`. One of
 *   them disagreeing is invisible until sector times drift apart.
 *
 * `outline` and `lengthMeters` are getters rather than fields: they parse a
 * centerline CSV, and most callers only want names and fractions. Everything
 * else here is already cached by `shared/racing/tracks/geometry` and `shared/racing/tracks/storage`, so a call is cheap.
 */
export function resolveTrack(gameId: string | undefined, trackOrdinal: number | null | undefined): TrackInfo {
  const ordinal = trackOrdinal ?? null;
  const slug = gameId && ordinal != null ? resolveTrackSharedName(ordinal, gameId) : undefined;

  const facts = slug ? loadTrackFacts(slug) : null;
  const geometry = slug && gameId ? loadTrackGeometry(slug, gameId) : null;
  const segments = slug && gameId ? loadLabelledSegments(slug, gameId) : [];
  const sectors = geometry?.sectors ?? (ordinal != null ? getTrackSectorsByOrdinal(ordinal) : { s1End: 1 / 3, s2End: 2 / 3 });

  return {
    slug,
    name: facts?.name ?? (ordinal != null ? resolveTrackName(ordinal, gameId) : ""),
    facts,
    geometry,
    segments,
    sectors,
    get outline() {
      return gameId && ordinal != null ? getTrackOutlineByOrdinal(ordinal, gameId, slug) : null;
    },
    get lengthMeters() {
      return gameId && ordinal != null ? getTrackLengthMeters(ordinal, gameId, slug) : null;
    },
  };
}
