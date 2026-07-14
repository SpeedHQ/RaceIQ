/**
 * Regenerate test/fixtures/expected-turn-counts.json from the current corner
 * detector. Run after an INTENTIONAL detector change, then review the diff
 * (and the SVGs in test/e2e/output/track-segments*) before committing — the
 * file is the accuracy baseline test/track-turn-counts.test.ts asserts
 * against, so accepting a diff without eyeballing it defeats the test.
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { detectCornerRegions } from "../shared/track-segment-align";
import { listAllCenterlines, loadCenterline } from "../shared/track-segment-generate";

const OUT = resolve(import.meta.dir, "..", "test", "fixtures", "expected-turn-counts.json");

const counts: Record<string, number> = {};
for (const { gameId, slug, file } of listAllCenterlines()) {
  const outline = loadCenterline(file);
  if (!outline) continue;
  counts[`${gameId}/${slug}`] = detectCornerRegions(outline).corners.length;
}

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${Object.keys(sorted).length} entries to ${OUT}`);
