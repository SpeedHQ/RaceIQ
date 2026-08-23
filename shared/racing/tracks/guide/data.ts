/**
 * Loader and atomic authoring store for authored expert track guides.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { writeAtomicJson } from "@shared/platform/runtime/atomic-json";
import type { TrackGuideCornerFile, TrackGuideFile } from "./types";

/** Slugs are path components, never arbitrary filenames. */
export const TRACK_GUIDE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Canonical venue tree; recursive metadata scan includes every source revision. */
const VENUES_DIR = resolve(SHARED_DIR, "tracks", "venues");

function assertSlug(slug: string): void {
  if (!TRACK_GUIDE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid track guide slug: ${JSON.stringify(slug)}`);
  }
}

function assertLocale(locale: string): void {
  if (!LOCALE_RE.test(locale)) throw new Error(`Invalid track guide locale: ${JSON.stringify(locale)}`);
}

function overlayDir(guidesDir: string, locale: string): string {
  const directory = dirname(guidesDir);
  const name = basename(guidesDir);
  return resolve(directory, `${name}-${locale}`);
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Assert an authored guide is well-formed, and narrow it.
 */
export function validateTrackGuide(raw: unknown, slug: string): TrackGuideFile {
  assertSlug(slug);
  const bad = (msg: string): never => {
    throw new Error(`track guide ${slug}: ${msg}`);
  };
  if (!raw || typeof raw !== "object") return bad("not an object");
  const g = raw as Record<string, unknown>;

  if (g.id !== slug) bad(`id ${JSON.stringify(g.id)} does not match filename`);
  if (g.locale !== "en") bad(`locale must be "en" (got ${JSON.stringify(g.locale)}) — translations live beside the base guide as guide.<locale>.json`);
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
    }
    const key = p as string;
    if (seen.has(key)) bad(`priorityCorners lists ${JSON.stringify(key)} twice`);
    seen.add(key);
  }

  return raw as TrackGuideFile;
}

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
      return { ...c, name: str(t.name) ?? c.name, type: str(t.type) ?? c.type, technique: str(t.technique) ?? c.technique, trap: str(t.trap) ?? c.trap };
    }),
  };
}

export interface TrackGuideStore {
  list(): string[];
  load(slug: string, locale?: string): TrackGuideFile | null;
  save(guide: TrackGuideFile): TrackGuideFile;
  invalidate(slug?: string, locale?: string): void;
}

function collectFiles(directory: string, filename: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path, filename));
    else if (entry.name === filename) files.push(path);
  }
  return files;
}

function nestedGuideTarget(venuesDir: string, slug: string): string | null {
  for (const metadataPath of collectFiles(venuesDir, "metadata.json")) {
    const metadata = readJson(metadataPath) as { facts?: { slug?: unknown } } | null;
    if (metadata?.facts?.slug === slug) return resolve(dirname(metadataPath), "guide.json");
  }
  return null;
}

export function createTrackGuideStore({
  guidesDir,
  nested = false,
}: {
  guidesDir: string;
  nested?: boolean;
}): TrackGuideStore {
  const guideCache = new Map<string, TrackGuideFile | null>();
  const guidePaths = new Map<string, string>();
  let slugCache: string[] | null = null;

  const list = (): string[] => {
    if (slugCache) return slugCache;
    const paths = nested
      ? collectFiles(guidesDir, "guide.json")
      : readdirSync(guidesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => resolve(guidesDir, entry.name));
    guidePaths.clear();
    for (const path of paths) {
      const raw = readJson(path) as { id?: unknown } | null;
      if (!raw || typeof raw.id !== "string" || !TRACK_GUIDE_SLUG_RE.test(raw.id)) continue;
      if (guidePaths.has(raw.id)) throw new Error(`Duplicate track guide ${raw.id}`);
      guidePaths.set(raw.id, path);
    }
    slugCache = [...guidePaths.keys()].sort();
    return slugCache;
  };

  const load = (slug: string, locale = "en"): TrackGuideFile | null => {
    assertSlug(slug);
    assertLocale(locale);
    const cacheKey = `${locale}:${slug}`;
    if (guideCache.has(cacheKey)) return guideCache.get(cacheKey) ?? null;
    list();
    const path = guidePaths.get(slug);
    const raw = path ? readJson(path) : null;
    let guide = raw === null ? null : validateTrackGuide(raw, slug);
    if (guide && locale !== "en") {
      const overlayPath = nested
        ? resolve(dirname(path!), `guide.${locale}.json`)
        : resolve(overlayDir(guidesDir, locale), `${slug}.json`);
      guide = applyOverlay(guide, readJson(overlayPath));
    }
    guideCache.set(cacheKey, guide);
    return guide;
  };

  const invalidate = (slug?: string, locale?: string): void => {
    if (slug !== undefined) {
      assertSlug(slug);
      if (locale !== undefined) {
        assertLocale(locale);
        guideCache.delete(`${locale}:${slug}`);
      } else {
        for (const key of guideCache.keys()) if (key.endsWith(`:${slug}`)) guideCache.delete(key);
      }
    } else {
      guideCache.clear();
    }
    guidePaths.clear();
    slugCache = null;
  };

  const save = (guide: TrackGuideFile): TrackGuideFile => {
    const validated = validateTrackGuide(guide, guide.id);
    list();
    const path = guidePaths.get(validated.id)
      ?? (nested ? nestedGuideTarget(guidesDir, validated.id) : resolve(guidesDir, `${validated.id}.json`));
    if (!path) throw new Error(`No canonical track layout found for guide ${validated.id}`);
    writeAtomicJson(path, validated);
    invalidate(validated.id);
    return validated;
  };

  return { list, load, save, invalidate };
}

export const productionTrackGuideStore = createTrackGuideStore({ guidesDir: VENUES_DIR, nested: true });
