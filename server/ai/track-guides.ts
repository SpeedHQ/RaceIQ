/**
 * Expert track guides providing corner-by-corner racing knowledge.
 *
 * This module enriches AI analysis with track-specific context that cannot be
 * derived from telemetry alone: corner characteristics, ideal techniques,
 * common traps, and priority corners for lap time.
 *
 * The guide content itself lives in `shared/tracks/guides/<slug>.json`, one
 * file per track, each carrying its own `sources` and `notes` (Driver61, Coach
 * Dave Academy, DIY Sim Studio, Track Titan, official F1 circuit guides,
 * Wikipedia for corner-name cross-reference). Where a corner's official/common
 * name could not be independently verified, entries use generic "Turn N"
 * labels rather than inventing a name; the per-file `notes` record tracks with
 * layout-verification caveats (e.g. Singapore, Las Vegas, Lusail).
 *
 * This module owns only *resolution*: name → guide, and guide → the labels the
 * rest of the app uses.
 *
 * Corner naming is owned by track meta (shared/tracks/meta/<id>.json), not by
 * this file: entries anchor to official turn numbers and render under meta's
 * name for those turns. See `TrackGuideCornerFile.numbers` in shared/track-guide-types.ts.
 */

import { loadTrackFacts } from "../../shared/track-data";
import { cornerNumbers } from "../../shared/track-facts";
import { cornerPromptLabel } from "../../shared/segment-label";
import { listTrackGuideSlugs, loadTrackGuide } from "../../shared/track-guide-data";
import type { ResolvedTrackGuide, TrackGuideCornerFile, TrackGuideFile } from "../../shared/track-guide-types";

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
  // Never bare "fuji": Forza's fantasy "Fujimi Kaido" contains it and has its
  // own guide below.
  [["fuji speedway", "fuji international"], "fuji"],
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
  [["fujimi"], "fujimi-kaido"],
  [["sunset peninsula"], "sunset-peninsula"],
  [["grand oak"], "grand-oak"],
  [["hakone"], "hakone"],
  [["eaglerock"], "eaglerock"],
  [["hanoi"], "hanoi"],
];

/** Look up a guide by track meta ID (e.g., "spa") or display name */
function findGuide(trackNameOrId: string): TrackGuideFile | null {
  const norm = normalise(trackNameOrId);

  // Direct ID match first
  const direct = loadTrackGuide(norm) ?? loadTrackGuide(trackNameOrId);
  if (direct) return direct;

  // Keyword search against display name
  for (const [keywords, id] of TRACK_KEYWORDS) {
    if (keywords.some((kw) => norm.includes(kw))) {
      return loadTrackGuide(id);
    }
  }

  return null;
}

interface TrackGuideOptions {
  /** Shared track slug (meta filename, e.g. "spa") — enables canonical naming. */
  slug?: string;
}

/**
 * Map each official turn number to the label track meta uses for it, so a
 * guide entry anchored to [14, 15] at Monaco renders "Piscine (14-15)" — the
 * same string the track map and the prompt's corner whitelist use — rather
 * than the guide's own "Swimming Pool".
 *
 * Facts only: a corner's name, numbering and complex are properties of the
 * circuit, identical in every game, so this takes no gameId.
 */
function metaLabelsByTurn(slug: string): Map<number, string> {
  const out = new Map<number, string>();
  const facts = loadTrackFacts(slug);
  if (!facts) return out;
  for (const corner of facts.corners) {
    const nums = cornerNumbers(corner);
    // Group-collapsed labels: every turn of a complex maps to the one label for
    // the whole complex, so a guide entry spanning it resolves (each member
    // carrying its own label would make `canonicalLabel` see a partial match and
    // fall back to the guide's own name).
    const members = corner.group ? facts.corners.filter((c) => c.group === corner.group) : [corner];
    const name = corner.group || corner.name;
    // Facts leave a turn the circuit doesn't name empty; `T3` / `T3-4` is the
    // token the rest of the app renders for it.
    const label = name ? cornerPromptLabel(name, members.flatMap(cornerNumbers)) : `T${nums.join("-")}`;
    for (const n of nums) out.set(n, label);
  }
  return out;
}

