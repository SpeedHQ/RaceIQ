/**
 * Renders every curated track's named segments to SVG, per game centerline —
 * same convention as the lap-detection visualizations: artifacts live in
 * test/e2e/output/track-segments/ and are committed, so any change to the
 * detector, alignment, or name lists shows up as a reviewable diff.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { initGameAdapters } from "../shared/games/init";
import {
  autoTrackSegments,
  generateTrackSegments,
  listAllCenterlines,
  listCuratedSlugs,
  loadCenterline,
  loadCornerNameList,
} from "../shared/track-segment-generate";
import { generateSegmentSvg } from "./helpers/segment-svg";

// Required before rendering: needsTrackFlip() resolves coordSystem through the
// game registry, which is populated by side-effect registration. Without this
// every lookup misses, the flip silently no-ops, and standard-xyz tracks render
// mirrored — the exact bug these artifacts are meant to catch.
initGameAdapters();

const OUTPUT_DIR = resolve(import.meta.dir, "e2e", "output", "track-segments");
const AUTO_OUTPUT_DIR = resolve(import.meta.dir, "e2e", "output", "track-segments-auto");

const slugs = listCuratedSlugs();

// Wipe stale artifacts so removed tracks/games don't linger
rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });
rmSync(AUTO_OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(AUTO_OUTPUT_DIR, { recursive: true });

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
          a.gameId,
        );
      });
    }
  }
});

describe("auto-detected segment visualizations (uncurated tracks)", () => {
  // Every game centerline without a curated name list renders with sequential
  // T-number tokens — the browsable worklist for future corner-name curation.
  const curated = new Set(slugs);
  const uncurated = listAllCenterlines().filter(({ slug }) => {
    const base = slug.replace(/-\d+$/, ""); // fm slugs embed the ordinal
    return !curated.has(base) && !curated.has(slug);
  });

  test("finds uncurated centerlines", () => {
    expect(uncurated.length).toBeGreaterThan(0);
  });

  for (const { gameId, slug, file } of uncurated) {
    test(`${slug} / ${gameId} renders auto segments`, () => {
      const outline = loadCenterline(file);
      expect(outline).not.toBeNull();
      const { segments, cornerCount, totalDist } = autoTrackSegments(outline!);
      expect(totalDist).toBeGreaterThan(0);
      if (cornerCount === 0) return; // ovals/speedways may have no threshold corners
      expect(segments.length).toBeGreaterThan(0);
      generateSegmentSvg(
        outline!,
        segments,
        null,
        `${slug} — ${gameId} (auto, uncurated)`,
        resolve(AUTO_OUTPUT_DIR, `${slug}-${gameId}.svg`),
        gameId,
      );
    });
  }
});
