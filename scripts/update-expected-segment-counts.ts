/**
 * Regenerate test/fixtures/expected-segment-counts.json from the current
 * detector + alignment pipeline (corners AND straights, post name-alignment —
 * catches drift that detectCornerRegions alone can't, e.g. spurious slivers
 * introduced by the straight-gap-fill step). Run after an INTENTIONAL
 * detector/alignment change, then review the diff (and the SVGs in
 * test/e2e/output/track-segments) before committing — the file is the
 * baseline test/track-segment-counts.test.ts asserts against.
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { generateTrackSegments, listCuratedSlugs, loadCornerNameList } from "../shared/track-segment-generate";

const OUT = resolve(import.meta.dir, "..", "test", "fixtures", "expected-segment-counts.json");

const counts: Record<string, number> = {};
for (const slug of listCuratedSlugs()) {
  const nameList = loadCornerNameList(slug);
  if (!nameList) continue;
  const { aligned } = generateTrackSegments(slug, nameList);
  for (const a of aligned) {
    counts[`${a.gameId}/${slug}`] = a.segments.length;
  }
}

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${Object.keys(sorted).length} entries to ${OUT}`);
