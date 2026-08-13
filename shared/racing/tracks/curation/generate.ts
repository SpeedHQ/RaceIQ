/**
 * Core of the track segment generator: turns extracted game centerlines +
 * curated track facts into a track's shared facts plus one geometry file
 * per game. Used by scripts/tracks/generate-track-segments.ts (CLI) and by tests, so
 * the exact code path that produces committed meta is what the test suite
 * exercises.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { detectCornerRegions, type CornerRegion } from "./segment-align-detect";
import { alignSegments, type AlignedCorner } from "./segment-align-match";
import { validateFacts } from "./segment-align-validate";
import {
  loadTrackFacts,
  loadTrackGeometry,
  saveTrackFacts,
  saveTrackGeometry,
} from "../storage/meta";
import { cornerNumbers, type CornerFact, type StraightFact, type TrackFacts } from "../facts";
import type { TrackGeometry } from "../geometry";
import { splitSegments } from "./join";
import { cornerKey } from "../keys";
import { loadDetectHints } from "../detect-hints";
import type { NamedSegment } from "../named-segments";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import type { GameId } from "@shared/games/ids";

export const TRACK_META_DIR = resolve(SHARED_DIR, "tracks", "meta");
const NO_CENTERLINE_DIR = null;
const GAME_DIRS: Record<GameId, string | typeof NO_CENTERLINE_DIR> = {
  "f1-2025": resolve(SHARED_DIR, "tracks", "f1-2025"),
  acc: resolve(SHARED_DIR, "tracks", "acc"),
  "fm-2023": resolve(SHARED_DIR, "tracks", "fm-2023"),
  "ac-evo": resolve(SHARED_DIR, "tracks", "ac-evo"),
  iracing: NO_CENTERLINE_DIR,
};

/** List every track slug that has a meta file, curated or not. */
export function listMetaSlugs(): string[] {
  if (!existsSync(TRACK_META_DIR)) return [];
  return readdirSync(TRACK_META_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/**
 * List every track slug carrying a hand-authored corner roster.
 *
 * The marker is a non-empty `corners` array. `source` — the circuit map / FIA
 * track guide the roster was transcribed from — is asserted separately, so it
 * must NOT gate this list: an uncited roster is a citation bug to surface, not a
 * track to quietly stop testing.
 */
export function listCuratedSlugs(): string[] {
  // A slug is curated because it HAS a hand-authored corner roster — not because
  // that roster is cited. Gating on `source` silently drops uncited rosters out of
  // every per-slug test and leaves the citation test asserting about itself.
  return listMetaSlugs().filter((slug) => (loadTrackFacts(slug)?.corners.length ?? 0) > 0);
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
  for (const [gameId, dir] of Object.entries(GAME_DIRS) as [GameId, string | null][]) {
    if (gameFilter && gameId !== gameFilter) continue;
    if (dir === NO_CENTERLINE_DIR) continue;
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
  facts: TrackFacts,
  gameFilter?: string,
): GenerationResult {
  const outcomes: TrackOutcome[] = [];
  const aligned: GameAlignment[] = [];

  // Detector tolerances for this layout — not facts, so they load separately.
  const hints = loadDetectHints(slug);

  // The facts file itself must account for every official turn number
  const listIssues = validateFacts(facts, hints);
  if (listIssues.length > 0) {
    outcomes.push({
      slug, gameId: "-", ok: false, cost: Infinity, wrote: false,
      detail: `invalid facts: ${listIssues.map((i) => i.message).join("; ")}`,
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
    const result = alignSegments(detection.corners, facts, detection.totalDist, hints);

    if (!result.ok) {
      outcomes.push({
        slug, gameId, ok: false, cost: result.cost, wrote: false,
        detail: result.issues.map((i) => i.message).join("; "),
      });
      continue;
    }

    seenGames.add(gameId);
    aligned.push({ gameId, file, segments: result.segments, corners: result.corners, cost: result.cost });
    const warnings = result.issues.filter((i) => i.severity === "warning").map((i) => i.message);
    outcomes.push({
      slug, gameId, ok: true, cost: result.cost, wrote: false,
      detail: `${result.segments.length} segments, ${result.corners.length} corners`
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
    // Sectors are curated per game and live only in geometry — regeneration
    // rewrites segments and must carry them through untouched.
    const sectors = existingGeometry[a.gameId]?.sectors;
    geometry[a.gameId] = {
      ...(sectors ? { sectors } : {}),
      segments: split.geometry,
    };
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
    // Direction is curated, not detected. A corner already in the facts file keeps
    // exactly what the roster says — including a deliberate *absence*, which is how
    // a multi-apex/ambiguous turn (Sebring T15) is recorded. Detection only gets a
    // say for corners the roster has never seen, or on a track with no facts at all.
    const known = existingFacts !== null && committed !== undefined;
    const direction = known
      ? committed.direction
      : agreed(votes.map((v) => v.direction), committed?.direction);
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
      name: existingFacts?.name ?? slug,
      // Citation for the names below. Regeneration must never silently drop it —
      // an uncited name is indistinguishable from an invented one.
      ...(existingFacts?.source ? { source: existingFacts.source } : {}),
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
 * Auto-generate segments for a track with no curated facts: detected
 * corners become sequential T-number tokens through the same alignment path
 * (padding, merging) that curated tracks use.
 */
export interface AutoTrackSegmentOptions {
  /**
   * Standard oval topology. iRacing publishes four official turn numbers for
   * these layouts even though curvature detection usually sees two continuous
   * banked ends (or several SVG spline artifacts).
   */
  fourTurnOval?: {
    direction: "left" | "right";
    /** Official numbered turn positions projected onto lap fractions. */
    turnAnchors?: readonly { number: number; fraction: number }[];
  };
}

export function autoTrackSegments(
  outline: { x: number; z: number }[],
  options: AutoTrackSegmentOptions = {},
): {
  segments: NamedSegment[];
  cornerCount: number;
  totalDist: number;
} {
  // With no curated facts to say otherwise, a weak region is just a kink — only a
  // curated corner name can promote one into a section.
  const raw = detectCornerRegions(outline);
  const strongCorners = raw.corners.filter((corner) => !corner.weak);
  const detectedDirections = new Set(
    strongCorners.map((corner) => corner.direction),
  );
  if (options.fourTurnOval && detectedDirections.size <= 1) {
    return {
      segments: fourTurnOvalSegments(
        strongCorners,
        options.fourTurnOval.direction,
        options.fourTurnOval.turnAnchors,
      ),
      cornerCount: 4,
      totalDist: raw.totalDist,
    };
  }
  const detection = { corners: strongCorners, totalDist: raw.totalDist };
  if (detection.corners.length === 0) {
    return { segments: [], cornerCount: 0, totalDist: detection.totalDist };
  }
  const synthetic: TrackFacts = {
    slug: "auto", track: "auto", layout: "full", layoutName: "Full", name: "auto",
    corners: detection.corners.map((c, i) => ({ number: i + 1, name: "", direction: c.direction })),
  };
  const result = alignSegments(detection.corners, synthetic, detection.totalDist);
  const segments = result.ok ? result.segments : [];
  groupAutoStartFinishStraight(segments);
  return {
    segments,
    cornerCount: detection.corners.length,
    totalDist: detection.totalDist,
  };
}

/**
 * Lap fractions must split a section at 0/1, but that split is storage detail.
 * Give both halves one group so driver-facing consumers can present the
 * start/finish straight as one logical section on any auto-detected circuit.
 */
function groupAutoStartFinishStraight(segments: NamedSegment[]): void {
  const first = segments[0];
  const last = segments.at(-1);
  if (
    !first ||
    !last ||
    first === last ||
    first.type !== "straight" ||
    last.type !== "straight"
  ) {
    return;
  }
  const name =
    first.name ||
    last.name ||
    "Start/Finish Straight";
  first.name = name;
  last.name = name;
  first.group = name;
  last.group = name;
}

/**
 * Normalize standard oval geometry into racing terminology and numbering.
 *
 * Start/finish sits within the frontstretch. Each banked end is one continuous
 * curvature region on many ovals, but carries two official turn numbers.
 * Detector extents still place each end; conservative defaults cover smooth
 * ovals whose SVG centerline never crosses road-course curvature thresholds.
 */
function fourTurnOvalSegments(
  detected: CornerRegion[],
  direction: "left" | "right",
  turnAnchors: readonly { number: number; fraction: number }[] = [],
): NamedSegment[] {
  const firstEnd = ovalEndBounds(detected, 0, 0.5, 0.1, 0.4);
  const secondEnd = ovalEndBounds(detected, 0.5, 1, 0.6, 0.9);
  const firstMiddle = ovalTurnSplit(turnAnchors, 1, 2, firstEnd);
  const secondMiddle = ovalTurnSplit(turnAnchors, 3, 4, secondEnd);

  return [
    {
      type: "straight",
      name: "Frontstretch",
      group: "Frontstretch",
      startFrac: 0,
      endFrac: firstEnd.start,
    },
    {
      type: "corner",
      name: "",
      number: 1,
      direction,
      startFrac: firstEnd.start,
      endFrac: firstMiddle,
    },
    {
      type: "corner",
      name: "",
      number: 2,
      direction,
      startFrac: firstMiddle,
      endFrac: firstEnd.end,
    },
    {
      type: "straight",
      name: "Backstretch",
      startFrac: firstEnd.end,
      endFrac: secondEnd.start,
    },
    {
      type: "corner",
      name: "",
      number: 3,
      direction,
      startFrac: secondEnd.start,
      endFrac: secondMiddle,
    },
    {
      type: "corner",
      name: "",
      number: 4,
      direction,
      startFrac: secondMiddle,
      endFrac: secondEnd.end,
    },
    {
      type: "straight",
      name: "Frontstretch",
      group: "Frontstretch",
      startFrac: secondEnd.end,
      endFrac: 1,
    },
  ];
}

function ovalTurnSplit(
  anchors: readonly { number: number; fraction: number }[],
  firstTurn: number,
  secondTurn: number,
  bounds: { start: number; end: number },
): number {
  const first = anchors.find((anchor) => anchor.number === firstTurn);
  const second = anchors.find((anchor) => anchor.number === secondTurn);
  if (first && second) {
    const anchoredMiddle = (first.fraction + second.fraction) / 2;
    if (anchoredMiddle > bounds.start && anchoredMiddle < bounds.end) {
      return anchoredMiddle;
    }
  }
  return (bounds.start + bounds.end) / 2;
}

function ovalEndBounds(
  detected: CornerRegion[],
  halfStart: number,
  halfEnd: number,
  fallbackStart: number,
  fallbackEnd: number,
): { start: number; end: number } {
  const regions = detected.filter(
    (corner) =>
      corner.apexFrac >= halfStart &&
      corner.apexFrac < halfEnd,
  );
  if (regions.length === 0) {
    return { start: fallbackStart, end: fallbackEnd };
  }

  const rawStart = Math.min(...regions.map((corner) => corner.startFrac));
  const rawEnd = Math.max(...regions.map((corner) => corner.endFrac));
  const halfPadding = 0.04;
  const minimumSpan = 0.2;
  const minimumStraight = 0.05;
  let start = Math.max(
    halfStart + minimumStraight,
    rawStart - halfPadding,
  );
  let end = Math.min(
    halfEnd - minimumStraight,
    rawEnd + halfPadding,
  );

  if (end - start < minimumSpan) {
    const middle = (start + end) / 2;
    start = Math.max(
      halfStart + minimumStraight,
      middle - minimumSpan / 2,
    );
    end = Math.min(
      halfEnd - minimumStraight,
      middle + minimumSpan / 2,
    );
  }
  return { start, end };
}

/** Every centerline file per game (basename without -centerline.csv suffix). */
export function listAllCenterlines(): { gameId: GameId; slug: string; file: string }[] {
  const found: { gameId: GameId; slug: string; file: string }[] = [];
  for (const [gameId, dir] of Object.entries(GAME_DIRS) as [GameId, string | null][]) {
    if (dir === NO_CENTERLINE_DIR) continue;
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
  facts: TrackFacts,
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
  const { facts: updatedFacts, geometry } = buildUpdatedMeta(slug, facts, existingGeometry, writable);
  saveTrackFacts(slug, updatedFacts);
  for (const [gameId, geom] of Object.entries(geometry)) saveTrackGeometry(slug, gameId, geom);
  return writable.map((a) => a.gameId);
}
