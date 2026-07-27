/**
 * One-shot migration: legacy per-game track meta -> facts + per-game geometry.
 *
 *   before  shared/tracks/meta/<slug>.json     name/group/direction duplicated
 *                                              in top-level segments AND in
 *                                              every games[gameId] block
 *
 *   after   shared/tracks/meta/<slug>.json              facts, no fractions
 *           shared/tracks/<gameId>/<slug>-segments.json geometry, no names
 *
 * Also folds the three layouts that got split across two roster files because
 * two games named the same tarmac differently (see MERGES), so the corner names
 * one game authored become visible to the other.
 *
 * Default is dry-run: reports what it would write and every unresolved name
 * conflict, touching nothing. Pass --write to persist.
 *
 * Usage:
 *   bun run scripts/migrate-track-meta.ts                 # dry-run
 *   bun run scripts/migrate-track-meta.ts --track spa     # one layout
 *   bun run scripts/migrate-track-meta.ts --write
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "../shared/resolve-data";
import type { NamedSegment as LegacyNamedSegment } from "../shared/track-named-segments";
import { cornerKey, straightKey } from "../shared/track-keys";
import type { CornerFact, StraightFact, TrackFacts } from "../shared/track-facts";
import type { TrackGeometry } from "../shared/track-geometry";

const META_DIR = resolve(SHARED_DIR, "tracks", "meta");
const TRACKS_DIR = resolve(SHARED_DIR, "tracks");

/**
 * Layouts split across two roster files because two games named the same
 * tarmac differently. `from` folds into `to` and is deleted.
 *
 * Each pairing is confirmed by centerline arc length, not by name similarity:
 *   brands-hatch-s   fm-2023 1.925km  == brands-hatch-indy ac-evo 1.910km
 *   cota             ac-evo  5.413km  == austin f1 5.496 / acc 5.411km
 *   nurburgring-full fm-2023 25.265km == nordschleife acc 25.181 / ac-evo 25.161km
 *
 * The nordschleife pairing is the one the plan left open. Forza's full circuit
 * is NOT nurburgring-nord (20.754km, the Nordschleife alone) — ACC's
 * "Nurburgring 24h" and AC Evo's Nordschleife both include the GP loop too.
 *
 * Each fold runs toward whichever slug the rest of the codebase already uses,
 * which keeps the merge cheap: `austin` and `nordschleife` own the ACC tune
 * folders and the track guide, and `brands-hatch-indy` is what AC Evo's roster
 * and geometry files are named.
 */
export const MERGES: { from: string; to: string }[] = [
  { from: "brands-hatch-s", to: "brands-hatch-indy" },
  { from: "cota", to: "austin" },
  { from: "nurburgring-full", to: "nordschleife" },
];

/**
 * The corner set for a layout is the union of every game's numbered corners.
 * Where a detector merged or missed a turn, the union is right and the short
 * game simply has no geometry row for it — `checkKeys` reports that as a
 * `missing` key so it shows up as a test failure rather than silently
 * shrinking the circuit. Known cases, all "one game folded a turn into its
 * neighbour": brands-hatch T7 (Sheene), catalunya T6 and T14, imola T8
 * (Piratella) and T13 (Rivazza 1), silverstone T5 (Aintree), spa T16
 * (Blanchimont), zandvoort T13 (Hans Ernst Bocht).
 */

/**
 * Physical corner direction where neither a majority nor the authored-name
 * tie-break can decide, because both sources named the corner and disagree.
 * Keyed slug -> corner key.
 */
const DIRECTION_OVERRIDES: Record<string, Record<string, "left" | "right">> = {
  // Eau Rouge is the uphill left-hand flick at the bottom of the hill; the
  // right that follows is Raidillon. f1-2025 has it left, ac-evo mirrored.
  spa: { t3: "left" },
};

/** `T1`, `T10-11`, `S3` are generated placeholders, not authored names. */
function isPlaceholderName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  return /^T\d+(?:[-/]\d+)*$/i.test(n) || /^S\d*\??$/i.test(n);
}

interface Args {
  track?: string;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--track") args.track = argv[++i];
  }
  return args;
}

