import type { GameId } from "../../../games/ids";
import { TRACK_GAME_ORDER } from "./source";
import type { TrackRegistryProjectionSnapshot } from "./projection";
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
/** Render deterministic JSON report from generated registry snapshot. */
export function renderTrackRegistryReport(snapshot: TrackRegistryProjectionSnapshot): string {
  const layoutById = new Map(snapshot.layouts.map((layout) => [layout.canonical_id, layout]));
  const factsBySlug = new Map(snapshot.facts.map((fact) => [fact.slug, fact]));

  const cornersByFacts = new Map<string, typeof snapshot.corners>();
  for (const corner of snapshot.corners) {
    const existing = cornersByFacts.get(corner.facts_slug) ?? [];
    existing.push(corner);
    cornersByFacts.set(corner.facts_slug, existing);
  }

  const coversByKey = new Map<string, number[]>();
  for (const cover of snapshot.covers) {
    const key = `${cover.facts_slug}\0${cover.corner_sequence}`;
    const numbers = coversByKey.get(key) ?? [];
    numbers.push(cover.turn_number);
    coversByKey.set(key, numbers);
  }

  const straightsByFacts = new Map<string, typeof snapshot.straights>();
  for (const straight of snapshot.straights) {
    const existing = straightsByFacts.get(straight.facts_slug) ?? [];
    existing.push(straight);
    straightsByFacts.set(straight.facts_slug, existing);
  }

  const factWithCoverage = Array.from(factsBySlug.values())
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((fact) => {
      const corners = (cornersByFacts.get(fact.slug) ?? []).map((corner) => ({
        sequence: corner.sequence,
        number: corner.turn_number,
        ...(coversByKey.get(`${fact.slug}\0${corner.sequence}`) && (coversByKey.get(`${fact.slug}\0${corner.sequence}`)?.length ?? 0) > 0
          ? { covers: coversByKey.get(`${fact.slug}\0${corner.sequence}`)?.sort((a, b) => a - b) }
          : {}),
        name: corner.name,
        ...(corner.direction ? { direction: corner.direction } : {}),
        ...(corner.group_name ? { group: corner.group_name } : {}),
      }));

      const straights = (straightsByFacts.get(fact.slug) ?? []).map((straight) => ({
        after: straight.after_turn,
        name: straight.name,
        ...(straight.group_name ? { group: straight.group_name } : {}),
      }));

      return {
        slug: fact.slug,
        track: fact.track_slug,
        layout: fact.layout_slug,
        layoutName: fact.layout_name,
        name: fact.name,
        ...(fact.source ? { source: fact.source } : {}),
        corners: corners,
        ...(straights.length ? { straights } : {}),
      };
    });

  const assignmentsByGameOrder = [...snapshot.assignments].sort((a, b) => {
    const byGame = (TRACK_GAME_ORDER[a.game_id] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.game_id] ?? Number.MAX_SAFE_INTEGER);
    return byGame !== 0 ? byGame : a.track_ordinal - b.track_ordinal;
  });

  const trackIdentities = assignmentsByGameOrder.map((assignment) => {
    const layout = layoutById.get(assignment.layout_id);
    return {
      gameId: assignment.game_id,
      trackOrdinal: assignment.track_ordinal,
      layoutId: assignment.layout_id,
      factsSlug: layout?.facts_slug ?? null,
    };
  });

  const geometrySectors = [...snapshot.geometry]
    .sort((a, b) => {
      const byGame = (TRACK_GAME_ORDER[a.game_id] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.game_id] ?? Number.MAX_SAFE_INTEGER);
      return byGame !== 0 ? byGame : a.facts_slug.localeCompare(b.facts_slug);
    })
    .map((row) => ({
      gameId: row.game_id,
      factsSlug: row.facts_slug,
      s1End: row.sector_1_end,
      s2End: row.sector_2_end,
      source: row.sector_source,
    }));

  const assignmentsByLayout = new Map<string, Array<{ gameId: GameId; trackOrdinal: number }>>();
  for (const identity of trackIdentities) {
    const existing = assignmentsByLayout.get(identity.layoutId) ?? [];
    existing.push({ gameId: identity.gameId, trackOrdinal: identity.trackOrdinal });
    assignmentsByLayout.set(identity.layoutId, existing);
  }

  const aliases = Array.from(assignmentsByLayout.entries())
    .filter(([, assignments]) => assignments.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([layoutId, assignments]) => {
      const layout = layoutById.get(layoutId);
      const ordered = assignments
        .map((assignment) => ({
          gameId: assignment.gameId,
          trackOrdinal: assignment.trackOrdinal,
        }))
        .sort((a, b) => (TRACK_GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER));
      return {
        layoutId,
        factsSlug: layout?.facts_slug ?? null,
        assignments: ordered,
      };
    });

  const layoutFactsRefs = new Set(layoutsHasFacts(snapshot.layouts));
  const layoutWithoutFacts = [...layoutFactsRefs]
    .filter((value) => value[1] === null)
    .map(([id]) => id)
    .sort();

  const factsWithoutLayouts = [...factsBySlug.keys()].filter((slug) => !snapshot.layouts.some((layout) => layout.facts_slug === slug)).sort();

  const assignmentOrphans: Array<{ gameId: string; trackOrdinal: number; layoutId: string }> = [];
  for (const assignment of assignmentsByGameOrder) {
    if (!layoutById.has(assignment.layout_id)) {
      assignmentOrphans.push({
        gameId: assignment.game_id,
        trackOrdinal: assignment.track_ordinal,
        layoutId: assignment.layout_id,
      });
    }
  }

  const geometrySet = new Set(snapshot.geometry.map((row) => `${row.facts_slug}\0${row.game_id}`));
  const geometryOrphans: Array<{ gameId: string; factsSlug: string }> = [];
  for (const row of snapshot.geometry) {
    if (!factsBySlug.has(row.facts_slug)) {
      geometryOrphans.push({ gameId: row.game_id, factsSlug: row.facts_slug });
    }
  }

  const verificationOrphans: Array<{ kind: string; gameId: string; factsSlug: string }> = [];
  for (const row of snapshot.verification) {
    if (row.kind === "meta") {
      if (!factsBySlug.has(row.facts_slug)) {
        verificationOrphans.push({ kind: "meta", gameId: row.game_id, factsSlug: row.facts_slug });
      }
      continue;
    }
    const hasTarget = geometrySet.has(`${row.facts_slug}\0${row.game_id}`);
    if (!hasTarget) {
      verificationOrphans.push({ kind: "segments", gameId: row.game_id, factsSlug: row.facts_slug });
    }
  }

  const report = {
    sourceVersion: snapshot.sourceVersion,
    sourceHash: snapshot.sourceHash,
    recordCounts: {
      venues: snapshot.venueNodes.length,
      layouts: snapshot.layouts.length,
      assignments: snapshot.assignments.length,
      facts: snapshot.facts.length,
      corners: snapshot.corners.length,
      covers: snapshot.covers.length,
      straights: snapshot.straights.length,
      geometry: snapshot.geometry.length,
      geometrySegments: snapshot.segments.length,
      verification: snapshot.verification.length,
    },
    trackIdentities,
    geometrySectors,
    facts: factWithCoverage,
    aliases,
    orphanedReferences: {
      assignments: assignmentOrphans,
      geometry: geometryOrphans,
      verification: verificationOrphans,
    },
    unlinked: {
      layoutsWithoutFacts: layoutWithoutFacts,
      factsWithoutLayouts,
    },
  };

  return `${JSON.stringify(report, null, 2)}\n`;
}
function layoutsHasFacts(layouts: TrackRegistryProjectionSnapshot["layouts"]): Map<string, string | null> {
  return new Map(layouts.map((layout) => [layout.canonical_id, layout.facts_slug]));
}
