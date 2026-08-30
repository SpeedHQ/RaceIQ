import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { IS_COMPILED } from "@shared/platform/runtime/data-paths";
import type { GameId } from "../../games/ids";
import { readTrackRegistryReadModel, TRACK_REGISTRY_VERSION, type TrackRegistryReadModel } from "./registry/read-model";
import { readTrackRegistrySourceFiles, resolveTrackRegistryLocations } from "./registry/source";

export { TRACK_REGISTRY_VERSION } from "./registry/read-model";
export type { TrackRegistryReadModel } from "./registry/read-model";

type TrackRegistryVenue = TrackRegistryReadModel["venues"][number];
type TrackRegistryLayout = TrackRegistryReadModel["layouts"][number];
type TrackRegistryAssignment = TrackRegistryReadModel["assignments"][number];
type TrackRegistryFact = TrackRegistryReadModel["facts"][number];
type TrackRegistryGeometry = TrackRegistryReadModel["geometry"][number];

/** Derived indexes over compact registry arrays; built once per loaded artifact. */
export interface TrackRegistryIndexes {
  venuesById: ReadonlyMap<string, TrackRegistryVenue>;
  layoutsById: ReadonlyMap<string, TrackRegistryLayout>;
  layoutsByFactsSlug: ReadonlyMap<string, readonly TrackRegistryLayout[]>;
  assignmentsByGame: ReadonlyMap<GameId, ReadonlyMap<number, TrackRegistryAssignment>>;
  assignmentsByLayoutId: ReadonlyMap<string, readonly TrackRegistryAssignment[]>;
  factsBySlug: ReadonlyMap<string, TrackRegistryFact>;
  geometryByFactsSlug: ReadonlyMap<string, ReadonlyMap<GameId, TrackRegistryGeometry>>;
}

/** Runtime path to bundled generated track registry. */
export const TRACK_REGISTRY_PATH = resolveTrackRegistryLocations().registryPath;

let registry: TrackRegistryReadModel | null = null;
let indexes: TrackRegistryIndexes | null = null;

function actualSourceHash(sourceDirectory: string): string {
  const hash = createHash("sha256");
  for (const [filename, body] of readTrackRegistrySourceFiles({ sourceDirectory })) {
    hash.update(filename);
    hash.update("\0");
    hash.update(body);
  }
  return hash.digest("hex");
}

/** Load validated generated registry once and retain it in memory. */
export function getTrackRegistry(): TrackRegistryReadModel {
  if (registry) return registry;

  const locations = resolveTrackRegistryLocations();
  if (!IS_COMPILED && existsSync(locations.transactionPath)) {
    throw new Error(`Pending track registry source update ${locations.transactionPath}; run bun run tracks:registry`);
  }
  const loaded = readTrackRegistryReadModel(TRACK_REGISTRY_PATH);
  if (loaded.version !== TRACK_REGISTRY_VERSION) {
    throw new Error(`Unsupported track registry version ${loaded.version}; expected ${TRACK_REGISTRY_VERSION}`);
  }
  if (!IS_COMPILED && actualSourceHash(locations.sourceDirectory) !== loaded.sourceHash) {
    throw new Error("Stale generated track registry; run bun run tracks:registry");
  }
  registry = loaded;
  return registry;
}

/** Return shared lookup indexes without duplicating SQL-era joins in consumers. */
export function getTrackRegistryIndexes(): TrackRegistryIndexes {
  if (indexes) return indexes;
  const loaded = getTrackRegistry();
  const venuesById = new Map(loaded.venues.map((venue) => [venue.id, venue]));
  const layoutsById = new Map(loaded.layouts.map((layout) => [layout.id, layout]));
  const layoutsByFactsSlug = new Map<string, TrackRegistryLayout[]>();
  const assignmentsByGame = new Map<GameId, Map<number, TrackRegistryAssignment>>();
  const assignmentsByLayoutId = new Map<string, TrackRegistryAssignment[]>();
  const factsBySlug = new Map(loaded.facts.map((fact) => [fact.slug, fact]));
  const geometryByFactsSlug = new Map<string, Map<GameId, TrackRegistryGeometry>>();

  for (const layout of loaded.layouts) {
    if (!layout.factsSlug) continue;
    const values = layoutsByFactsSlug.get(layout.factsSlug) ?? [];
    values.push(layout);
    layoutsByFactsSlug.set(layout.factsSlug, values);
  }
  for (const assignment of loaded.assignments) {
    const byOrdinal = assignmentsByGame.get(assignment.gameId) ?? new Map<number, TrackRegistryAssignment>();
    byOrdinal.set(assignment.trackOrdinal, assignment);
    assignmentsByGame.set(assignment.gameId, byOrdinal);
    const byLayout = assignmentsByLayoutId.get(assignment.layoutId) ?? [];
    byLayout.push(assignment);
    assignmentsByLayoutId.set(assignment.layoutId, byLayout);
  }
  for (const geometry of loaded.geometry) {
    const byGame = geometryByFactsSlug.get(geometry.factsSlug) ?? new Map<GameId, TrackRegistryGeometry>();
    byGame.set(geometry.gameId, geometry);
    geometryByFactsSlug.set(geometry.factsSlug, byGame);
  }

  indexes = {
    venuesById,
    layoutsById,
    layoutsByFactsSlug,
    assignmentsByGame,
    assignmentsByLayoutId,
    factsBySlug,
    geometryByFactsSlug,
  };
  return indexes;
}

/** Invalidate in-memory registry after development-time artifact replacement. */
export function invalidateTrackRegistry(): void {
  registry = null;
  indexes = null;
}
