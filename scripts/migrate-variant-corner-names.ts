/**
 * Propagate corner names from a named parent layout to its unnamed variants.
 *
 *   before  shared/data/tracks/meta/silverstone.json    T9 "Copse"
 *           shared/data/tracks/meta/silverstone-s.json  T1 <unnamed>
 *   after   shared/data/tracks/meta/silverstone-s.json  T1 "Copse"
 *
 * Variants of the same circuit share `track` in their facts file, so a
 * variant's turn 1 is very often a parent turn under a different number. The
 * only reliable link between the two is physical position: both layouts have
 * geometry (segment start/end fractions) over a centerline, so a corner's apex
 * resolves to a world coordinate that is directly comparable — but ONLY within
 * a single game, since each game has its own coordinate system. Cross-game
 * pairs (nordschleife/acc vs nurburgring-nord/fm-2023) are skipped for that
 * reason even though they are the same physical circuit.
 *
 * Deliberately conservative. This only ever ADDS a name to a corner that has
 * none — never overwrites, never renumbers, never deletes. A name transfers
 * only when the apexes are within MAX_APEX_DIST_M and the pairing is
 * one-to-one, which is what stops a variant that merges or splits a parent
 * corner (catalunya-s doubling up on Campsa, vir-gw hitting Climbing Esses
 * five times) from smearing one name across several corners.
 *
 * Dry run by default; pass --write to apply.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHARED_DIR } from "../shared/platform/runtime/data-paths"
import type { CornerFact, TrackFacts } from "../shared/racing/tracks/facts";
import type { TrackGeometry } from "../shared/racing/tracks/geometry";

const META_DIR = resolve(SHARED_DIR, "tracks", "meta");
const TRACKS_DIR = resolve(SHARED_DIR, "tracks");

/** Max apex separation for a name to carry across layouts. */
const MAX_APEX_DIST_M = 25;

type Point = [number, number];

/** Games that ship their own per-layout geometry, in preference order. */
function candidateGames(): string[] {
  return readdirSync(TRACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !["meta", "tumftm"].includes(d.name))
    .map((d) => d.name);
}

