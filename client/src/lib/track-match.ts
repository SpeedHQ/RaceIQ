// Canonicalise a track name so RaceIQ's short names (e.g. "Monza",
// "Nurburgring") match the community leaderboard's formal names (e.g.
// "Autodromo Nazionale di Monza", "Nürburgring"). Strips diacritics,
// punctuation, 4-digit year/variant suffixes and filler words ("circuit",
// "of", "de"…), then folds a handful of distinct aliases (Imola↔Enzo e Dino
// Ferrari, Barcelona↔Catalunya, …) onto a single canonical token.
const TRACK_ALIASES: [RegExp, string][] = [
  [/enzo e dino ferrari/, "imola"],
  [/ricardo tormo/, "valencia"],
  [/catalunya/, "barcelona"],
  [/of the americas/, "cota"],
  [/mount panorama/, "bathurst"],
  [/spielberg|red bull ring/, "redbullring"],
  [/nazionale di monza/, "monza"],
  [/spa[\s-]?francorchamps/, "spa"],
  // FM's catalog misspells it "Brand Hatch" (singular); every other source
  // uses "Brands Hatch". Fold both spellings onto one base token.
  [/brands? hatch/, "brandshatch"],
];

const TRACK_STOPWORDS = new Set(["circuit", "of", "the", "de", "du", "di", "autodromo", "nazionale", "internazionale", "gp", "national", "park", "24h"]);

export function normalizeTrack(raw: string): string {
  let s = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, " ").replace(/\b\d{4}\b/g, " ");
  for (const [re, rep] of TRACK_ALIASES) s = s.replace(re, rep);
  return s
    .split(/\s+/)
    .filter((t) => t && !TRACK_STOPWORDS.has(t))
    .join(" ")
    .trim();
}

// Layout tokens that distinguish two configurations sharing a base name
// (Brands Hatch GP vs Indy, Laguna Seca Full vs Short, …). Matched against the
// RAW string (before normalizeTrack strips "gp"/"national" as stopwords).
// First match wins, so order the specific/secondary layouts before the
// primary "gp"/"full" — e.g. "Full Reverse" must resolve to "reverse", not
// "full". Only tokens that are unambiguously a layout (never part of a base
// track name) belong here; "international"/"road"/"speedway" are deliberately
// omitted because they double as name words (Sebring International, …).
const LAYOUT_TOKENS: [RegExp, string][] = [
  [/\bnordschleife\b/, "nordschleife"],
  [/\bsprint\b/, "sprint"],
  [/\bindy\b/, "indy"],
  [/\bnational\b/, "national"],
  [/\bclub\b/, "club"],
  [/\bcorkscrew\b/, "corkscrew"],
  [/\bchicane\b/, "chicane"],
  [/\boval\b/, "oval"],
  [/\breverse\b/, "reverse"],
  [/\beast\b/, "east"],
  [/\bwest\b/, "west"],
  [/\bnorth\b/, "north"],
  [/\bsouth\b/, "south"],
  [/\broute\b/, "route"],
  [/\bshort\b/, "short"],
  [/\bgrand prix\b|\bgp\b/, "gp"],
  [/\bfull\b/, "full"],
];

// The primary/most-common layouts. Community leaderboard rows are usually bare
// (no layout token) and, by convention, refer to the primary circuit — so a
// bare row is only compatible with a primary RaceIQ variant. Any labelled
// secondary variant (Indy, Short, Club, North, Reverse, …) must instead find a
// community row that explicitly names its layout, else it shows nothing rather
// than soaking up the primary's times.
const PRIMARY_LAYOUTS = new Set(["gp", "full"]);

function trackLayout(raw: string): string {
  const s = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  for (const [re, tag] of LAYOUT_TOKENS) if (re.test(s)) return tag;
  return "";
}

function isSecondary(layout: string): boolean {
  return layout !== "" && !PRIMARY_LAYOUTS.has(layout);
}

function layoutsCompatible(a: string, b: string): boolean {
  if (a && b) return a === b; // both declare a layout → must agree
  // Exactly one side is bare (primary by convention); a declared secondary
  // layout on the other side is incompatible with it.
  return !isSecondary(a) && !isSecondary(b);
}

// Match a community leaderboard track string against a RaceIQ track name +
// optional variant. Base names match on equality or substring containment;
// layouts (GP/Indy/Short/…) must be compatible so e.g. the 3.70 km Brands
// Hatch GP references don't leak onto the 1.93 km Indy layout page.
export function tracksMatch(community: string, name: string, variant = ""): boolean {
  const cBase = normalizeTrack(community);
  const nBase = normalizeTrack(name);
  if (!cBase || !nBase) return false;
  const baseMatch = cBase === nBase || cBase.includes(nBase) || nBase.includes(cBase);
  if (!baseMatch) return false;
  return layoutsCompatible(trackLayout(community), trackLayout(`${name} ${variant}`));
}