export interface LegacyMeta {
  name: string;
  sectors?: { s1End: number; s2End: number; source?: string };
  segments?: LegacyNamedSegment[];
  games?: Record<string, { sectors?: { s1End: number; s2End: number; source?: string }; segments?: LegacyNamedSegment[] }>;
}

/** Per-game blocks, falling back to the top-level list for single-source files. */
export function gameBlocks(meta: LegacyMeta): Record<string, { sectors?: LegacyMeta["sectors"]; segments: LegacyNamedSegment[] }> {
  const games = meta.games ?? {};
  const keys = Object.keys(games);
  if (keys.length > 0) {
    const out: Record<string, { sectors?: LegacyMeta["sectors"]; segments: LegacyNamedSegment[] }> = {};
    for (const g of keys) out[g] = { sectors: games[g].sectors ?? meta.sectors, segments: games[g].segments ?? [] };
    return out;
  }
  return {};
}

/**
 * Assign every straight the turn it follows, wrapping at start/finish, and key
 * every corner by its turn numbers. Returns geometry rows plus the labels each
 * row carried, so the caller can vote on names without re-walking.
 */
interface KeyedRow {
  key: string;
  startFrac: number;
  endFrac: number;
  legacy: LegacyNamedSegment;
}

function keySegments(segs: LegacyNamedSegment[]): KeyedRow[] {
  const ordered = [...segs].sort((a, b) => a.startFrac - b.startFrac);
  const n = ordered.length;

  // Nearest numbered corner at or before each index, wrapping the lap.
  const precedingTurn = new Array<number | null>(n).fill(null);
  let last: number | null = null;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const s = ordered[i];
      if (s.type === "corner" && s.number != null) last = s.number;
      else if (pass === 1) precedingTurn[i] = last;
    }
  }

  return ordered.map((s, i): KeyedRow => {
    if (s.type === "corner" && s.number != null) {
      return { key: cornerKey([s.number, ...(s.covers ?? [])]), startFrac: s.startFrac, endFrac: s.endFrac, legacy: s };
    }
    const after = precedingTurn[i];
    return {
      key: after == null ? "s?" : straightKey(after),
      startFrac: s.startFrac,
      endFrac: s.endFrac,
      legacy: s,
    };
  });
}

/**
 * Pick the one agreed value across games. Reports genuine splits.
 *
 * `stripPlaceholders` drops generated labels (`T1`, `S3`) so an authored name
 * always beats a placeholder instead of conflicting with it — that substitution
 * is the entire point of sharing names between games.
 *
 * Groups pass `false`. A group label like `T9-10` looks generated but is a real
 * structural claim, "these apexes are one complex", and stripping it would lose
 * the grouping rather than just a name.
 */
function vote(values: string[], stripPlaceholders: boolean): { value: string; conflict: string[] | null } {
  const present = values
    .map((v) => (v ?? "").trim())
    .filter((v) => v && (!stripPlaceholders || !isPlaceholderName(v)));
  if (present.length === 0) return { value: "", conflict: null };
  const distinct = [...new Set(present.map((v) => v.toLowerCase()))];
  if (distinct.length === 1) return { value: present[0], conflict: null };
  return { value: present[0], conflict: [...new Set(present)] };
}

/**
 * Resolve a corner's physical direction across games.
 *
 * `direction` is recorded in each game's own coordinate frame, and several
 * extracted files are mirrored relative to the others — a physically
 * right-hand corner reads as left. So this is a vote, not a merge.
 *
 * Majority wins. On a tie, prefer the source that authored a real corner name:
 * a game whose corner is called "Paddock Hill Bend" was curated by hand, while
 * a bare "T1" came out of a geometry extractor and is the likelier mirror.
 */
function voteDirection(rows: LegacyNamedSegment[]): { value: "" | "left" | "right"; conflict: string[] | null } {
  const present = rows.filter((r) => r.direction === "left" || r.direction === "right");
  if (present.length === 0) return { value: "", conflict: null };

  const tally: Record<string, number> = {};
  for (const r of present) tally[r.direction!] = (tally[r.direction!] ?? 0) + 1;
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
    return { value: ranked[0][0] as "left" | "right", conflict: null };
  }

  const authored = [...new Set(present.filter((r) => !isPlaceholderName(r.name ?? "")).map((r) => r.direction!))];
  if (authored.length === 1) return { value: authored[0] as "left" | "right", conflict: null };

  return { value: ranked[0][0] as "left" | "right", conflict: ranked.map(([d, n]) => `${d}x${n}`) };
}

