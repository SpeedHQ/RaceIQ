/**
 * `venues/<root>/revisions/<revision>/tracks/<layout>/detect-hints.json`.
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
 * The runtime metadata JSON is not packaged. Resolve the sibling asset through
 * its generated registry layout row instead of scanning venue files.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { getTrackRegistry, getTrackRegistryRevision } from "./registry";
import { canonicalTrackAssetPathComponents } from "./configuration";

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

const DETECT_HINTS_FILENAME = "detect-hints.json";

/** Empty map shared by every layout that needs no allowances. */
export const NO_DETECT_HINTS: DetectHints = new Map();

interface LayoutRow {
  venuePath: string;
  slug: string;
}

const cache = new Map<string, DetectHints>();
let cacheRevision = -1;

function refreshCacheForRegistryRevision(): void {
  const revision = getTrackRegistryRevision();
  if (revision === cacheRevision) return;
  cache.clear();
  cacheRevision = revision;
}

function readHints(path: string): DetectHints {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid detect hints ${path}: expected turn map`);
  }

  const hints: DetectHints = new Map();
  for (const [number, value] of Object.entries(parsed)) {
    const turn = Number(number);
    if (!Number.isSafeInteger(turn) || turn < 1) {
      throw new Error(`Invalid detect hints ${path}: turn ${JSON.stringify(number)}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid detect hints ${path}: turn ${turn} must be an object`);
    }
    const hint = value as CornerDetectHint;
    if (hint.spans !== undefined && (!Number.isSafeInteger(hint.spans) || hint.spans < 1)) {
      throw new Error(`Invalid detect hints ${path}: turn ${turn} spans`);
    }
    if (hint.optional !== undefined && typeof hint.optional !== "boolean") {
      throw new Error(`Invalid detect hints ${path}: turn ${turn} optional`);
    }
    hints.set(turn, hint);
  }
  return hints;
}

function hintPath(row: LayoutRow): string {
  return resolve(SHARED_DIR, "tracks", ...canonicalTrackAssetPathComponents(row.venuePath, row.slug), DETECT_HINTS_FILENAME);
}

/** Detector allowances for a layout. Empty map when the layout needs none. */
export function loadDetectHints(factsSlug: string): DetectHints {
  refreshCacheForRegistryRevision();
  const cached = cache.get(factsSlug);
  if (cached) return cached;

  const rows = getTrackRegistry().query(`
    SELECT venue_path AS venuePath, slug
      FROM layouts
     WHERE facts_slug = ?
  `).all(factsSlug) as LayoutRow[];
  if (rows.length > 1) {
    throw new Error(`Ambiguous detect hints layout for facts slug ${JSON.stringify(factsSlug)}`);
  }

  const path = rows[0] ? hintPath(rows[0]) : null;
  const hints = !path || !existsSync(path) ? NO_DETECT_HINTS : readHints(path);
  cache.set(factsSlug, hints);
  return hints;
}

/** Every layout carrying at least one hint — for validation and reporting. */
export function listDetectHintSlugs(): string[] {
  const rows = getTrackRegistry().query(`
    SELECT facts_slug AS factsSlug
      FROM layouts
     WHERE facts_slug IS NOT NULL
     ORDER BY facts_slug
  `).all() as Array<{ factsSlug: string }>;
  return rows.filter(({ factsSlug }) => loadDetectHints(factsSlug).size > 0).map(({ factsSlug }) => factsSlug);
}
