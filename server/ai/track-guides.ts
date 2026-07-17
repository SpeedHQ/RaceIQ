/**
 * Expert track guides providing corner-by-corner racing knowledge.
 *
 * This module enriches AI analysis with track-specific context that cannot be
 * derived from telemetry alone: corner characteristics, ideal techniques,
 * common traps, and priority corners for lap time.
 *
 * Sources: Driver61, Coach Dave Academy, DIY Sim Studio, Track Titan, official F1 circuit
 * guides, Wikipedia (corner naming cross-reference). Where a corner's official/common name
 * could not be independently verified, entries use generic "Turn N" labels rather than
 * inventing a name — see individual guide comments for tracks with layout-verification caveats
 * (e.g. Singapore, Las Vegas, Lusail).
 *
 * Corner naming is owned by track meta (shared/tracks/meta/<id>.json), not by
 * this file: entries anchor to official turn numbers and render under meta's
 * name for those turns. See `CornerGuide.numbers`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { SHARED_DIR } from "../../shared/resolve-data";
import { loadSharedTrackMeta } from "../../shared/track-data";
import { segmentDisplayName } from "../../shared/segment-label";
import type { ResolvedTrackGuide } from "../../shared/track-guide-types";

/**
 * A translatable prose string. English source of truth; localised variants opt
 * in per-field by growing to an object. Flat English (`"..."`) and
 * `{ en: "...", de: "..." }` are both valid — the loader resolves either via
 * `t()`, falling back to `en`. Structural fields (name, numbers, type key) stay
 * plain strings; only human-read coaching prose is localised.
 */
type Localized = string | Record<string, string>;

/** Resolve a Localized field to a string for the given locale, en-fallback. */
function t(value: Localized, locale = "en"): string {
  return typeof value === "string" ? value : (value[locale] ?? value.en ?? "");
}

interface CornerGuide {
  /**
   * Fallback label, used only when `numbers` can't be resolved against track
   * meta. Meta owns corner naming — this name is prose, not an identifier.
   */
  name: string;
  /**
   * Official turn numbers this entry coaches — the join key into track meta
   * (shared/tracks/meta/<id>.json). Names drift between sources (Piscine vs
   * Swimming Pool, Fairmont vs Grand Hotel Hairpin, Sainte Dévote vs Sainte
   * Devote) and between games; turn numbers don't. Where these are set,
   * `buildTrackGuideContext` renders meta's name for the turn rather than the
   * one above, so the guide can't coach a name the analyst prompt's corner
   * whitelist then rejects.
   *
   * Optional: absent where a guide predates its meta, the meta file is an
   * empty stub (sochi, fujimi-kaido), or the entry describes a straight.
   * Anything set here is asserted against meta by test/track-guide-anchor.test.ts.
   */
  numbers?: number[];
  /** Corner classification */
  type: Localized;
  /** Key technique in imperative form */
  technique: Localized;
  /** Common mistake / trap */
  trap: Localized;
  /** Optional human note / layout caveat (provenance only, not rendered) */
  note?: string;
}

interface TrackGuide {
  /** Matches track meta filename (e.g., "spa", "monza") */
  id: string;
  /** Track character in one line */
  character: Localized;
  /** Per-corner expert knowledge */
  corners: CornerGuide[];
  /** Corner names most critical for lap time (exit speed → long straight, or high-speed commitment) */
  priorityCorners: string[];
  /** Optional provenance: reference sources for this guide, one free-text string (humans only, not rendered) */
  sources?: string;
  /** Optional provenance: layout-verification caveats / notes (humans only, not rendered) */
  notes?: string;
}

const guidesDir = resolve(SHARED_DIR, "tracks", "guides");

/**
 * A translatable prose field: flat English, or `{ en, de, … }`. Object form
 * must carry `en` — it's the fallback `t()` resolves to for any missing locale,
 * so a variant without it could render "" for every unlisted locale.
 */
const LocalizedSchema: z.ZodType<Localized> = z.union([
  z.string(),
  z.record(z.string(), z.string()).refine((o) => typeof o.en === "string" && o.en.length > 0, {
    message: "localized object must include a non-empty `en` fallback",
  }),
]);

