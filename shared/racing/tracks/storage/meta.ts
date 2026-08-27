import { GameIdSchema, type GameId } from "../../../games/ids";
import { getTrackRegistry, getTrackRegistryIndexes } from "../registry";
import type { TrackRegistrySource } from "../registry/source";
import { updateTrackRegistrySource } from "../registry/update";
import { joinSegments } from "../curation/join";
import type { TrackFacts } from "../facts";
import type { TrackGeometry } from "../geometry";
import type { NamedSegment } from "../named-segments";
import type { TrackSectors } from "../sectors";

/**
 * Games that reuse another game's curated geometry when they ship none of
 * their own. Native/source-defined geometry remains first priority.
 */
const GEOMETRY_FALLBACKS: Record<string, GameId[]> = {
  "ac-evo": ["acc"],
  iracing: ["fm-2023", "f1-2025", "acc", "ac-evo"],
};

export function listTrackFactSlugs(): string[] {
  return getTrackRegistry().facts.map(({ slug }) => slug);
}

/** Load game-agnostic turn names, numbers, groups, and straights for one layout. */
export function loadTrackFacts(slug: string): TrackFacts | null {
  if (!slug) return null;
  return getTrackRegistryIndexes().factsBySlug.get(slug) ?? null;
}

export function loadTrackGeometryForGame(slug: string, gameId: string): TrackGeometry | null {
  const parsedGameId = GameIdSchema.safeParse(gameId);
  if (!slug || !parsedGameId.success) return null;
  const row = getTrackRegistryIndexes().geometryByFactsSlug.get(slug)?.get(parsedGameId.data);
  if (!row) return null;
  return {
    ...(row.sectors ? { sectors: row.sectors } : {}),
    segments: row.segments,
  };
}

/** Load one game's segment fractions for a layout, falling back when compatible. */
export function loadTrackGeometry(slug: string, gameId: string): TrackGeometry | null {
  const parsedGameId = GameIdSchema.safeParse(gameId);
  if (!slug || !parsedGameId.success) return null;
  for (const candidate of [parsedGameId.data, ...(GEOMETRY_FALLBACKS[parsedGameId.data] ?? [])]) {
    const geometry = loadTrackGeometryForGame(slug, candidate);
    if (geometry) return geometry;
  }
  return null;
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