/** Physical venue plus which layout of it this roster describes. */
export interface LayoutIdentity {
  track: string;
  layout: string;
  layoutName: string;
}

/** Slug suffixes carry layout meaning but aren't derivable, so the reviewed
 *  slug -> layout table in the migration plan is the source. Parsing it beats
 *  re-typing 74 rows here, and keeps one copy of a hand-checked mapping. */
function parsePlanLayoutTable(): Record<string, { layout: string; layoutName: string }> {
  const out: Record<string, { layout: string; layoutName: string }> = {};
  const planPath = resolve(process.cwd(), "track-meta-migration-plan.md");
  if (!existsSync(planPath)) return out;
  for (const line of readFileSync(planPath, "utf-8").split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (m) out[m[1]] = { layout: m[2], layoutName: m[3] };
  }
  return out;
}

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

/**
 * Resolve venue + layout for every roster slug.
 *
 * The venue comes from grouping each game's track CSV by circuit name: every
 * row sharing a circuit name is a layout of one venue, and the shortest slug in
 * that group is the venue id (`brands-hatch` for `brands-hatch`/`brands-hatch-s`).
 * `mergedInto` redirects a slug that this migration folds away, so the surviving
 * roster inherits the layout identity of whichever source named it explicitly.
 */
export function buildIdentityMap(mergedInto: Record<string, string>): Record<string, LayoutIdentity> {
  const planTable = parsePlanLayoutTable();
  const identity: Record<string, LayoutIdentity> = {};
  const venueOf: Record<string, string> = {};
  const variantOf: Record<string, string> = {};

  for (const gameId of ["fm-2023", "acc", "ac-evo", "f1-2025"]) {
    const csvPath = resolve(SHARED_DIR, "games", gameId, "tracks.csv");
    if (!existsSync(csvPath)) continue;
    const lines = readFileSync(csvPath, "utf-8").trim().split("\n");
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
      (byVenue[cols[nameIdx]] ??= []).push(target);
      variantOf[target] ??= cols[variantIdx] ?? "";
    }
    for (const slugs of Object.values(byVenue)) {
      const venue = [...slugs].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      for (const s of slugs) venueOf[s] ??= venue;
    }
  }

  const sources: Record<string, string[]> = {};
  for (const [from, to] of Object.entries(mergedInto)) (sources[to] ??= []).push(from);

  for (const slug of new Set([...Object.keys(venueOf), ...Object.keys(planTable)])) {
    if (mergedInto[slug]) continue;
    const planned =
      planTable[slug] ?? sources[slug]?.map((s) => planTable[s]).find(Boolean);
    const fromVariant = VARIANT_LAYOUTS[(variantOf[slug] ?? "").toLowerCase()];
    identity[slug] = {
      track: venueOf[slug] ?? slug,
      layout: planned?.layout ?? fromVariant?.layout ?? "full",
      layoutName: planned?.layoutName ?? fromVariant?.layoutName ?? "Full",
    };
  }
  return identity;
}

export interface Conflict {
  slug: string;
  key: string;
  field: string;
  values: string[];
}

