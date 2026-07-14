/**
 * Full-lap segment-count baseline: every curated track/game combo must
 * produce exactly the expected number of aligned segments (corners AND
 * straights) recorded in test/fixtures/expected-segment-counts.json.
 *
 * Complements track-turn-counts.test.ts, which only covers raw corner
 * detection — this catches drift introduced downstream in alignSegments()
 * (padding, trim, straight-gap-fill), like a threshold tweak that shrinks
 * corners enough to spawn a spurious extra straight, or a sliver-absorption
 * change that silently swallows one.
 *
 * After an intentional detector/alignment change: bun run tracks:segment-counts,
 * review the diff + SVGs in test/e2e/output/track-segments, commit the fixture.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { generateTrackSegments, listCuratedSlugs, loadCornerNameList } from "../shared/track-segment-generate";

const expected: Record<string, number> = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures", "expected-segment-counts.json"), "utf-8"),
);

const slugs = listCuratedSlugs();

describe("segment count accuracy", () => {
  test("baseline covers every curated track/game combo", () => {
    const keys = new Set<string>();
    for (const slug of slugs) {
      const nameList = loadCornerNameList(slug)!;
      const { aligned } = generateTrackSegments(slug, nameList);
      for (const a of aligned) keys.add(`${a.gameId}/${slug}`);
    }
    const missing = [...keys].filter((k) => expected[k] === undefined);
    const stale = Object.keys(expected).filter((k) => !keys.has(k));
    expect(missing, `add to fixture via: bun run tracks:segment-counts — missing ${missing.join(", ")}`).toEqual([]);
    expect(stale, `stale fixture entries: ${stale.join(", ")}`).toEqual([]);
  });

  for (const slug of slugs) {
    const nameList = loadCornerNameList(slug)!;
    const { aligned } = generateTrackSegments(slug, nameList);
    for (const a of aligned) {
      const key = `${a.gameId}/${slug}`;
      if (expected[key] === undefined) continue; // reported above
      test(`${key} has ${expected[key]} segments`, () => {
        expect(
          a.segments.length,
          `${key}: got ${a.segments.length}, expected ${expected[key]} — check the SVG, then bun run tracks:segment-counts if intentional`,
        ).toBe(expected[key]);
      });
    }
  }
});
