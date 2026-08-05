import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GAMES_DIR } from "../../shared/platform/runtime/data-paths";

/** Layouts folded into an existing roster before identity derivation. */
export const MERGES: { from: string; to: string }[] = [
  { from: "brands-hatch-s", to: "brands-hatch-indy" },
  { from: "cota", to: "austin" },
  { from: "nurburgring-full", to: "nordschleife" },
];

export interface LayoutIdentity {
  track: string;
  layout: string;
  layoutName: string;
}

/** Hand-reviewed layout identities; slug suffixes alone are not authoritative. */
const PLAN_LAYOUT_TABLE: Record<string, { layout: string; layoutName: string }> = {
  "brands-hatch": { layout: "gp", layoutName: "Grand Prix" },
  "brands-hatch-s": { layout: "indy", layoutName: "Indy" },
  catalunya: { layout: "gp", layoutName: "Grand Prix" },
  "catalunya-s": { layout: "national", layoutName: "National" },
  "catalunya-s2": { layout: "national-alt", layoutName: "National Alt" },
  daytona: { layout: "sports-car", layoutName: "Sports Car" },
  "daytona-oval": { layout: "oval", layoutName: "Tri-Oval" },
  eaglerock: { layout: "club", layoutName: "Club" },
  "eaglerock-oval": { layout: "oval", layoutName: "Oval" },
  "eaglerock-r": { layout: "club-reverse", layoutName: "Club Reverse" },
  "fujimi-kaido": { layout: "full", layoutName: "Full" },
  "fujimi-kaido-r": { layout: "full-reverse", layoutName: "Full Reverse" },
  "grand-oak": { layout: "national", layoutName: "National" },
  "grand-oak-r": { layout: "national-reverse", layoutName: "National Reverse" },
  "grand-oak-s": { layout: "club", layoutName: "Club" },
  hakone: { layout: "gp", layoutName: "Grand Prix" },
  "hakone-s": { layout: "club", layoutName: "Club" },
  "hakone-sr": { layout: "club-reverse", layoutName: "Club Reverse" },
  hockenheim: { layout: "full", layoutName: "Full" },
  "hockenheim-s": { layout: "national", layoutName: "National" },
  "hockenheim-s2": { layout: "short", layoutName: "Short" },
  homestead: { layout: "road", layoutName: "Road" },
  "homestead-oval": { layout: "speedway", layoutName: "Speedway" },
  indianapolis: { layout: "gp", layoutName: "Grand Prix" },
  "indianapolis-oval": { layout: "oval", layoutName: "The Brickyard Speedway" },
  kyalami: { layout: "gp", layoutName: "Grand Prix" },
  "laguna-seca": { layout: "full", layoutName: "Full" },
  "laguna-seca-s": { layout: "short", layoutName: "Short" },
  "le-mans": { layout: "full", layoutName: "Full" },
  "le-mans-old": { layout: "old-mulsanne", layoutName: "Old Mulsanne" },
  "lime-rock": { layout: "full", layoutName: "Full" },
  "lime-rock-alt": { layout: "full-alt", layoutName: "Full Alt" },
  "lime-rock-sc": { layout: "south-chicane", layoutName: "South Chicane" },
  "maple-valley": { layout: "full", layoutName: "Full" },
  "maple-valley-s": { layout: "short", layoutName: "Short" },
  "maple-valley-sr": { layout: "short-reverse", layoutName: "Short Reverse" },
  "mid-ohio": { layout: "full", layoutName: "Full" },
  "mid-ohio-s": { layout: "short", layoutName: "Short" },
  "mount-panorama": { layout: "full", layoutName: "Circuit" },
  mugello: { layout: "full", layoutName: "Full" },
  "mugello-s": { layout: "club", layoutName: "Club" },
  nurburgring: { layout: "gp", layoutName: "GP" },
  "nurburgring-full": { layout: "full", layoutName: "Full (GP + Nordschleife)" },
  "nurburgring-nord": { layout: "nordschleife", layoutName: "Nordschleife" },
  "nurburgring-s": { layout: "sprint", layoutName: "Sprint" },
  "road-america": { layout: "full", layoutName: "Full" },
  "road-america-s": { layout: "east", layoutName: "East Route" },
  "road-atlanta": { layout: "full", layoutName: "Full" },
  "road-atlanta-s": { layout: "club", layoutName: "Club" },
  sebring: { layout: "full", layoutName: "Full" },
  "sebring-s": { layout: "short", layoutName: "Short" },
  silverstone: { layout: "gp", layoutName: "Grand Prix" },
  "silverstone-s": { layout: "national", layoutName: "National" },
  "silverstone-s2": { layout: "international", layoutName: "International" },
  spa: { layout: "full", layoutName: "Full" },
  "sunset-peninsula": { layout: "full", layoutName: "Full" },
  "sunset-peninsula-oval": { layout: "speedway", layoutName: "Speedway" },
  "sunset-peninsula-r": { layout: "full-reverse", layoutName: "Full Reverse" },
  "sunset-peninsula-s": { layout: "club", layoutName: "Club" },
  "sunset-peninsula-sr": { layout: "club-reverse", layoutName: "Club Reverse" },
  suzuka: { layout: "full", layoutName: "Full" },
  "suzuka-s": { layout: "east", layoutName: "East" },
  vir: { layout: "full", layoutName: "Full" },
  "vir-ge": { layout: "grand-east", layoutName: "Grand East" },
  "vir-gw": { layout: "grand-west", layoutName: "Grand West" },
  "vir-n": { layout: "north", layoutName: "North" },
  "vir-s": { layout: "south", layoutName: "South" },
  "watkins-glen": { layout: "full", layoutName: "Full" },
  "watkins-glen-s": { layout: "short", layoutName: "Short" },
  "yas-marina": { layout: "full", layoutName: "Full" },
  "yas-marina-n": { layout: "north", layoutName: "North" },
  "yas-marina-nc": { layout: "north-corkscrew", layoutName: "North Corkscrew" },
  "yas-marina-s": { layout: "south", layoutName: "South" },
};

