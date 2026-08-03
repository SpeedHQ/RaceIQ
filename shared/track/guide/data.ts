/**
 * Loader for the authored expert track guides in shared/tracks/guides/.
 *
 * Uses the same runtime/data-paths SHARED_DIR resolution as track storage, so
 * compiled binaries read guides from data/ next to the executable. The
 * permanent cache includes negative lookups. Guide prose is the only user-visible
 * English left in the AI prompt path that a translator cannot reach from code,
 * which is why it is data rather than a TS literal.
 *
 * Locale overlays (shared/tracks/guides-<locale>/) are read here but not yet
 * authored — nothing in the app passes a locale today. The merge is kept
 * deliberately small and honest so the shape can't drift before the first
 * translation lands.
 */
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "../../runtime/data-paths";
import type { TrackGuideCornerFile, TrackGuideFile } from "./types";

/** Base-locale guides. One file per layout slug, id === filename stem. */
const GUIDES_DIR = resolve(SHARED_DIR, "tracks", "guides");

/** Overlay dir for a non-base locale. Sibling of GUIDES_DIR, same filenames. */
function overlayDir(locale: string): string {
  return resolve(SHARED_DIR, "tracks", `guides-${locale}`);
}

/** Keyed `${locale}:${slug}`. Permanent — guides are read-only bundled data. */
const guideCache = new Map<string, TrackGuideFile | null>();

let slugCache: string[] | null = null;

/**
 * Every slug that ships a guide, lexicographic.
 *
 * Note this is *not* the old declaration order of the `guides` array it
 * replaced. Every consumer is set-membership, so the reorder is invisible —
 * but a new consumer must not assume the order means anything.
 */
export function listTrackGuideSlugs(): string[] {
  if (slugCache) return slugCache;
  let names: string[];
  try {
    names = readdirSync(GUIDES_DIR);
  } catch {
    names = [];
  }
  slugCache = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
  return slugCache;
}

/**
 * Load one guide, optionally overlaid with a translation.
 *
 * Returns null when the slug ships no guide — the common case, most layouts
 * have none. Throws when a guide exists but is malformed: this is committed
 * data validated in CI, so a bad file is a build bug, not a runtime condition
 * to degrade around.
 */
export function loadTrackGuide(slug: string, locale = "en"): TrackGuideFile | null {
  if (!slug) return null;
  const cacheKey = `${locale}:${slug}`;
  const hit = guideCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const raw = readJson(resolve(GUIDES_DIR, `${slug}.json`));
  let guide = raw === null ? null : validateTrackGuide(raw, slug);
  if (guide && locale !== "en") guide = applyOverlay(guide, readJson(resolve(overlayDir(locale), `${slug}.json`)));

  guideCache.set(cacheKey, guide);
  return guide;
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null; // absent is normal — most layouts ship no guide, no locale is translated yet
  }
  return JSON.parse(text) as unknown;
}

/**
 * Merge a translation over the base guide.
 *
 * Prose only, joined on corner `key`: the overlay can never add, drop, or
 * reorder corners, change `numbers`, or touch `priorityCorners`. A partial
 * overlay is fine and falls back to English field by field, so a
 * work-in-progress translation degrades to mixed-language rather than to a
 * broken guide.
 */
function applyOverlay(base: TrackGuideFile, raw: unknown): TrackGuideFile {
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Partial<TrackGuideFile>;
  const byKey = new Map<string, Partial<TrackGuideCornerFile>>();
  for (const c of o.corners ?? []) {
    if (c && typeof c.key === "string") byKey.set(c.key, c);
  }
  return {
    ...base,
    character: str(o.character) ?? base.character,
    corners: base.corners.map((c) => {
      const t = byKey.get(c.key);
      if (!t) return c;
      return {
        ...c,
        name: str(t.name) ?? c.name,
        type: str(t.type) ?? c.type,
        technique: str(t.technique) ?? c.technique,
        trap: str(t.trap) ?? c.trap,
      };
    }),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Assert an authored guide is well-formed, and narrow it.
 *
 * Hand-rolled rather than zod, following `validateFacts` in
 * shared/track/curation/segment-align-validate.ts — this repo validates committed track data with
 * plain code. Unlike `validateFacts` (which collects issues for a report) this
 * throws on the first problem: there is no partial-credit rendering of a guide.
 */
export function validateTrackGuide(raw: unknown, slug: string): TrackGuideFile {
  const bad = (msg: string): never => {
    throw new Error(`track guide ${slug}: ${msg}`);
  };
  if (!raw || typeof raw !== "object") return bad("not an object");
  const g = raw as Record<string, unknown>;

  if (g.id !== slug) bad(`id ${JSON.stringify(g.id)} does not match filename`);
  if (g.locale !== "en") bad(`locale must be "en" (got ${JSON.stringify(g.locale)}) — translations live in guides-<locale>/`);
  if (!str(g.character)) bad("character is empty");
  if (g.sources !== undefined && !str(g.sources)) bad("sources is present but empty");
  if (g.notes !== undefined && !str(g.notes)) bad("notes is present but empty");

  if (!Array.isArray(g.corners) || g.corners.length === 0) bad("no corners");
  const corners = g.corners as unknown[];
  const keys = new Set<string>();
  for (const [i, entry] of corners.entries()) {
    const at = (m: string) => bad(`corner ${i}: ${m}`);
    if (!entry || typeof entry !== "object") at("not an object");
    const c = entry as Record<string, unknown>;
    for (const field of ["key", "name", "type", "technique", "trap"] as const) {
      if (!str(c[field])) at(`${field} is empty`);
    }
    const key = c.key as string;
    if (keys.has(key)) at(`duplicate key ${JSON.stringify(key)}`);
    keys.add(key);
    if (c.numbers !== undefined) validateNumbers(c.numbers, at);
  }

  if (!Array.isArray(g.priorityCorners)) bad("priorityCorners must be an array");
  const seen = new Set<string>();
  for (const p of g.priorityCorners as unknown[]) {
    if (typeof p !== "string" || !keys.has(p)) {
      bad(`priorityCorners entry ${JSON.stringify(p)} matches no corner key`);
      continue;
    }
    if (seen.has(p)) bad(`priorityCorners lists ${JSON.stringify(p)} twice`);
    seen.add(p);
  }

  return raw as TrackGuideFile;
}

/**
 * Turn numbers join into shared/tracks/meta/<slug>.json, which is itself sorted
 * and dupe-free — an unsorted or duplicated list here means the anchor was
 * transcribed wrong, and would render a nonsense label like "Turn (4-2)".
 */
function validateNumbers(value: unknown, at: (m: string) => never): void {
  if (!Array.isArray(value) || value.length === 0) at("numbers is present but empty");
  const nums = value as unknown[];
  let prev = 0;
  for (const n of nums) {
    if (!Number.isInteger(n) || (n as number) < 1) at(`turn ${JSON.stringify(n)} is not a positive integer`);
    if ((n as number) === prev) at(`turn ${n} listed twice`);
    if ((n as number) < prev) at(`turn ${n} out of order`);
    prev = n as number;
  }
}