export function buildLayout(
  slug: string,
  meta: LegacyMeta,
  blocks: Record<string, { sectors?: LegacyMeta["sectors"]; segments: LegacyNamedSegment[] }>,
  identity: LayoutIdentity,
): { facts: TrackFacts; geometry: Record<string, TrackGeometry>; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const keyed: Record<string, KeyedRow[]> = {};
  for (const [gameId, block] of Object.entries(blocks)) keyed[gameId] = keySegments(block.segments);

  // ── corners ──
  const cornerRows = new Map<string, LegacyNamedSegment[]>();
  for (const rows of Object.values(keyed)) {
    for (const r of rows) {
      if (!r.key.startsWith("t")) continue;
      if (!cornerRows.has(r.key)) cornerRows.set(r.key, []);
      cornerRows.get(r.key)!.push(r.legacy);
    }
  }

  const corners: CornerFact[] = [];
  for (const [key, rows] of cornerRows) {
    const nums = key
      .slice(1)
      .split("-")
      .map((p) => Number.parseInt(p, 10));
    const nameVote = vote(rows.map((r) => r.name ?? ""), true);
    const override = DIRECTION_OVERRIDES[slug]?.[key];
    const dirVote = override ? { value: override, conflict: null } : voteDirection(rows);
    const groupVote = vote(rows.map((r) => r.group ?? ""), false);
    if (nameVote.conflict) conflicts.push({ slug, key, field: "name", values: nameVote.conflict });
    if (dirVote.conflict) conflicts.push({ slug, key, field: "direction", values: dirVote.conflict });
    if (groupVote.conflict) conflicts.push({ slug, key, field: "group", values: groupVote.conflict });

    corners.push({
      number: nums[0],
      ...(nums.length > 1 ? { covers: nums.slice(1) } : {}),
      name: nameVote.value,
      ...(dirVote.value ? { direction: dirVote.value as "left" | "right" } : {}),
      ...(groupVote.value ? { group: groupVote.value } : {}),
    });
  }
  corners.sort((a, b) => a.number - b.number);

  // ── named straights ──
  const straightRows = new Map<number, LegacyNamedSegment[]>();
  for (const rows of Object.values(keyed)) {
    for (const r of rows) {
      if (r.key.startsWith("t") || r.key === "s?") continue;
      const after = Number.parseInt(r.key.slice(1), 10);
      if (!straightRows.has(after)) straightRows.set(after, []);
      straightRows.get(after)!.push(r.legacy);
    }
  }

  const straights: StraightFact[] = [];
  for (const [after, rows] of straightRows) {
    const nameVote = vote(rows.map((r) => r.name ?? ""), true);
    const groupVote = vote(rows.map((r) => r.group ?? ""), false);
    if (nameVote.conflict) conflicts.push({ slug, key: `s${after}`, field: "name", values: nameVote.conflict });
    if (!nameVote.value && !groupVote.value) continue; // unnamed gap — derived, not a fact
    straights.push({ after, name: nameVote.value, ...(groupVote.value ? { group: groupVote.value } : {}) });
  }
  straights.sort((a, b) => a.after - b.after);

  const geometry: Record<string, TrackGeometry> = {};
  for (const [gameId, rows] of Object.entries(keyed)) {
    geometry[gameId] = {
      ...(blocks[gameId].sectors ? { sectors: blocks[gameId].sectors } : {}),
      segments: rows.map((r) => ({ key: r.key, startFrac: r.startFrac, endFrac: r.endFrac })),
    };
  }

  const facts: TrackFacts = {
    slug,
    ...identity,
    name: meta.name,
    corners,
    ...(straights.length ? { straights } : {}),
  };

  return { facts, geometry, conflicts };
}

/** Venue names the source rosters get wrong outright. */
const NAME_OVERRIDES: Record<string, string> = {
  "brands-hatch": "Brands Hatch", // Forza's roster ships the typo "Brand Hatch"
  "fujimi-kaido": "Fujimi Kaido", // meta carried the raw slug as its display name
};

/**
 * Give every layout of a venue the same plain venue name.
 *
 * Layout decoration ("— National", "(Grand Prix)") used to live in `name`
 * because there was nowhere else to put it; `layoutName` owns it now, so it is
 * stripped here. The venue's own base layout supplies the name, which keeps
 * `Silverstone — National` and `Silverstone Racing Circuit` from disagreeing
 * about what the place is called.
 */
