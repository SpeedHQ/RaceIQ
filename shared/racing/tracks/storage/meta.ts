import { GameIdSchema, type GameId } from "../../../games/ids";
import { getTrackRegistry, getTrackRegistryRevision } from "../registry";
import type { TrackRegistrySource } from "../registry/source";
import { updateTrackRegistrySource } from "../registry/update";
import { joinSegments } from "../curation/join";
import type { CornerFact, StraightFact, TrackFacts } from "../facts";
import type { TrackGeometry } from "../geometry";
import type { NamedSegment } from "../named-segments";
import type { TrackSectors } from "../sectors";

/**
 * Games that reuse another game's curated geometry when they ship none of
 * their own. AC Evo and ACC use the same Kunos track meshes. iRacing's
 * `commonTrackName` entries are deliberately limited to exact physical
 * layouts, so normalized LapDistPct can use the first curated geometry
 * RaceIQ has for that layout while retaining shared real-world names.
 */
const GEOMETRY_FALLBACKS: Record<string, string[]> = {
  "ac-evo": ["acc"],
  iracing: ["fm-2023", "f1-2025", "acc", "ac-evo"],
};

const factsCache = new Map<string, TrackFacts | null>();
const geometryCache = new Map<string, TrackGeometry | null>();
let cacheRevision = -1;

function refreshCachesForRegistryRevision(): void {
  const revision = getTrackRegistryRevision();
  if (revision === cacheRevision) return;
  factsCache.clear();
  geometryCache.clear();
  cacheRevision = revision;
}

interface FactsRow {
  slug: string;
  track: string;
  layout: string;
  layoutName: string;
  name: string;
  source: string | null;
}

interface CornerRow {
  sequence: number;
  number: number;
  name: string;
  direction: "left" | "right" | null;
  group: string | null;
}

interface CoverRow {
  cornerSequence: number;
  number: number;
}

interface StraightRow {
  after: number;
  name: string;
  group: string | null;
}

interface GeometryRow {
  s1End: number | null;
  s2End: number | null;
  source: string | null;
}

interface SegmentRow {
  key: string;
  startFrac: number;
  endFrac: number;
}

export function listTrackFactSlugs(): string[] {
  refreshCachesForRegistryRevision();
  const rows = getTrackRegistry().query("SELECT slug FROM track_facts ORDER BY slug").all() as Array<{ slug: string }>;
  return rows.map(({ slug }) => slug);
}

/** Load game-agnostic turn names, numbers, groups, and straights for one layout. */
export function loadTrackFacts(slug: string): TrackFacts | null {
  refreshCachesForRegistryRevision();
  if (!slug) return null;
  const hit = factsCache.get(slug);
  if (hit !== undefined) return hit;

  const database = getTrackRegistry();
  const row = database
    .query(`
    SELECT slug, track_slug AS track, layout_slug AS layout, layout_name AS layoutName, name, source
      FROM track_facts WHERE slug = ?
  `)
    .get(slug) as FactsRow | null;
  if (!row) {
    factsCache.set(slug, null);
    return null;
  }
  const cornerRows = database
    .query(`
    SELECT sequence, turn_number AS number, name, direction, group_name AS "group"
      FROM track_corners WHERE facts_slug = ? ORDER BY sequence
  `)
    .all(slug) as CornerRow[];
  const coverRows = database
    .query(`
    SELECT corner_sequence AS cornerSequence, turn_number AS number
      FROM track_corner_covers WHERE facts_slug = ? ORDER BY corner_sequence, turn_number
  `)
    .all(slug) as CoverRow[];
  const covers = new Map<number, number[]>();
  for (const cover of coverRows) {
    const numbers = covers.get(cover.cornerSequence) ?? [];
    numbers.push(cover.number);
    covers.set(cover.cornerSequence, numbers);
  }
  const corners: CornerFact[] = cornerRows.map((corner) => ({
    number: corner.number,
    ...(covers.has(corner.sequence) ? { covers: covers.get(corner.sequence) } : {}),
    name: corner.name,
    ...(corner.direction ? { direction: corner.direction } : {}),
    ...(corner.group ? { group: corner.group } : {}),
  }));
  const straightRows = database
    .query(`
    SELECT after_turn AS "after", name, group_name AS "group"
      FROM track_straights WHERE facts_slug = ? ORDER BY after_turn
  `)
    .all(slug) as StraightRow[];
  const straights: StraightFact[] = straightRows.map((straight) => ({
    after: straight.after,
    name: straight.name,
    ...(straight.group ? { group: straight.group } : {}),
  }));
  const facts: TrackFacts = {
    slug: row.slug,
    track: row.track,
    layout: row.layout,
    layoutName: row.layoutName,
    name: row.name,
    ...(row.source ? { source: row.source } : {}),
    corners,
    ...(straights.length ? { straights } : {}),
  };
  factsCache.set(slug, facts);
  return facts;
}

