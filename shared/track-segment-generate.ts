/**
 * Core of the track segment generator: turns extracted game centerlines +
 * curated corner-name lists into a track's shared facts plus one geometry file
 * per game. Used by scripts/generate-track-segments.ts (CLI) and by tests, so
 * the exact code path that produces committed meta is what the test suite
 * exercises.
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
  loadTrackFacts,
  loadTrackGeometry,
  saveTrackFacts,
  saveTrackGeometry,
} from "./track-data";
import {
  cornerKey,
  cornerNumbers,
  splitSegments,
  type CornerFact,
  type StraightFact,
  type TrackFacts,
  type TrackGeometry,
} from "./track-meta";
import type { NamedSegment } from "./track-named-segments";
import { SHARED_DIR } from "./resolve-data";
import type { GameId } from "./types";

export const CORNER_NAMES_DIR = resolve(SHARED_DIR, "tracks", "corner-names");
const GAME_DIRS: Record<GameId, string> = {
  "f1-2025": resolve(SHARED_DIR, "tracks", "f1-2025"),
  acc: resolve(SHARED_DIR, "tracks", "acc"),
  "fm-2023": resolve(SHARED_DIR, "tracks", "fm-2023"),
  "ac-evo": resolve(SHARED_DIR, "tracks", "ac-evo"),
};

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
  segments: NamedSegment[];
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

/** The two halves a regeneration produces: shared facts, geometry per game. */
export interface GeneratedMeta {
  facts: TrackFacts;
  geometry: Record<string, TrackGeometry>;
}

/**
 * Merge generated per-game segments/sectors into a track's split meta.
 * Pure — does not touch the inputs or disk.
 *
 * Every writable game re-derives the same facts from the same name list, so the
 * fact halves are folded into one list with the committed file as tie-break.
 * Corners this run never mentions — a turn one game's detector folded into its
 * neighbour — are carried through, so the fact set stays the union across games
 * instead of shrinking to whatever aligned today.
 */
export function buildUpdatedMeta(
  slug: string,
  existingFacts: TrackFacts | null,
  existingGeometry: Record<string, TrackGeometry>,
  nameList: CornerNameList,
  writable: GameAlignment[],
): GeneratedMeta {
  const corners = new Map<string, CornerFact>();
  const straights = new Map<number, StraightFact>();
  for (const c of existingFacts?.corners ?? []) corners.set(cornerKey(cornerNumbers(c)), c);
  for (const s of existingFacts?.straights ?? []) straights.set(s.after, s);

  const cornerVotes = new Map<string, CornerFact[]>();
  const straightVotes = new Map<number, StraightFact[]>();
  const geometry: Record<string, TrackGeometry> = {};

  for (const a of writable) {
    const split = splitSegments(a.segments);
    const committedSectors = existingGeometry[a.gameId]?.sectors;
    const sectors = a.sectors && !hasCuratedSectors(committedSectors) ? a.sectors : committedSectors;
    geometry[a.gameId] = { ...(sectors ? { sectors } : {}), segments: split.geometry };
    for (const c of split.corners) {
      const key = cornerKey(cornerNumbers(c));
      const seen = cornerVotes.get(key);
      if (seen) seen.push(c);
      else cornerVotes.set(key, [c]);
    }
    for (const s of split.straights) {
      const seen = straightVotes.get(s.after);
      if (seen) seen.push(s);
      else straightVotes.set(s.after, [s]);
    }
  }

  for (const [key, votes] of cornerVotes) {
    const committed = corners.get(key);
    const numbers = cornerNumbers(votes[0]);
    const direction = agreed(votes.map((v) => v.direction), committed?.direction);
    const group = agreed(votes.map((v) => v.group), committed?.group);
    corners.set(key, {
      number: numbers[0],
      ...(numbers.length > 1 ? { covers: numbers.slice(1) } : {}),
      name: agreed(votes.map((v) => v.name), committed?.name) ?? "",
      ...(direction ? { direction } : {}),
      ...(group ? { group } : {}),
    });
  }
  for (const [after, votes] of straightVotes) {
    const committed = straights.get(after);
    const group = agreed(votes.map((v) => v.group), committed?.group);
    straights.set(after, {
      after,
      name: agreed(votes.map((v) => v.name), committed?.name) ?? "",
      ...(group ? { group } : {}),
    });
  }

  const named = [...straights.values()].sort((a, b) => a.after - b.after);
  return {
    facts: {
      slug: existingFacts?.slug ?? slug,
      track: existingFacts?.track ?? slug,
      layout: existingFacts?.layout ?? "full",
      layoutName: existingFacts?.layoutName ?? "Full",
      name: existingFacts?.name || nameList.circuit,
      corners: [...corners.values()].sort((a, b) => a.number - b.number),
      ...(named.length ? { straights: named } : {}),
    },
    geometry,
  };
}

/**
 * The one value the games agree on. An empty string means "this game had
 * nothing to say", so it never beats a real name; a genuine split falls back to
 * what is already committed, because a regeneration that flips a curated fact
 * on a coin toss is worse than one that leaves it alone.
 */
function agreed<T extends string>(values: (T | undefined)[], committed: T | undefined): T | undefined {
  const distinct = [...new Set(values.filter((v): v is T => !!v))];
  if (distinct.length === 0) return committed;
  if (distinct.length === 1) return distinct[0];
  return committed ?? distinct[0];
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
  segments: NamedSegment[];
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

/** Persist writable alignments into the track's facts + geometry. Returns written gameIds. */
export function writeTrackMeta(
  slug: string,
  nameList: CornerNameList,
  aligned: GameAlignment[],
  allowFuzzy = false,
): string[] {
  const writable = writableAlignments(aligned, allowFuzzy);
  if (writable.length === 0) return [];
  const existingGeometry: Record<string, TrackGeometry> = {};
  for (const a of writable) {
    const geom = loadTrackGeometry(slug, a.gameId);
    if (geom) existingGeometry[a.gameId] = geom;
  }
  const { facts, geometry } = buildUpdatedMeta(slug, loadTrackFacts(slug), existingGeometry, nameList, writable);
  saveTrackFacts(slug, facts);
  for (const [gameId, geom] of Object.entries(geometry)) saveTrackGeometry(slug, gameId, geom);
  return writable.map((a) => a.gameId);
}
