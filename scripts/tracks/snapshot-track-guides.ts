/**
 * ONE-SHOT migration tool — delete once the track-guide JSON migration lands.
 *
 * Captures the exact output of every public entry point in
 * server/ai/track-guides.ts, before guides moved beside canonical track metadata
 * as `guide.json`. Historical golden output proves that migration byte-faithful,
 * including prompt text pinned by AI eval baselines.
 *
 * Usage:
 *   bun scripts/tracks/snapshot-track-guides.ts > test/fixtures/track-guide-context.golden.json
 */

import { buildTrackGuideContext, getAvailableTrackGuides, getTrackGuide, guideCornerLabels } from "../../server/ai/track-guides";

/**
 * Aliases that exercise TRACK_KEYWORDS ordering rather than a direct id hit.
 * The order-sensitive pairs matter most: "nordschleife" must not fall through to
 * "nurburgring", and "fuji speedway" must not collide with Forza's fantasy
 * Fujimi Kaido. Kept alongside the per-slug capture so a reordering of the
 * keyword table fails the golden test loudly.
 */
const ALIAS_PROBES = [
  "nordschleife",
  "nurburgring",
  "Nurburgring Nordschleife",
  "fuji speedway",
  "fujimi kaido",
  "Spa-Francorchamps",
  "Circuit de Spa-Francorchamps",
  "mount panorama",
  "bathurst",
  "cota",
  "austin",
  "mexico city",
  "interlagos",
  "Silverstone Grand Prix Circuit",
  "not a real track at all",
];

const slugs = getAvailableTrackGuides();

const bySlug: Record<string, unknown> = {};
for (const slug of slugs) {
  bySlug[slug] = {
    // The canonical path: server/routes/tracks/segments-routes.ts and the prompt builders
    // all pass the meta slug through.
    ctxWithSlug: buildTrackGuideContext(slug, { slug }),
    // The path mastra/tools/track-guide.ts and mastra/workflows/compare-analyse.ts
    // actually take today — they drop the slug, losing meta-canonical labels.
    // Pinned deliberately: fixing that later should show up as a fixture diff.
    ctxNoSlug: buildTrackGuideContext(slug),
    resolved: getTrackGuide(slug, { slug }),
    labels: guideCornerLabels(slug, { slug }),
    labelsNoSlug: guideCornerLabels(slug),
  };
}

const aliases: Record<string, unknown> = {};
for (const probe of ALIAS_PROBES) {
  aliases[probe] = {
    resolvedId: getTrackGuide(probe)?.id ?? null,
    ctx: buildTrackGuideContext(probe),
  };
}

process.stdout.write(`${JSON.stringify({ slugs, bySlug, aliases }, null, 2)}\n`);
