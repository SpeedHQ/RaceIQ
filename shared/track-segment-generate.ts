/**
 * Core of the track segment generator: turns extracted game centerlines +
 * curated corner-name lists into named segments and sector boundaries for
 * shared/tracks/meta. Used by scripts/generate-track-segments.ts (CLI) and
 * by tests, so the exact code path that produces committed meta is what the
 * test suite exercises.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, basename } from "path";
import {
  alignSegments,
  detectCornerRegions,
  resolveSectors,
  validateNameList,
  type AlignedCorner,
  type CornerNameList,
} from "./track-segment-align";
import {
  loadSharedTrackMeta,
  saveSharedTrackMeta,
  type SharedTrackMeta,
} from "./track-data";
import { SHARED_DIR } from "./resolve-data";
import type { GameId } from "./types";

export const CORNER_NAMES_DIR = resolve(SHARED_DIR, "tracks", "corner-names");
const GAME_DIRS: Record<GameId, string> = {
  "f1-2025": resolve(SHARED_DIR, "tracks", "f1-2025"),
  acc: resolve(SHARED_DIR, "tracks", "acc"),
  "fm-2023": resolve(SHARED_DIR, "tracks", "fm-2023"),
  "ac-evo": resolve(SHARED_DIR, "tracks", "ac-evo"),
};
/** Preference order for the top-level (global) meta segments. */
const GLOBAL_PRIORITY = ["fm-2023", "f1-2025", "acc"];

