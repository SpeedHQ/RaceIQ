import type { GameId } from "../../../games/ids";
import type { TrackRegistryReadModel } from "./read-model";
import { TRACK_GAME_ORDER } from "./source";

/** Human-reviewable registry summary, aliases, coverage, and orphan diagnostics. */
export interface TrackRegistryReport {
  sourceVersion: number;
  sourceHash: string;
  recordCounts: {
    venues: number;
    layouts: number;
    assignments: number;
    facts: number;
    corners: number;
    covers: number;
    straights: number;
    geometry: number;
    geometrySegments: number;
    verification: number;
  };
  trackIdentities: Array<{
    gameId: GameId;
    trackOrdinal: number;
    layoutId: string;
    factsSlug: string | null;
  }>;
  geometrySectors: Array<{
    gameId: GameId;
    factsSlug: string;
    s1End: number | null;
    s2End: number | null;
    source: string | null;
  }>;
  facts: Array<{
    slug: string;
    track: string;
    layout: string;
    layoutName: string;
    name: string;
    source?: string;
    corners: Array<{
      sequence: number;
      number: number;
      covers?: number[];
      name: string;
      direction?: "left" | "right";
      group?: string;
    }>;
    straights?: Array<{
      after: number;
      name: string;
      group?: string;
    }>;
  }>;
  aliases: Array<{
    layoutId: string;
    factsSlug: string | null;
    assignments: Array<{
      gameId: GameId;
      trackOrdinal: number;
    }>;
  }>;
  orphanedReferences: {
    assignments: Array<{ gameId: string; trackOrdinal: number; layoutId: string }>;
    geometry: Array<{ gameId: string; factsSlug: string }>;
    verification: Array<{ kind: string; gameId: string; factsSlug: string }>;
  };
  unlinked: {
    layoutsWithoutFacts: string[];
    factsWithoutLayouts: string[];
  };
}

/** Render deterministic JSON report from generated registry read model. */
export function renderTrackRegistryReport(registry: TrackRegistryReadModel): string {
  const layoutById = new Map(registry.layouts.map((layout) => [layout.id, layout]));
  const factsBySlug = new Map(registry.facts.map((fact) => [fact.slug, fact]));
  const assignments = [...registry.assignments].sort((a, b) => {
    const byGame = (TRACK_GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER);
    return byGame !== 0 ? byGame : a.trackOrdinal - b.trackOrdinal;
  });

  const trackIdentities = assignments.map((assignment) => ({
    gameId: assignment.gameId,
    trackOrdinal: assignment.trackOrdinal,
    layoutId: assignment.layoutId,
    factsSlug: layoutById.get(assignment.layoutId)?.factsSlug ?? null,
  }));
  const geometrySectors = [...registry.geometry]
    .sort((a, b) => {
      const byGame = (TRACK_GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER);
      return byGame !== 0 ? byGame : a.factsSlug.localeCompare(b.factsSlug);
    })
    .map((row) => ({
      gameId: row.gameId,
      factsSlug: row.factsSlug,
      s1End: row.sectors?.s1End ?? null,
      s2End: row.sectors?.s2End ?? null,
      source: row.sectors?.source ?? null,
    }));

  const assignmentsByLayout = new Map<string, Array<{ gameId: GameId; trackOrdinal: number }>>();
  for (const identity of trackIdentities) {
    const existing = assignmentsByLayout.get(identity.layoutId) ?? [];
    existing.push({ gameId: identity.gameId, trackOrdinal: identity.trackOrdinal });
    assignmentsByLayout.set(identity.layoutId, existing);
  }
  const aliases = Array.from(assignmentsByLayout.entries())
    .filter(([, values]) => values.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([layoutId, values]) => ({
      layoutId,
      factsSlug: layoutById.get(layoutId)?.factsSlug ?? null,
      assignments: values.sort((a, b) => {
        const byGame = (TRACK_GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER);
        return byGame !== 0 ? byGame : a.trackOrdinal - b.trackOrdinal;
      }),
    }));

  const assignmentOrphans = assignments
    .filter((assignment) => !layoutById.has(assignment.layoutId))
    .map((assignment) => ({ gameId: assignment.gameId, trackOrdinal: assignment.trackOrdinal, layoutId: assignment.layoutId }));
  const geometryOrphans = registry.geometry
    .filter((row) => !factsBySlug.has(row.factsSlug))
    .map((row) => ({ gameId: row.gameId, factsSlug: row.factsSlug }));
  const geometryKeys = new Set(registry.geometry.map((row) => `${row.factsSlug}\0${row.gameId}`));
  const verificationOrphans: Array<{ kind: string; gameId: string; factsSlug: string }> = [];
  for (const key of Object.keys(registry.verification)) {
    const meta = /^meta:(.+)$/.exec(key);
    const segments = /^segments:([^/]+)\/(.+)$/.exec(key);
    if (meta && !factsBySlug.has(meta[1]!)) {
      verificationOrphans.push({ kind: "meta", gameId: "", factsSlug: meta[1]! });
    } else if (segments && !geometryKeys.has(`${segments[2]}\0${segments[1]}`)) {
      verificationOrphans.push({ kind: "segments", gameId: segments[1]!, factsSlug: segments[2]! });
    }
  }

  const report: TrackRegistryReport = {
    sourceVersion: registry.sourceVersion,
    sourceHash: registry.sourceHash,
    recordCounts: {
      venues: registry.venues.length,
      layouts: registry.layouts.length,
      assignments: registry.assignments.length,
      facts: registry.facts.length,
      corners: registry.facts.reduce((count, fact) => count + fact.corners.length, 0),
      covers: registry.facts.reduce((count, fact) => count + fact.corners.reduce((factCount, corner) => factCount + (corner.covers?.length ?? 0), 0), 0),
      straights: registry.facts.reduce((count, fact) => count + (fact.straights?.length ?? 0), 0),
      geometry: registry.geometry.length,
      geometrySegments: registry.geometry.reduce((count, row) => count + row.segments.length, 0),
      verification: Object.keys(registry.verification).length,
    },
    trackIdentities,
    geometrySectors,
    facts: registry.facts.map((fact) => ({
      slug: fact.slug,
      track: fact.track,
      layout: fact.layout,
      layoutName: fact.layoutName,
      name: fact.name,
      ...(fact.source ? { source: fact.source } : {}),
      corners: fact.corners.map((corner, sequence) => ({ sequence, ...corner })),
      ...(fact.straights?.length ? { straights: fact.straights } : {}),
    })),
    aliases,
    orphanedReferences: {
      assignments: assignmentOrphans,
      geometry: geometryOrphans,
      verification: verificationOrphans,
    },
    unlinked: {
      layoutsWithoutFacts: registry.layouts.filter((layout) => !layout.factsSlug).map((layout) => layout.id),
      factsWithoutLayouts: [...factsBySlug.keys()].filter((slug) => !registry.layouts.some((layout) => layout.factsSlug === slug)).sort(),
    },
  };

  return `${JSON.stringify(report, null, 2)}\n`;
}