function loadFacts(slug: string): TrackFacts | null {
  const p = resolve(META_DIR, `${slug}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as TrackFacts;
}

function loadGeometry(slug: string, game: string): TrackGeometry | null {
  const p = resolve(TRACKS_DIR, game, `${slug}-segments.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as TrackGeometry;
}

/** Centerlines are named `<slug>-centerline.csv` or `<slug>-<ordinal>-centerline.csv`. */
function loadCenterline(slug: string, game: string): Point[] | null {
  const dir = resolve(TRACKS_DIR, game);
  if (!existsSync(dir)) return null;
  const re = new RegExp(`^${slug}(?:-[0-9]+)?-centerline\\.csv$`);
  const file = readdirSync(dir).find((f) => re.test(f));
  if (!file) return null;
  const rows = readFileSync(resolve(dir, file), "utf-8").trim().split(/\r?\n/).slice(1);
  const pts = rows
    .map((l): Point => {
      const [x, y] = l.split(",");
      return [Number(x), Number(y)];
    })
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return pts.length ? pts : null;
}

/** Geometry key for a fact: `t` + every turn number it covers, ascending. */
function cornerKey(c: CornerFact): string {
  return `t${[c.number, ...(c.covers ?? [])].sort((a, b) => a - b).join("-")}`;
}

/** World position of each named-or-unnamed corner's apex, keyed by corner number. */
function apexes(facts: TrackFacts, geom: TrackGeometry, line: Point[]): Map<number, Point> {
  const byKey = new Map(geom.segments.map((s) => [s.key, s]));
  const out = new Map<number, Point>();
  for (const c of facts.corners ?? []) {
    const seg = byKey.get(cornerKey(c));
    if (!seg) continue;
    const mid = (seg.startFrac + seg.endFrac) / 2;
    const idx = Math.min(line.length - 1, Math.max(0, Math.round(mid * line.length)));
    out.set(c.number, line[idx]);
  }
  return out;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

const write = process.argv.includes("--write");
const games = candidateGames();

// Group layouts by physical circuit.
const groups = new Map<string, TrackFacts[]>();
for (const f of readdirSync(META_DIR).filter((x) => x.endsWith(".json"))) {
  const facts = loadFacts(f.replace(".json", ""));
  if (facts?.track) groups.set(facts.track, [...(groups.get(facts.track) ?? []), facts]);
}

const named = (f: TrackFacts) => (f.corners ?? []).filter((c) => (c.name ?? "").trim()).length;

let totalApplied = 0;
let totalRejected = 0;

for (const [track, layouts] of [...groups].sort()) {
  if (layouts.length < 2) continue;
  const donor = [...layouts].sort((a, b) => named(b) - named(a))[0];
  if (named(donor) === 0) continue;

  for (const recipient of layouts) {
    if (recipient.slug === donor.slug) continue;
    const missing = (recipient.corners ?? []).filter((c) => !(c.name ?? "").trim());
    if (!missing.length) continue;

    // Both layouts must have geometry in the same game to be comparable.
    const game = games.find(
      (g) =>
        loadGeometry(donor.slug, g) &&
        loadGeometry(recipient.slug, g) &&
        loadCenterline(donor.slug, g) &&
        loadCenterline(recipient.slug, g),
    );
    if (!game) {
      console.log(`${recipient.slug.padEnd(22)} skip — no shared game geometry with ${donor.slug}`);
      continue;
    }

    const dApex = apexes(donor, loadGeometry(donor.slug, game)!, loadCenterline(donor.slug, game)!);
    const rApex = apexes(
      recipient,
      loadGeometry(recipient.slug, game)!,
      loadCenterline(recipient.slug, game)!,
    );
    const donorName = new Map(
      (donor.corners ?? [])
        .filter((c) => (c.name ?? "").trim())
        .map((c) => [c.number, c.name!.trim()]),
    );

    // Score every candidate pairing, then greedily take the closest first so
    // each donor corner is consumed exactly once.
    const pairs: { rNum: number; dNum: number; d: number }[] = [];
    for (const c of missing) {
      const rp = rApex.get(c.number);
      if (!rp) continue;
      for (const [dNum, dp] of dApex) {
        if (!donorName.has(dNum)) continue;
        const d = dist(rp, dp);
        if (d <= MAX_APEX_DIST_M) pairs.push({ rNum: c.number, dNum, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    const usedDonor = new Set<number>();
    const usedRecip = new Set<number>();
    const applied: string[] = [];
    for (const p of pairs) {
      if (usedDonor.has(p.dNum) || usedRecip.has(p.rNum)) {
        totalRejected++;
        continue;
      }
      usedDonor.add(p.dNum);
      usedRecip.add(p.rNum);
      const corner = (recipient.corners ?? []).find((c) => c.number === p.rNum)!;
      corner.name = donorName.get(p.dNum)!;
      applied.push(`T${p.rNum}="${corner.name}" (${donor.slug} T${p.dNum}, ${p.d.toFixed(0)}m)`);
    }

    if (applied.length) {
      totalApplied += applied.length;
      console.log(
        `${recipient.slug.padEnd(22)} +${String(applied.length).padStart(2)} from ${donor.slug} [${game}]`,
      );
      for (const a of applied) console.log(`    ${a}`);
      if (write) {
        writeFileSync(
          resolve(META_DIR, `${recipient.slug}.json`),
          `${JSON.stringify(recipient, null, 2)}\n`,
        );
      }
    }
  }
}

console.log(
  `\n${write ? "applied" : "would apply"} ${totalApplied} names; ${totalRejected} candidate pairings rejected as ambiguous`,
);
if (!write) console.log("dry run — pass --write to apply");