/** List every track slug that has a curated corner-name list. */
export function listCuratedSlugs(): string[] {
  if (!existsSync(CORNER_NAMES_DIR)) return [];
  return readdirSync(CORNER_NAMES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadCornerNameList(slug: string): CornerNameList | null {
  const p = resolve(CORNER_NAMES_DIR, `${slug}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function loadCenterline(filePath: string): { x: number; z: number }[] | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const pts = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
    return pts.length >= 20 ? pts : null;
  } catch {
    return null;
  }
}

/** Find centerline files for a slug per game. FM files embed the ordinal. */
export function findCenterlines(slug: string, gameFilter?: string): { gameId: GameId; file: string }[] {
  const found: { gameId: GameId; file: string }[] = [];
  for (const [gameId, dir] of Object.entries(GAME_DIRS) as [GameId, string][]) {
    if (gameFilter && gameId !== gameFilter) continue;
    if (!existsSync(dir)) continue;
    if (gameId === "fm-2023") {
      const re = new RegExp(`^${slug}-\\d+-centerline\\.csv$`);
      for (const f of readdirSync(dir)) {
        if (re.test(f)) found.push({ gameId, file: resolve(dir, f) });
      }
    } else {
      const f = resolve(dir, `${slug}-centerline.csv`);
      if (existsSync(f)) found.push({ gameId, file: f });
    }
  }
  return found;
}

export interface GameAlignment {
  gameId: GameId;
  file: string;
  segments: NonNullable<SharedTrackMeta["segments"]>;
  /** Named corners with the official turn numbers each one covers. */
  corners: AlignedCorner[];
  sectors: { s1End: number; s2End: number; source: string } | null;
  cost: number;
}

export interface TrackOutcome {
  slug: string;
  gameId: string;
  ok: boolean;
  cost: number;
  wrote: boolean;
  detail: string;
}

export interface GenerationResult {
  outcomes: TrackOutcome[];
  aligned: GameAlignment[];
}

/**
 * Run detection + alignment for one track across all (or one) game
 * centerlines. Pure computation — nothing is written.
 */
export function generateTrackSegments(
  slug: string,
  nameList: CornerNameList,
  gameFilter?: string,
): GenerationResult {
  const outcomes: TrackOutcome[] = [];
  const aligned: GameAlignment[] = [];

  // The name list itself must account for every official turn number
  const listIssues = validateNameList(nameList);
  if (listIssues.length > 0) {
    outcomes.push({
      slug, gameId: "-", ok: false, cost: Infinity, wrote: false,
      detail: `invalid name list: ${listIssues.map((i) => i.message).join("; ")}`,
    });
    return { outcomes, aligned };
  }

  const centerlines = findCenterlines(slug, gameFilter);
  if (centerlines.length === 0) {
    outcomes.push({ slug, gameId: "-", ok: false, cost: Infinity, wrote: false, detail: "no centerline found" });
    return { outcomes, aligned };
  }

  const seenGames = new Set<string>();
  for (const { gameId, file } of centerlines) {
    // FM can have several layout variants per slug — first aligned one wins
    if (seenGames.has(gameId)) continue;

    const outline = loadCenterline(file);
    if (!outline) {
      outcomes.push({ slug, gameId, ok: false, cost: Infinity, wrote: false, detail: `unreadable centerline ${basename(file)}` });
      continue;
    }
    const detection = detectCornerRegions(outline);
    const result = alignSegments(detection.corners, nameList, detection.totalDist);

    if (!result.ok) {
      outcomes.push({
        slug, gameId, ok: false, cost: result.cost, wrote: false,
        detail: result.issues.map((i) => i.message).join("; "),
      });
      continue;
    }

    let sectors: GameAlignment["sectors"] = null;
    if (nameList.sectors) {
      const resolved = resolveSectors(nameList.sectors, result.corners, detection.totalDist);
      result.issues.push(...resolved.issues);
      sectors = resolved.sectors;
    }

    seenGames.add(gameId);
    aligned.push({ gameId, file, segments: result.segments, corners: result.corners, sectors, cost: result.cost });
    const warnings = result.issues.filter((i) => i.severity === "warning").map((i) => i.message);
    outcomes.push({
      slug, gameId, ok: true, cost: result.cost, wrote: false,
      detail: `${result.segments.length} segments, ${result.corners.length} corners`
        + (sectors ? `, sectors ${sectors.s1End}/${sectors.s2End} (${sectors.source})` : "")
        + (warnings.length ? ` — ${warnings.join("; ")}` : ""),
    });
  }

  return { outcomes, aligned };
}

/** Alignments clean enough to persist. */
export function writableAlignments(aligned: GameAlignment[], allowFuzzy = false): GameAlignment[] {
  return aligned.filter((a) => a.cost < 1 || allowFuzzy);
}

/**
 * Merge generated per-game segments/sectors into a track's meta.
 * Pure — does not touch the input object or disk.
 */
export function buildUpdatedMeta(
  existing: SharedTrackMeta | null,
  nameList: CornerNameList,
  writable: GameAlignment[],
): SharedTrackMeta {
  const meta: SharedTrackMeta = existing
    ? structuredClone(existing)
    : { name: nameList.circuit };
  meta.name = meta.name || nameList.circuit;
  for (const a of writable) {
    meta.games = meta.games ?? {};
    meta.games[a.gameId] = meta.games[a.gameId] ?? {};
    meta.games[a.gameId].segments = a.segments;
    if (a.sectors && !hasCuratedSectors(meta.games[a.gameId].sectors)) {
      meta.games[a.gameId].sectors = a.sectors;
    }
  }
  // Global segments/sectors from the highest-priority aligned game
  const globalSrc = GLOBAL_PRIORITY.map((g) => writable.find((a) => a.gameId === g)).find(Boolean);
  if (globalSrc) {
    meta.segments = globalSrc.segments;
    if (globalSrc.sectors && !hasCuratedSectors(meta.sectors)) {
      meta.sectors = globalSrc.sectors;
    }
  }
  return meta;
}

/**
 * Sectors that came from somewhere better than geometry — F1 2025's official
 * per-game fractions (#48), or values researched by hand. Corner-anchored
 * sectors are derived from the centerline, which is a good way to give a game
 * its OWN boundaries but a bad way to overrule a timing line someone looked up:
 * regenerating used to silently push Silverstone's official F1 s1 from 0.314 to
 * 0.354. Geometry fills gaps; it does not overwrite.
 *
 * `source` is stamped only on generated sectors, so its absence marks curation.
 */
function hasCuratedSectors(s: { source?: string } | undefined): boolean {
  return !!s && !s.source;
}

/**
 * Auto-generate segments for a track with no curated name list: detected
 * corners become sequential T-number tokens through the same alignment path
 * (padding, merging) that curated tracks use.
 */
export function autoTrackSegments(outline: { x: number; z: number }[]): {
  segments: NonNullable<SharedTrackMeta["segments"]>;
  cornerCount: number;
  totalDist: number;
} {
  // With no name list to say otherwise, a weak region is just a kink — only a
  // curated corner name can promote one into a section.
  const raw = detectCornerRegions(outline);
  const detection = { corners: raw.corners.filter((c) => !c.weak), totalDist: raw.totalDist };
  if (detection.corners.length === 0) {
    return { segments: [], cornerCount: 0, totalDist: detection.totalDist };
  }
  const syntheticList: CornerNameList = {
    circuit: "auto",
    turnCount: detection.corners.length,
    corners: detection.corners.map((c, i) => ({ number: i + 1, name: "", direction: c.direction })),
  };
  const result = alignSegments(detection.corners, syntheticList, detection.totalDist);
  return {
    segments: result.ok ? result.segments : [],
    cornerCount: detection.corners.length,
    totalDist: detection.totalDist,
  };
}

/** Every centerline file per game (basename without -centerline.csv suffix). */
export function listAllCenterlines(): { gameId: GameId; slug: string; file: string }[] {
  const found: { gameId: GameId; slug: string; file: string }[] = [];
  for (const [gameId, dir] of Object.entries(GAME_DIRS) as [GameId, string][]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith("-centerline.csv")) continue;
      found.push({ gameId, slug: f.replace(/-centerline\.csv$/, ""), file: resolve(dir, f) });
    }
  }
  return found;
}

/** Persist writable alignments into the track's meta file. Returns written gameIds. */
export function writeTrackMeta(
  slug: string,
  nameList: CornerNameList,
  aligned: GameAlignment[],
  allowFuzzy = false,
): string[] {
  const writable = writableAlignments(aligned, allowFuzzy);
  if (writable.length === 0) return [];
  const meta = buildUpdatedMeta(loadSharedTrackMeta(slug), nameList, writable);
  saveSharedTrackMeta(slug, meta);
  return writable.map((a) => a.gameId);
}
