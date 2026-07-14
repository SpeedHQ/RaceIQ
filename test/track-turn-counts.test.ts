/**
 * Turn-detection accuracy baseline: every game centerline must detect exactly
 * the expected number of corner regions recorded in
 * test/fixtures/expected-turn-counts.json (reviewed against the SVGs in
 * test/e2e/output/track-segments*).
 *
 * Fails when the detector drifts (threshold tweaks changing corner counts on
 * unrelated tracks) or a new track ships without a reviewed expectation.
 * After an intentional detector change: bun run tracks:turn-counts, review
 * the diff + SVGs, commit the updated fixture.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { detectCornerRegions } from "../shared/track-segment-align";
import { listAllCenterlines, loadCenterline } from "../shared/track-segment-generate";

const expected: Record<string, number> = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures", "expected-turn-counts.json"), "utf-8"),
);

const centerlines = listAllCenterlines();

describe("turn detection accuracy", () => {
  test("baseline covers every centerline", () => {
    const keys = new Set(centerlines.map((c) => `${c.gameId}/${c.slug}`));
    const missing = [...keys].filter((k) => expected[k] === undefined);
    const stale = Object.keys(expected).filter((k) => !keys.has(k));
    expect(missing, `add to fixture via: bun run tracks:turn-counts — missing ${missing.join(", ")}`).toEqual([]);
    expect(stale, `stale fixture entries: ${stale.join(", ")}`).toEqual([]);
  });

  for (const { gameId, slug, file } of centerlines) {
    const key = `${gameId}/${slug}`;
    if (expected[key] === undefined) continue; // reported above
    test(`${key} detects ${expected[key]} turns`, () => {
      const outline = loadCenterline(file);
      expect(outline).not.toBeNull();
      const { corners } = detectCornerRegions(outline!);
      expect(
        corners.length,
        `${key}: detector found ${corners.length}, expected ${expected[key]} — check the SVG, then bun run tracks:turn-counts if intentional`,
      ).toBe(expected[key]);
    });
  }
});