const CornerGuideSchema = z
  .object({
    name: z.string().min(1),
    numbers: z.array(z.number().int()).optional(),
    type: LocalizedSchema,
    technique: LocalizedSchema,
    trap: LocalizedSchema,
    note: z.string().optional(),
  })
  .strict();

const TrackGuideSchema = z
  .object({
    id: z.string().min(1),
    character: LocalizedSchema,
    corners: z.array(CornerGuideSchema),
    priorityCorners: z.array(z.string()),
    sources: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

/**
 * Guide-file shape validator, exported for the build-gate test — NOT run at
 * load. Guides are static repo assets; a malformed one is a source bug to catch
 * in CI, not a check to pay on every process start. Production trusts the files.
 */
export const TrackGuideFileSchema = TrackGuideSchema;

/**
 * Guides live one-per-track in shared/tracks/guides/<id>.json (bundled to
 * data/tracks/guides in compiled builds). Each carries its own `sources`/`notes`
 * provenance; those fields are for humans and don't affect rendering.
 */
const guides: TrackGuide[] = readdirSync(guidesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(resolve(guidesDir, f), "utf8")) as TrackGuide)
  .sort((a, b) => a.id.localeCompare(b.id));

// ─── Lookup logic ───

/** Normalise a display name for fuzzy matching */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[-–—_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keywords that map a display track name to a guide ID.
 * Order matters — first match wins. More specific patterns go first.
 */
const TRACK_KEYWORDS: [string[], string][] = [
  [["mount panorama", "bathurst"], "mount-panorama"],
  [["brands hatch", "brand hatch"], "brands-hatch"],
  [["laguna seca", "weathertech"], "laguna-seca"],
  // Nordschleife must be checked before the generic Nürburgring GP match below,
  // since "nürburgring nordschleife" / "nürburgring 24h" both contain "nurburgring".
  [["nordschleife", "nurburgring 24", "24h"], "nordschleife"],
  [["nürburgring", "nurburgring", "nuerburgring"], "nurburgring"],
  [["spa", "francorchamps"], "spa"],
  [["silverstone"], "silverstone"],
  [["monza"], "monza"],
  [["suzuka"], "suzuka"],
  [["imola", "enzo e dino"], "imola"],
  [["barcelona", "catalunya", "catalonia", "montmeló", "montmelo"], "catalunya"],
  [["zandvoort"], "zandvoort"],
  [["bahrain", "sakhir"], "sakhir"],
  [["jeddah"], "jeddah"],
  [["melbourne", "albert park"], "melbourne"],
  [["shanghai"], "shanghai"],
  [["miami"], "miami"],
  [["monaco", "monte carlo"], "monaco"],
  [["gilles villeneuve", "montreal"], "montreal"],
  [["red bull ring", "spielberg"], "spielberg"],
  [["hungaroring", "budapest"], "budapest"],
  [["baku"], "baku"],
  [["circuit of the americas", "cota", "austin"], "austin"],
  [["hermanos rodriguez", "hermanos rodríguez", "mexico city", "mexico"], "mexico-city"],
  [["interlagos", "jose carlos pace", "josé carlos pace", "sao paulo", "são paulo"], "interlagos"],
  [["yas marina", "abu dhabi"], "yas-marina"],
  [["paul ricard"], "paul-ricard"],
  [["misano"], "misano"],
  [["kyalami"], "kyalami"],
  [["donington"], "donington"],
  [["oulton park"], "oulton-park"],
  [["snetterton"], "snetterton"],
  [["watkins glen"], "watkins-glen"],
  [["marina bay", "singapore"], "singapore"],
  [["las vegas"], "las-vegas"],
  [["lusail"], "lusail"],
  [["road america"], "road-america"],
  [["road atlanta"], "road-atlanta"],
  [["indianapolis", "brickyard"], "indianapolis"],
  [["daytona"], "daytona"],
  [["virginia international", "vir "], "vir"],
  [["mid ohio", "mid-ohio"], "mid-ohio"],
  [["sochi"], "sochi"],
  [["algarve", "portimao", "portimão"], "portimao"],
  [["zolder"], "zolder"],
  [["ricardo tormo", "valencia"], "valencia"],
  [["mugello"], "mugello"],
  [["sebring"], "sebring"],
  [["le mans", "sarthe"], "le-mans"],
  [["lime rock"], "lime-rock"],
  [["homestead"], "homestead"],
  [["hockenheim"], "hockenheim"],
  [["maple valley"], "maple-valley"],
  [["fuji speedway", "fuji "], "fuji"],
  [["fujimi"], "fujimi-kaido"],
  [["sunset peninsula"], "sunset-peninsula"],
  [["grand oak"], "grand-oak"],
  [["hakone"], "hakone"],
  [["eaglerock"], "eaglerock"],
  [["hanoi"], "hanoi"],
];

/** Look up a guide by track meta ID (e.g., "spa") or display name */
function findGuide(trackNameOrId: string): TrackGuide | null {
  const norm = normalise(trackNameOrId);

  // Direct ID match first
  const direct = guides.find((g) => g.id === norm || g.id === trackNameOrId);
  if (direct) return direct;

  // Keyword search against display name
  for (const [keywords, id] of TRACK_KEYWORDS) {
    if (keywords.some((kw) => norm.includes(kw))) {
      return guides.find((g) => g.id === id) ?? null;
    }
  }

  return null;
}

/**
 * True only when a guide file exists whose id IS `trackId` — a direct match, no
 * keyword/fuzzy fallback. Coverage checks must use this, not buildTrackGuideContext:
 * findGuide's keyword fallback resolves a variant layout (e.g. "silverstone-s")
 * to the base circuit's guide, which would count an unguided layout as covered.
 */
export function hasTrackGuide(trackId: string): boolean {
  return guides.some((g) => g.id === trackId);
}

export interface TrackGuideOptions {
  /** Shared track slug (meta filename, e.g. "spa") — enables canonical naming. */
  slug?: string;
  /** Prefer this game's per-game segment names; falls back to the shared set. */
  gameId?: string;
  /**
   * Locale for coaching prose (character/type/technique/trap). Defaults to
   * "en"; unknown fields fall back to English. AI callers leave this unset —
   * the model localises its own output — so only user-facing surfaces (the
   * Info page route) need pass it.
   */
  locale?: string;
}

/**
 * Map each official turn number to the label track meta uses for it, so a
 * guide entry anchored to [14, 15] at Monaco renders "Piscine (14-15)" — the
 * same string the track map and the prompt's corner whitelist use — rather
 * than the guide's own "Swimming Pool".
 */
function metaLabelsByTurn(slug: string, gameId?: string): Map<number, string> {
  const out = new Map<number, string>();
  const meta = loadSharedTrackMeta(slug);
  if (!meta) return out;
  // Per-game segments win: a game's centerline can name or merge corners
  // differently from the shared set.
  const segments = (gameId ? meta.games?.[gameId]?.segments : undefined) ?? meta.segments ?? [];
  for (const s of segments) {
    if (s.type !== "corner" || !s.numbers?.length || !s.name) continue;
    const label = segmentDisplayName(s, 0);
    for (const n of s.numbers) out.set(n, label);
  }
  return out;
}

/**
 * Resolve one guide entry to the label the rest of the app uses for it.
 * Returns null when the entry's turns don't all belong to a single meta
 * segment — a partial match would mislabel, so the guide's own name is kept.
 */
function canonicalLabel(c: CornerGuide, labels: Map<number, string>): string | null {
  if (!c.numbers?.length || labels.size === 0) return null;
  const hit = labels.get(c.numbers[0]);
  if (!hit) return null;
  return c.numbers.every((n) => labels.get(n) === hit) ? hit : null;
}

/**
 * The same knowledge `buildTrackGuideContext` puts in the prompt, structured.
 *
 * Shares the label resolution and the merge rule with the prompt builder, so
 * what the Info page shows is what the coach was told — if these two could
 * drift, the page would be documenting a guide that doesn't exist.
 */
export function getTrackGuide(trackName: string, opts: TrackGuideOptions = {}): ResolvedTrackGuide | null {
  const guide = findGuide(opts.slug ?? trackName);
  if (!guide) return null;
  const labels = opts.slug ? metaLabelsByTurn(opts.slug, opts.gameId) : new Map<number, string>();
  const labelFor = (c: CornerGuide) => canonicalLabel(c, labels) ?? c.name;
  const isPriority = (c: CornerGuide) => guide.priorityCorners.includes(c.name);

  const byLabel = new Map<string, CornerGuide[]>();
  for (const c of guide.corners) {
    const label = labelFor(c);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(c);
    else byLabel.set(label, [c]);
  }

  const locale = opts.locale;
  return {
    id: guide.id,
    character: t(guide.character, locale),
    corners: [...byLabel].map(([label, entries]) => ({
      label,
      type: entries.map((e) => t(e.type, locale)).join("; "),
      technique: entries.map((e) => t(e.technique, locale)).join(" "),
      trap: entries.map((e) => t(e.trap, locale)).join("; "),
      numbers: entries.flatMap((e) => e.numbers ?? []).sort((a, b) => a - b),
      priority: entries.some(isPriority),
    })),
  };
}

/** The corner labels a guide will actually emit for this track/game. */
export function guideCornerLabels(trackName: string, opts: TrackGuideOptions = {}): string[] {
  const guide = findGuide(opts.slug ?? trackName);
  if (!guide) return [];
  const labels = opts.slug ? metaLabelsByTurn(opts.slug, opts.gameId) : new Map<number, string>();
  return [...new Set(guide.corners.map((c) => canonicalLabel(c, labels) ?? c.name))];
}

/**
 * Build a formatted track guide context block for AI prompts.
 * Returns empty string if no guide is available for the given track.
 *
 * Pass `slug`/`gameId` wherever they're known: without them the guide falls
 * back to its own corner names, which may not match the names the prompt
 * elsewhere tells the model are the only legal ones.
 */
export function buildTrackGuideContext(trackName: string, opts: TrackGuideOptions = {}): string {
  const guide = findGuide(opts.slug ?? trackName);
  if (!guide) return "";

  const labels = opts.slug ? metaLabelsByTurn(opts.slug, opts.gameId) : new Map<number, string>();
  const labelFor = (c: CornerGuide) => canonicalLabel(c, labels) ?? c.name;

  let out = "\n--- Expert Track Guide ---\n";
  out += `${t(guide.character, opts.locale)}\n\n`;
  out += "Corner-by-corner knowledge (use this to assess whether the driver is using correct technique):\n";

  // A guide may split what meta treats as one segment (Monaco's Rascasse and
  // Antony Noghès are two entries here, one "Rascasse / Antony Noghès" segment
  // in meta). Emitting both would print the same label twice and read as two
  // corners — merge them into the one bullet that label describes.
  const byLabel = new Map<string, CornerGuide[]>();
  for (const c of guide.corners) {
    const label = labelFor(c);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(c);
    else byLabel.set(label, [c]);
  }

  for (const [label, entries] of byLabel) {
    const type = entries.map((e) => t(e.type, opts.locale)).join("; ");
    const technique = entries.map((e) => t(e.technique, opts.locale)).join(" ");
    const trap = entries.map((e) => t(e.trap, opts.locale)).join("; ");
    out += `• ${label} [${type}]: ${technique}. TRAP: ${trap}\n`;
  }

  // priorityCorners reference guide corner names; re-point them at the same
  // canonical labels so the two lists can't name the same corner differently.
  // Dedupe: two priority entries can merge onto one label, as above.
  const priority = [
    ...new Set(
      guide.priorityCorners.map((p) => {
        const c = guide.corners.find((x) => x.name === p);
        return c ? labelFor(c) : p;
      }),
    ),
  ];

  out += `\nPriority corners (most impactful on lap time): ${priority.join(", ")}\n`;
  out += "Use this track knowledge to give context-aware coaching. If telemetry shows issues at a priority corner, weight it higher in your analysis.\n";

  return out;
}

/**
 * Returns the list of track IDs that have guides available.
 * Useful for UI indicators showing which tracks have expert knowledge.
 */
export function getAvailableTrackGuides(): string[] {
  return guides.map((g) => g.id);
}