export function loadTrackGeometryForGame(slug: string, gameId: string): TrackGeometry | null {
  refreshCachesForRegistryRevision();
  const database = getTrackRegistry();
  const row = database
    .query(`
    SELECT sector_1_end AS s1End, sector_2_end AS s2End, sector_source AS source
      FROM game_geometry WHERE facts_slug = ? AND game_id = ?
  `)
    .get(slug, gameId) as GeometryRow | null;
  if (!row) return null;
  const segmentRows = database
    .query(`
    SELECT segment_key AS "key", start_fraction AS startFrac, end_fraction AS endFrac
      FROM game_geometry_segments WHERE facts_slug = ? AND game_id = ? ORDER BY sequence
  `)
    .all(slug, gameId) as SegmentRow[];
  return {
    ...(row.s1End !== null && row.s2End !== null ? { sectors: { s1End: row.s1End, s2End: row.s2End, ...(row.source ? { source: row.source } : {}) } } : {}),
    segments: segmentRows,
  };
}

/** Load one game's segment fractions for a layout, falling back when compatible. */
export function loadTrackGeometry(slug: string, gameId: string): TrackGeometry | null {
  refreshCachesForRegistryRevision();
  if (!slug || !gameId) return null;
  const cacheKey = `${gameId}:${slug}`;
  const hit = geometryCache.get(cacheKey);
  if (hit !== undefined) return hit;

  let geometry: TrackGeometry | null = null;
  for (const candidate of [gameId, ...(GEOMETRY_FALLBACKS[gameId] ?? [])]) {
    geometry = loadTrackGeometryForGame(slug, candidate);
    if (geometry) break;
  }
  geometryCache.set(cacheKey, geometry);
  return geometry;
}

/** Join shared corner names with one game's fractional segment ranges. */
export function loadLabelledSegments(slug: string, gameId: string): NamedSegment[] {
  const facts = loadTrackFacts(slug);
  const geometry = loadTrackGeometry(slug, gameId);
  if (!facts || !geometry) return [];
  return joinSegments(facts, geometry);
}

/** Sector boundaries for a layout in one game's lap fractions. */
export function loadTrackSectorsFor(slug: string, gameId: string): (TrackSectors & { source?: string }) | undefined {
  return loadTrackGeometry(slug, gameId)?.sectors;
}

function upsertFactsSource(draft: TrackRegistrySource, facts: TrackFacts): void {
  const index = draft.facts.facts.findIndex((entry) => entry.slug === facts.slug);
  if (index >= 0) draft.facts.facts[index] = facts;
  else draft.facts.facts.push(facts);
}

function upsertGeometrySource(draft: TrackRegistrySource, slug: string, gameId: GameId, geometry: TrackGeometry): void {
  const row = { factsSlug: slug, gameId, ...geometry };
  const index = draft.geometry.geometry.findIndex((entry) => entry.factsSlug === slug && entry.gameId === gameId);
  if (index >= 0) draft.geometry.geometry[index] = row;
  else draft.geometry.geometry.push(row);
}

/** Persist one layout's shared names and turn roster through canonical source. */
export function saveTrackFacts(slug: string, facts: TrackFacts): void {
  if (!slug) throw new Error("saveTrackFacts: slug required");
  if (facts.slug !== slug) throw new Error(`saveTrackFacts: identity mismatch ${facts.slug} !== ${slug}`);
  updateTrackRegistrySource((draft) => {
    upsertFactsSource(draft, facts);
  });
}

/** Persist one game's fractional segment ranges and sector boundaries through canonical source. */
export function saveTrackGeometry(slug: string, gameId: string, geometry: TrackGeometry): void {
  if (!slug || !gameId) throw new Error("saveTrackGeometry: slug and gameId required");
  const parsedGameId = GameIdSchema.parse(gameId);
  updateTrackRegistrySource((draft) => {
    upsertGeometrySource(draft, slug, parsedGameId, geometry);
  });
}

export interface TrackMetadataBinding {
  gameId: GameId;
  trackOrdinal: number;
}

/** Persist paired shared facts and selected native game geometry in one source transaction. */
export function saveTrackMetadata(slug: string, facts: TrackFacts, geometryByGame: Readonly<Record<string, TrackGeometry>>, binding?: TrackMetadataBinding): void {
  if (!slug) throw new Error("saveTrackMetadata: slug required");
  if (facts.slug !== slug) throw new Error(`saveTrackMetadata: identity mismatch ${facts.slug} !== ${slug}`);
  const geometry = Object.entries(geometryByGame).map(([gameId, value]) => ({
    gameId: GameIdSchema.parse(gameId),
    value,
  }));
  const parsedBinding = binding ? { gameId: GameIdSchema.parse(binding.gameId), trackOrdinal: binding.trackOrdinal } : null;
  updateTrackRegistrySource((draft) => {
    upsertFactsSource(draft, facts);
    for (const entry of geometry) upsertGeometrySource(draft, slug, entry.gameId, entry.value);
    if (!parsedBinding) return;
    const assignment = draft.configurations.assignments.find((entry) => entry.gameId === parsedBinding.gameId && entry.trackOrdinal === parsedBinding.trackOrdinal);
    if (!assignment) throw new Error(`Missing track assignment ${parsedBinding.gameId}/${parsedBinding.trackOrdinal}`);
    const layout = draft.configurations.layouts.find((entry) => entry.id === assignment.layoutId);
    if (!layout) throw new Error(`Missing track layout ${assignment.layoutId}`);
    layout.factsSlug = slug;
  });
}
