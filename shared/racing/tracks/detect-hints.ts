/**
 * Corner-detector tolerances — `shared/data/tracks/detect-hints.json`.
 *
 * Deliberately NOT part of track facts. Registry facts state what circuit is:
 * turn numbers, names, groups, and numbers one corner subsumes. Nothing there
 * depends on how a game drew its centerline or on
 * how our curvature detector reads it. These hints are exactly that dependency
 * — "this apex often resolves into two arcs", "this kink is too flat for some
 * centerlines to register" — so they live in their own file and are read only
 * by the segment generator, never by anything that answers questions about the
 * track itself.
 *
 * Keyed by layout slug, then by the corner's official (lowest) turn number, so
 * an entry is meaningless without the facts roster it annotates.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";

/** Detector tolerances for one corner. Absent fields mean "no allowance". */
export interface CornerDetectHint {
  /**
   * Max detected regions this one corner may occupy (default 1). A long
   * multi-apex turn — Road Atlanta's 10a/10b chicane, Suzuka's Degners — is one
   * official number that some centerlines resolve into two arcs. Raising the
   * ceiling lets alignment consume both without paying a span-mismatch cost.
   */
  spans?: number;
  /**
   * Numbered on the circuit map but not a corner every centerline shows — a
   * flat kink (Baku 13/14, Monaco 17) a detector may legitimately fold into the
   * straight around it. The facts roster still owns the number, so the turn
   * stays accounted for; alignment is simply allowed to leave it unmatched.
   */
  optional?: boolean;
}

/** Hints for one layout, keyed by official turn number. */
export type DetectHints = Map<number, CornerDetectHint>;

export const DETECT_HINTS_FILE = resolve(SHARED_DIR, "tracks", "detect-hints.json");

/** Empty map shared by every layout that needs no allowances. */
export const NO_DETECT_HINTS: DetectHints = new Map();

type HintsFile = Record<string, Record<string, CornerDetectHint>>;

let cache: Map<string, DetectHints> | null = null;

function loadFile(): Map<string, DetectHints> {
  if (cache) return cache;
  cache = new Map();
  if (!existsSync(DETECT_HINTS_FILE)) return cache;
  let parsed: HintsFile;
  try {
    parsed = JSON.parse(readFileSync(DETECT_HINTS_FILE, "utf8")) as HintsFile;
  } catch {
    return cache;
  }
  for (const [slug, corners] of Object.entries(parsed)) {
    const byNumber: DetectHints = new Map();
    for (const [number, hint] of Object.entries(corners)) {
      const n = Number(number);
      if (Number.isInteger(n)) byNumber.set(n, hint);
    }
    cache.set(slug, byNumber);
  }
  return cache;
}

/** Detector allowances for a layout. Empty map when the layout needs none. */
export function loadDetectHints(slug: string): DetectHints {
  return loadFile().get(slug) ?? NO_DETECT_HINTS;
}

/** Every layout carrying at least one hint — for validation and reporting. */
export function listDetectHintSlugs(): string[] {
  return [...loadFile().keys()].sort();
}