/**
 * Resolve one guide entry to the label the rest of the app uses for it.
 * Returns null when the entry's turns don't all belong to a single meta
 * segment — a partial match would mislabel, so the guide's own name is kept.
 */
function canonicalLabel(c: TrackGuideCornerFile, labels: Map<number, string>): string | null {
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
  const labels = opts.slug ? metaLabelsByTurn(opts.slug) : new Map<number, string>();
  const labelFor = (c: TrackGuideCornerFile) => canonicalLabel(c, labels) ?? c.name;
  const isPriority = (c: TrackGuideCornerFile) => guide.priorityCorners.includes(c.key);

  const byLabel = new Map<string, TrackGuideCornerFile[]>();
  for (const c of guide.corners) {
    const label = labelFor(c);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(c);
    else byLabel.set(label, [c]);
  }

  return {
    id: guide.id,
    character: guide.character,
    corners: [...byLabel].map(([label, entries]) => ({
      label,
      type: entries.map((e) => e.type).join("; "),
      technique: entries.map((e) => e.technique).join(" "),
      trap: entries.map((e) => e.trap).join("; "),
      numbers: entries.flatMap((e) => e.numbers ?? []).sort((a, b) => a - b),
      priority: entries.some(isPriority),
    })),
  };
}

/** The corner labels a guide will actually emit for this track. */
export function guideCornerLabels(trackName: string, opts: TrackGuideOptions = {}): string[] {
  const guide = findGuide(opts.slug ?? trackName);
  if (!guide) return [];
  const labels = opts.slug ? metaLabelsByTurn(opts.slug) : new Map<number, string>();
  return [...new Set(guide.corners.map((c) => canonicalLabel(c, labels) ?? c.name))];
}

/**
 * Build a formatted track guide context block for AI prompts.
 * Returns empty string if no guide is available for the given track.
 *
 * Pass `slug` wherever it's known: without it the guide falls
 * back to its own corner names, which may not match the names the prompt
 * elsewhere tells the model are the only legal ones.
 */
export function buildTrackGuideContext(trackName: string, opts: TrackGuideOptions = {}): string {
  const guide = findGuide(opts.slug ?? trackName);
  if (!guide) return "";

  const labels = opts.slug ? metaLabelsByTurn(opts.slug) : new Map<number, string>();
  const labelFor = (c: TrackGuideCornerFile) => canonicalLabel(c, labels) ?? c.name;

  let out = "\n--- Expert Track Guide ---\n";
  out += `${guide.character}\n\n`;
  out += "Corner-by-corner knowledge (use this to assess whether the driver is using correct technique):\n";

  // A guide may split what meta treats as one segment (Monaco's Rascasse and
  // Antony Noghès are two entries here, one "Rascasse / Antony Noghès" segment
  // in meta). Emitting both would print the same label twice and read as two
  // corners — merge them into the one bullet that label describes.
  const byLabel = new Map<string, TrackGuideCornerFile[]>();
  for (const c of guide.corners) {
    const label = labelFor(c);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(c);
    else byLabel.set(label, [c]);
  }

  for (const [label, entries] of byLabel) {
    const type = entries.map((e) => e.type).join("; ");
    const technique = entries.map((e) => e.technique).join(" ");
    const trap = entries.map((e) => e.trap).join("; ");
    out += `• ${label} [${type}]: ${technique}. TRAP: ${trap}\n`;
  }

  // priorityCorners reference guide corner keys (locale-independent); re-point
  // them at the same canonical labels so the two lists can't name the same
  // corner differently. Dedupe: two priority entries can merge onto one label,
  // as above.
  const priority = [
    ...new Set(
      guide.priorityCorners.map((key) => {
        const c = guide.corners.find((x) => x.key === key);
        return c ? labelFor(c) : key;
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
  return listTrackGuideSlugs();
}
