/**
 * Renders every curated track's named segments to SVG, per game centerline —
 * same convention as the lap-detection visualizations: artifacts live in
 * test/e2e/output/track-segments/ and are committed, so any change to the
 * detector, alignment, or name lists shows up as a reviewable diff.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import {
  generateTrackSegments,
  listCuratedSlugs,
  loadCenterline,
  loadCornerNameList,
} from "../shared/track-segment-generate";
import { generateSegmentSvg } from "./helpers/segment-svg";

const OUTPUT_DIR = resolve(import.meta.dir, "e2e", "output", "track-segments");

const slugs = listCuratedSlugs();

// Wipe stale artifacts so removed tracks/games don't linger
rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

describe("track segment visualizations", () => {
  for (const slug of slugs) {
    const nameList = loadCornerNameList(slug)!;
    const { aligned } = generateTrackSegments(slug, nameList);

    test(`${slug} aligns on at least one centerline`, () => {
      expect(aligned.length).toBeGreaterThan(0);
    });

    for (const a of aligned) {
      test(`${slug} / ${a.gameId} renders`, () => {
        const outline = loadCenterline(a.file)!;
        generateSegmentSvg(
          outline,
          a.segments,
          a.sectors,
          `${nameList.circuit} — ${a.gameId}`,
          resolve(OUTPUT_DIR, `${slug}-${a.gameId}.svg`),
        );
      });
    }
  }
});