const VARIANT_LAYOUTS: Record<string, { layout: string; layoutName: string }> = {
  gp: { layout: "gp", layoutName: "Grand Prix" },
  "grand prix": { layout: "gp", layoutName: "Grand Prix" },
  "grand prix circuit": { layout: "gp", layoutName: "Grand Prix" },
  full: { layout: "full", layoutName: "Full" },
  "full circuit": { layout: "full", layoutName: "Full" },
  short: { layout: "short", layoutName: "Short" },
  "short circuit": { layout: "short", layoutName: "Short" },
  indy: { layout: "indy", layoutName: "Indy" },
};

/** Resolve venue and layout for every roster slug. */
export function buildIdentityMap(mergedInto: Record<string, string>): Record<string, LayoutIdentity> {
  const identity: Record<string, LayoutIdentity> = {};
  const venueOf: Record<string, string> = {};
  const variantOf: Record<string, string> = {};

  for (const gameId of ["fm-2023", "acc", "ac-evo", "f1-2025"]) {
    const csvPath = resolve(GAMES_DIR, gameId, "tracks.csv");
    if (!existsSync(csvPath)) continue;
    const lines = readFileSync(csvPath, "utf8").trim().split("\n");
    const header = lines[0].split(",").map((h) => h.trim());
    const nameIdx = header.indexOf("name");
    const variantIdx = header.indexOf("variant");
    const slugIdx = header.indexOf("commonTrackName");

    const byVenue: Record<string, string[]> = {};
    for (const line of lines.slice(1)) {
      const cols = line.split(",").map((c) => c.trim());
      const slug = cols[slugIdx];
      if (!slug) continue;
      const target = mergedInto[slug] ?? slug;
      let venueSlugs = byVenue[cols[nameIdx]];
      if (!venueSlugs) {
        venueSlugs = [];
        byVenue[cols[nameIdx]] = venueSlugs;
      }
      venueSlugs.push(target);
      variantOf[target] ??= cols[variantIdx] ?? "";
    }
    for (const slugs of Object.values(byVenue)) {
      const venue = [...slugs].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      for (const slug of slugs) venueOf[slug] ??= venue;
    }
  }

  const sources: Record<string, string[]> = {};
  for (const [from, to] of Object.entries(mergedInto)) {
    let sourceSlugs = sources[to];
    if (!sourceSlugs) {
      sourceSlugs = [];
      sources[to] = sourceSlugs;
    }
    sourceSlugs.push(from);
  }

  for (const slug of new Set([...Object.keys(venueOf), ...Object.keys(PLAN_LAYOUT_TABLE)])) {
    if (mergedInto[slug]) continue;
    const planned = PLAN_LAYOUT_TABLE[slug] ?? sources[slug]?.map((source) => PLAN_LAYOUT_TABLE[source]).find(Boolean);
    const fromVariant = VARIANT_LAYOUTS[(variantOf[slug] ?? "").toLowerCase()];
    identity[slug] = {
      track: venueOf[slug] ?? slug,
      layout: planned?.layout ?? fromVariant?.layout ?? "full",
      layoutName: planned?.layoutName ?? fromVariant?.layoutName ?? "Full",
    };
  }
  return identity;
}
