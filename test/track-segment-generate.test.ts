/**
 * Runs the real segment generator (same code path as `bun run
 * tracks:segments`) over every curated track and asserts:
 *   1. every game centerline aligns cleanly (no unsanctioned fuzz), and
 *   2. the committed meta files exactly match what --write would produce —
 *      i.e. name lists, detector, and shared/tracks/meta cannot drift apart.
 *
 * If this fails after editing a name list or the detector, regenerate with:
 *   bun run tracks:segments --all --write
 */
import { describe, test, expect } from "bun:test";
import {
  buildUpdatedMeta,
  generateTrackSegments,
  listCuratedSlugs,
  loadCornerNameList,
  writableAlignments,
} from "../shared/track-segment-generate";
import { loadSharedTrackMeta } from "../shared/track-data";

const slugs = listCuratedSlugs();

describe("track segment generator", () => {
  test("curated corner-name lists exist", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  for (const slug of slugs) {
    describe(slug, () => {
      const nameList = loadCornerNameList(slug)!;
      const { outcomes, aligned } = generateTrackSegments(slug, nameList);

      test("aligns on every available game centerline", () => {
        expect(outcomes.length).toBeGreaterThan(0);
        for (const o of outcomes) {
          expect(o.ok, `${slug}/${o.gameId}: ${o.detail}`).toBe(true);
          expect(o.cost, `${slug}/${o.gameId} has unsanctioned fuzz: ${o.detail}`).toBeLessThan(1);
        }
        expect(writableAlignments(aligned)).toHaveLength(aligned.length);
      });

      test("committed meta matches generator output (run tracks:segments --all --write if stale)", () => {
        const existing = loadSharedTrackMeta(slug);
        expect(existing).not.toBeNull();
        const regenerated = buildUpdatedMeta(existing, nameList, writableAlignments(aligned));
        expect(existing).toEqual(regenerated);
      });
    });
  }
});
