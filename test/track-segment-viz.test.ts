/**
 * Renders every curated track's named segments to SVG, per game centerline —
 * same convention as the lap-detection visualizations: artifacts live in
 * test/e2e/output/track-segments/ and are committed, so any change to the
 * detector, alignment, or name lists shows up as a reviewable diff.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { resolve } from "path";
import {
  alignSegments,
  detectCornerRegions,
  resolveSectors,
  type CornerNameList,
} from "../shared/track-segment-align";
import { generateSegmentSvg } from "./helpers/segment-svg";

const ROOT = resolve(import.meta.dir, "..");
const CORNER_NAMES_DIR = resolve(ROOT, "shared", "tracks", "corner-names");
const OUTPUT_DIR = resolve(ROOT, "test", "e2e", "output", "track-segments");
const GAME_DIRS: Record<string, string> = {
  "f1-2025": resolve(ROOT, "shared", "tracks", "f1-2025"),
  acc: resolve(ROOT, "shared", "tracks", "acc"),
  "fm-2023": resolve(ROOT, "shared", "tracks", "fm-2023"),
};

function loadCenterline(file: string): { x: number; z: number }[] {
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .slice(1)
    .map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
}

function findCenterlines(slug: string): { gameId: string; file: string }[] {
  const found: { gameId: string; file: string }[] = [];
  for (const [gameId, dir] of Object.entries(GAME_DIRS)) {
    if (!existsSync(dir)) continue;
    if (gameId === "fm-2023") {
      const re = new RegExp(`^${slug}-\\d+-centerline\\.csv$`);
      const match = readdirSync(dir).find((f) => re.test(f));
      if (match) found.push({ gameId, file: resolve(dir, match) });
    } else {
      const f = resolve(dir, `${slug}-centerline.csv`);
      if (existsSync(f)) found.push({ gameId, file: f });
    }
  }
  return found;
}

const slugs = readdirSync(CORNER_NAMES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

// Wipe stale artifacts so removed tracks/games don't linger
rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

describe("track segment visualizations", () => {
  for (const slug of slugs) {
    const nameList: CornerNameList = JSON.parse(
      readFileSync(resolve(CORNER_NAMES_DIR, `${slug}.json`), "utf-8"),
    );
    const centerlines = findCenterlines(slug);

    test(`${slug} has at least one centerline`, () => {
      expect(centerlines.length).toBeGreaterThan(0);
    });

    for (const { gameId, file } of centerlines) {
      test(`${slug} / ${gameId} aligns and renders`, () => {
        const outline = loadCenterline(file);
        const detection = detectCornerRegions(outline);
        const result = alignSegments(detection.corners, nameList);

        expect(result.ok).toBe(true);
        expect(result.cost).toBeLessThan(1);

        const sectors = nameList.sectors
          ? resolveSectors(nameList.sectors, result.corners, detection.totalDist).sectors
          : null;

        generateSegmentSvg(
          outline,
          result.segments,
          sectors,
          `${nameList.circuit} — ${gameId}`,
          resolve(OUTPUT_DIR, `${slug}-${gameId}.svg`),
        );
      });
    }
  }
});
