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
  type CornerNameList,
} from "./track-segment-align";
import {
  loadSharedTrackMeta,
  saveSharedTrackMeta,
  type SharedTrackMeta,
} from "./track-data";
import { SHARED_DIR } from "./resolve-data";

export const CORNER_NAMES_DIR = resolve(SHARED_DIR, "tracks", "corner-names");
const GAME_DIRS: Record<string, string> = {
  "f1-2025": resolve(SHARED_DIR, "tracks", "f1-2025"),
  acc: resolve(SHARED_DIR, "tracks", "acc"),
  "fm-2023": resolve(SHARED_DIR, "tracks", "fm-2023"),
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
export function findCenterlines(slug: string, gameFilter?: string): { gameId: string; file: string }[] {
  const found: { gameId: string; file: string }[] = [];
  for (const [gameId, dir] of Object.entries(GAME_DIRS)) {
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
  gameId: string;
  file: string;
  segments: NonNullable<SharedTrackMeta["segments"]>;
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
    const result = alignSegments(detection.corners, nameList);

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
    aligned.push({ gameId, file, segments: result.segments, sectors, cost: result.cost });
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
    if (a.sectors) meta.games[a.gameId].sectors = a.sectors;
  }
  // Global segments/sectors from the highest-priority aligned game
  const globalSrc = GLOBAL_PRIORITY.map((g) => writable.find((a) => a.gameId === g)).find(Boolean);
  if (globalSrc) {
    meta.segments = globalSrc.segments;
    if (globalSrc.sectors) meta.sectors = globalSrc.sectors;
  }
  return meta;
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
