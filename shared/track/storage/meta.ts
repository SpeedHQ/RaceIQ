import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHARED_DIR } from "../../runtime/data-paths";
import { joinSegments } from "../curation/join";
import type { TrackFacts } from "../facts";
import type { TrackGeometry } from "../geometry";
import type { NamedSegment } from "../named-segments";
import type { TrackSectors } from "../sectors";
import { readDataFile } from "./files";

/** Game-agnostic track facts (turn names, numbers, groups). */
const trackFactsDir = resolve(SHARED_DIR, "tracks", "meta");

/**
 * Games that reuse another game's curated geometry when they ship none of
 * their own. AC Evo and ACC use the same Kunos track meshes. iRacing's
 * `commonTrackName` entries are deliberately limited to exact physical
 * layouts, so normalized LapDistPct can use the first curated geometry
 * RaceIQ has for that layout while retaining the shared real-world names.
 */
const GEOMETRY_FALLBACKS: Record<string, string[]> = {
  "ac-evo": ["acc"],
  iracing: ["fm-2023", "f1-2025", "acc", "ac-evo"],
};

const factsCache = new Map<string, TrackFacts | null>();
const geometryCache = new Map<string, TrackGeometry | null>();

/**
 * Load a layout's physical facts by slug. Takes no gameId, deliberately: turn
 * names and numbers are properties of the circuit, identical for every game
 * that ships it, so a caller that has a gameId to hand still must not use it
 * here. Geometry is the only thing that varies — see `loadTrackGeometry`.
 */
export function loadTrackFacts(slug: string): TrackFacts | null {
  if (!slug) return null;
  const hit = factsCache.get(slug);
  if (hit !== undefined) return hit;
  const content = readDataFile(resolve(trackFactsDir, `${slug}.json`));
  let parsed: TrackFacts | null = null;
  if (content) {
    try {
      parsed = JSON.parse(content) as TrackFacts;
    } catch {
      parsed = null;
    }
  }
  factsCache.set(slug, parsed);
  return parsed;
}

/** Load one game's segment fractions for a layout, falling back when compatible. */
export function loadTrackGeometry(slug: string, gameId: string): TrackGeometry | null {
  if (!slug || !gameId) return null;
  const cacheKey = `${gameId}:${slug}`;
  const hit = geometryCache.get(cacheKey);
  if (hit !== undefined) return hit;

  let parsed: TrackGeometry | null = null;
  for (const candidate of [
    gameId,
    ...(GEOMETRY_FALLBACKS[gameId] ?? []),
  ]) {
    const content = readDataFile(resolve(SHARED_DIR, "tracks", candidate, `${slug}-segments.json`));
    if (!content) continue;
    try {
      parsed = JSON.parse(content) as TrackGeometry;
      break;
    } catch {
      parsed = null;
    }
  }
  geometryCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * The one place labelled segments come from: this game's fractions carrying
 * the layout's shared names. Returns [] when the game has no geometry for the
 * layout, so callers fall through to their own auto-detection. The only
 * cross-game fallbacks are the compatible layouts documented above.
 */
export function loadLabelledSegments(slug: string, gameId: string): NamedSegment[] {
  const facts = loadTrackFacts(slug);
  const geometry = loadTrackGeometry(slug, gameId);
  if (!facts || !geometry) return [];
  return joinSegments(facts, geometry);
}

/** Sector boundaries for a layout in one game's lap fractions. */
export function loadTrackSectorsFor(slug: string, gameId: string): (TrackSectors & { source?: string }) | undefined {
  return loadTrackGeometry(slug, gameId)?.sectors;
}

/** Persist a layout's facts and keep the in-process cache coherent. */
export function saveTrackFacts(slug: string, facts: TrackFacts): void {
  if (!slug) throw new Error("saveTrackFacts: slug required");
  if (!existsSync(trackFactsDir)) mkdirSync(trackFactsDir, { recursive: true });
  writeFileSync(resolve(trackFactsDir, `${slug}.json`), `${JSON.stringify(facts, null, 2)}\n`);
  factsCache.set(slug, facts);
}

/** Persist one game's geometry for a layout and keep the cache coherent. */
export function saveTrackGeometry(slug: string, gameId: string, geometry: TrackGeometry): void {
  if (!slug || !gameId) throw new Error("saveTrackGeometry: slug and gameId required");
  const dir = resolve(SHARED_DIR, "tracks", gameId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${slug}-segments.json`), `${JSON.stringify(geometry, null, 2)}\n`);
  geometryCache.set(`${gameId}:${slug}`, geometry);
}