function applyVenueNames(all: TrackFacts[]): void {
  const byTrack: Record<string, TrackFacts[]> = {};
  for (const f of all) (byTrack[f.track] ??= []).push(f);

  for (const [track, layouts] of Object.entries(byTrack)) {
    const base =
      layouts.find((l) => l.slug === track) ??
      layouts.reduce((a, b) => (a.slug.length <= b.slug.length ? a : b));
    // The bare-hyphen branch requires a following space so "Mid-Ohio" and
    // "Homestead-Miami" keep their hyphens while "Le Mans - Circuit …" loses
    // its trailing clause.
    const cleaned = base.name
      .replace(/\s*[—–]\s*.*$/, "")
      .replace(/\s+-\s+.*$/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    const venue = NAME_OVERRIDES[track] ?? cleaned ?? base.name;
    for (const l of layouts) l.name = venue || base.name;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const files = readdirSync(META_DIR).filter((f) => f.endsWith(".json"));

  const legacy: Record<string, LegacyMeta> = {};
  for (const f of files) legacy[f.replace(".json", "")] = JSON.parse(readFileSync(resolve(META_DIR, f), "utf-8"));

  // Fold merged layouts before deriving anything.
  const mergedAway: string[] = [];
  for (const { from, to } of MERGES) {
    if (!legacy[from] || !legacy[to]) {
      console.log(`  ! merge skipped, missing file: ${from} -> ${to}`);
      continue;
    }
    const fromBlocks = gameBlocks(legacy[from]);
    const toBlocks = gameBlocks(legacy[to]);
    for (const [gameId, block] of Object.entries(fromBlocks)) {
      if (toBlocks[gameId]) {
        console.log(`  ! ${to} already has ${gameId}; ${from} block dropped`);
        continue;
      }
      legacy[to].games = legacy[to].games ?? {};
      legacy[to].games![gameId] = { sectors: block.sectors, segments: block.segments };
    }
    mergedAway.push(from);
  }
  for (const s of mergedAway) delete legacy[s];

  const slugs = args.track ? [args.track].filter((s) => legacy[s]) : Object.keys(legacy).sort();
  if (slugs.length === 0) {
    console.error("no matching layout");
    process.exit(1);
  }

  const identityMap = buildIdentityMap(Object.fromEntries(MERGES.map(({ from, to }) => [from, to])));

  const allConflicts: Conflict[] = [];
  // Rosters no game currently maps to (their tracks.csv row has no slug). They
  // get a facts file with no corners rather than being left in the legacy shape,
  // so every file in meta/ has one shape for the loader and the tests.
  let dormant = 0;
  const built: { slug: string; facts: TrackFacts; geometry: Record<string, TrackGeometry> }[] = [];

  for (const slug of slugs) {
    const meta = legacy[slug];
    const blocks = gameBlocks(meta);
    if (Object.keys(blocks).length === 0) dormant++;
    const identity = identityMap[slug] ?? { track: slug, layout: "full", layoutName: "Full" };
    const { facts, geometry, conflicts } = buildLayout(slug, meta, blocks, identity);
    allConflicts.push(...conflicts);
    built.push({ slug, facts, geometry });
  }

  applyVenueNames(built.map((b) => b.facts));

  let wroteFacts = 0;
  let wroteGeom = 0;
  for (const { slug, facts, geometry } of built) {
    const games = Object.keys(geometry).join(", ");
    console.log(
      `[ok] ${slug}: "${facts.name}" [${facts.layoutName}] — ${facts.corners.length} corners, ` +
        `${facts.straights?.length ?? 0} named straights, games: ${games}`,
    );

    if (args.write) {
      writeFileSync(resolve(META_DIR, `${slug}.json`), `${JSON.stringify(facts, null, 2)}\n`);
      wroteFacts++;
      for (const [gameId, geom] of Object.entries(geometry)) {
        const dir = resolve(TRACKS_DIR, gameId);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, `${slug}-segments.json`), `${JSON.stringify(geom, null, 2)}\n`);
        wroteGeom++;
      }
    }
  }

  if (args.write) {
    for (const s of mergedAway) {
      const p = resolve(META_DIR, `${s}.json`);
      if (existsSync(p)) rmSync(p);
    }
  }

  console.log("");
  if (allConflicts.length) {
    console.log(`── ${allConflicts.length} unresolved conflict(s) ──`);
    for (const c of allConflicts) console.log(`  ${c.slug} ${c.key} ${c.field}: ${c.values.map((v) => `"${v}"`).join(" vs ")}`);
    console.log("");
  }
  console.log(
    `${slugs.length} layouts, ${dormant} dormant (no game maps to them), ` +
      `${mergedAway.length} merged away: ${mergedAway.join(", ")}`,
  );
  if (args.write) console.log(`wrote ${wroteFacts} facts files, ${wroteGeom} geometry files`);
  else console.log("(dry run — pass --write to persist)");

  process.exit(allConflicts.length > 0 ? 1 : 0);
}

if (import.meta.main) main();
