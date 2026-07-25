import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { turnNumbers } from "../shared/segment-label";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { buildTrackGuideContext, guideCornerLabels, getAvailableTrackGuides } from "../server/ai/track-guides";

initGameAdapters();
initServerGameAdapters();

/**
 * Track meta (shared/tracks/meta/<id>.json) owns corner naming; the expert
 * guides own technique. They join on official turn numbers.
 *
 * These tests are the checksum for that join. A guide entry anchored to a turn
 * the circuit doesn't have is a defect — the guide would silently coach a
 * corner that doesn't exist, and (worse) the analyst prompt would whitelist its
 * name, teaching the model that name is legitimate.
 */

const META_DIR = resolve(import.meta.dir, "../shared/tracks/meta");

type Seg = { type: string; name?: string; number?: number; covers?: number[] };

/** Official turn numbers a meta segment accounts for (name is optional here). */
const numsOf = (s: Seg) => turnNumbers({ number: s.number, covers: s.covers });
type Meta = { segments?: Seg[]; games?: Record<string, { segments?: Seg[] }> };

function loadMeta(slug: string): Meta | null {
  const p = resolve(META_DIR, `${slug}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Meta;
}

/** Every turn number meta knows about for a slug, across shared + per-game sets. */
function knownTurns(meta: Meta): Set<number> {
  const out = new Set<number>();
  const add = (segs?: Seg[]) => (segs ?? []).forEach((s) => numsOf(s).forEach((n) => out.add(n)));
  add(meta.segments);
  for (const g of Object.values(meta.games ?? {})) add(g.segments);
  return out;
}

// Parsed from source: the guides array isn't exported, and the anchors are the
// thing under test, so read them the way a reviewer would.
function guideAnchors(): { slug: string; name: string; numbers: number[] }[] {
  const src = readFileSync(resolve(import.meta.dir, "../server/ai/track-guides.ts"), "utf8");
  const out: { slug: string; name: string; numbers: number[] }[] = [];
  let slug = "";
  for (const line of src.split("\n")) {
    const id = line.match(/^\s*id: "([a-z0-9-]+)"/);
    if (id) {
      slug = id[1];
      continue;
    }
    const c = line.match(/^\s*\{ name: "([^"]+)", numbers: \[([0-9, ]*)\]/);
    if (c && slug) {
      out.push({
        slug,
        name: c[1],
        numbers: c[2].split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)),
      });
    }
  }
  return out;
}

/**
 * Guide entries deliberately left unanchored, with the reason. This is a defect
 * register, not a suppression list: the test below asserts it matches reality
 * exactly, so it fails both ways — a new unanchored entry must be justified
 * here, and one that gets anchored fails as stale.
 *
 * Fantasy Forza layouts (grand-oak, hakone, eaglerock, maple-valley,
 * sunset-peninsula, fujimi-kaido) are exempt entirely: they have no real-world
 * turn numbering to defer to, and their guides are generic filler.
 */
const KNOWN_ANCHOR_GAPS: Record<string, string[]> = {
  // Straights. `numbers` is corner-only, and meta already names these exactly
  // as the guide does, so there is no drift to anchor away.
  "mount-panorama": ["Mountain Straight", "Conrod Straight"],
  montreal: ["Wall of Champions"],
  interlagos: ["Subida dos Boxes"],

  // META IS INCOMPLETE, GUIDE IS RIGHT — do not "fix" by forcing a match.
  // ACC's centerline is fastlane.ai's racing line, which straightens shallow
  // corners away entirely (see #84's KNOWN_DETECTOR_GAPS and #98).
  // Circuit Ricardo Tormo has 14 turns; meta detected 8.
  valencia: ["Turn 9", "Turn 12"],
  // Misano has 16 turns; meta detected 11. Tramonto is real (~T13).
  misano: ["Tramonto"],
  // Real GP corner names; meta leaves T7/T8/T10/T11 unnamed.
  nurburgring: ["Bit-Kurve", "Veedol"],
  // Fuchsröhre belongs between Aremberg (21) and Adenauer Forst (22-24);
  // meta has no segment there.
  nordschleife: ["Fuchsröhre", "Döttinger Höhe"],
  // meta numbering is self-inconsistent here: New Holland is 16 while T14 is
  // 14, and 13/15 are absent. The post-2023 layout has 14 turns.
  catalunya: ["Turn 12-13", "Turn 14-15"],

  // Region spans several meta segments, so no single segment to anchor to.
  "yas-marina": ["Hotel Corners", "Marina Section"],
  // Motodrom spans Sachskurve (12) .. Südkurve (15-17) — several segments.
  // "Turn 6": the guide calls it a fast right *onto* the back straight, but
  // meta's T6 is the Spitzkehre hairpin at the *end* of it. The guide and meta
  // number Hockenheim differently; anchoring by label would mislabel.
  hockenheim: ["Motodrom", "Turn 6"],
  "mid-ohio": ["Madness", "Thunder Valley", "Carousel"], // meta has no T3, 4-13 unnamed
  zolder: ["Kanaalbocht", "Butte"], // meta leaves T3/T6/T9/T10 unnamed
  // The guide carries both "Turn 1" and "Crowthorne" — Crowthorne IS T1, and
  // the two entries describe it differently ("heavy-braking" vs "fast,
  // sweeping"). Anchoring merges a contradiction; dedupe the guide first.
  kyalami: ["The Kink", "Crowthorne"],
  snetterton: ["Wilson"], // no matching name in meta's curated list
  "lime-rock": ["Righthander (No Name Straight approach)"], // meta names 6 corners
  "paul-ricard": ["Mistral Straight Chicane"], // ACC's layout omits the chicane

  // Guide cites a turn outside the layout meta curates (IMS road course is 14
  // turns). Which layout the guide describes needs sourcing, not a guess.
  indianapolis: ["Turn 16"],

  // No meta file, or an empty stub — nothing to anchor against.
  sochi: ["Turn 2", "Turn 3", "Turn 4", "Turn 12-13"],
  portimao: ["Primeira", "Turn 4", "Torre Vip", "Turn 15"],
  hanoi: ["Turn 1", "Turn 6-9", "Turn 11"],
};

const FANTASY_SLUGS = new Set([
  "maple-valley",
  "fujimi-kaido",
  "sunset-peninsula",
  "grand-oak",
  "hakone",
  "eaglerock",
]);

/** Guide entries with no `numbers`, i.e. still rendering under their own name. */
function unanchoredEntries(): Record<string, string[]> {
  const src = readFileSync(resolve(import.meta.dir, "../server/ai/track-guides.ts"), "utf8");
  const out: Record<string, string[]> = {};
  let slug = "";
  for (const line of src.split("\n")) {
    const id = line.match(/^\s*id: "([a-z0-9-]+)"/);
    if (id) {
      slug = id[1];
      continue;
    }
    const c = line.match(/^\s*\{ name: "([^"]+)", type: /);
    if (c && slug && !FANTASY_SLUGS.has(slug)) (out[slug] ??= []).push(c[1]);
  }
  return out;
}

describe("unanchored guide entries are a known, justified set", () => {
  test("register matches reality exactly (fails both ways)", () => {
    const actual = unanchoredEntries();
    // Compare as sorted "slug :: name" lines so a diff points at the entry.
    const flat = (r: Record<string, string[]>) =>
      Object.entries(r)
        .flatMap(([s, names]) => names.map((n) => `${s} :: ${n}`))
        .sort();
    expect(flat(actual)).toEqual(flat(KNOWN_ANCHOR_GAPS));
  });
});

describe("track guide turn-number anchors", () => {
  const anchors = guideAnchors();

  test("the guides carry anchors at all", () => {
    expect(anchors.length).toBeGreaterThan(200);
  });

  test("every anchored turn exists in that track's meta", () => {
    const offenders: string[] = [];
    for (const a of anchors) {
      const meta = loadMeta(a.slug);
      if (!meta) {
        offenders.push(`${a.slug} :: ${a.name} — anchored but no meta file`);
        continue;
      }
      const turns = knownTurns(meta);
      const missing = a.numbers.filter((n) => !turns.has(n));
      if (missing.length) {
        offenders.push(`${a.slug} :: ${a.name} — meta has no turn ${missing.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("anchors are non-empty and ascending", () => {
    const bad = anchors.filter(
      (a) => a.numbers.length === 0 || a.numbers.some((n, i) => i > 0 && n <= a.numbers[i - 1]),
    );
    expect(bad.map((b) => `${b.slug} :: ${b.name}`)).toEqual([]);
  });
});

/**
 * Guide entries that legitimately share one meta segment, because meta treats
 * as one section what the guide coaches as two (Eau Rouge and Raidillon are one
 * "Eau Rouge/Raidillon" segment). These merge into a single bullet.
 *
 * Registering them matters: an *unexpected* collision means a guide entry is
 * mislabeled. That's how the Watkins Glen "Inner Loop" entry — which actually
 * described the final corner at T11, not the T5 chicane — was caught.
 */
const KNOWN_MERGES: Record<string, string[][]> = {
  spa: [["Eau Rouge", "Raidillon"]],
  silverstone: [["Maggotts", "Becketts"]],
  suzuka: [
    ["First Curve", "Second Curve"],
    ["Degner 1", "Degner 2"],
  ],
  imola: [["Rivazza 1", "Rivazza 2"]],
  zandvoort: [["Turn 8", "Turn 9"]],
  "mount-panorama": [["Skyline", "The Esses", "The Dipper"]],
  monaco: [["Rascasse", "Antony Noghes"]],
  baku: [["Castle Section", "Turn 8"]],
  "road-atlanta": [["Turn 10a", "Turn 10b"]],
};

describe("guide entries sharing a meta segment are a known set", () => {
  test("no unregistered collisions (an unexpected one means a mislabeled entry)", () => {
    const anchors = guideAnchors();
    const bySlug = new Map<string, { name: string; numbers: number[] }[]>();
    for (const a of anchors) {
      const list = bySlug.get(a.slug) ?? [];
      list.push(a);
      bySlug.set(a.slug, list);
    }

    const actual: string[] = [];
    for (const [slug, entries] of bySlug) {
      const meta = loadMeta(slug);
      if (!meta) continue;
      const games = Object.keys(meta.games ?? {});
      const segs = (games.length ? meta.games![games[0]].segments : meta.segments) ?? [];
      const labelOf = new Map<number, string>();
      for (const s of segs) {
        const nums = numsOf(s);
        if (s.type !== "corner" || nums.length === 0 || !s.name) continue;
        for (const n of nums) labelOf.set(n, `${s.name}|${nums.join(",")}`);
      }
      const grouped = new Map<string, string[]>();
      for (const e of entries) {
        const hit = labelOf.get(e.numbers[0]);
        if (!hit || !e.numbers.every((n) => labelOf.get(n) === hit)) continue;
        grouped.set(hit, [...(grouped.get(hit) ?? []), e.name]);
      }
      for (const names of grouped.values()) {
        if (names.length > 1) actual.push(`${slug} :: ${names.join(" + ")}`);
      }
    }

    const expected = Object.entries(KNOWN_MERGES)
      .flatMap(([slug, groups]) => groups.map((g) => `${slug} :: ${g.join(" + ")}`))
      .sort();
    expect(actual.sort()).toEqual(expected);
  });
});

/**
 * Independent correctness checks for the anchors.
 *
 * The "turn exists in meta" checksum above shares a failure mode with the name
 * matching that produced the anchors: a wrong-but-in-range number passes both.
 * The two checks below don't — they cross-reference sources the anchoring never
 * consulted, so they can disagree with it.
 */

/** Turn numbers a guide entry's own prose claims, e.g. type: "fast right (T12)". */
function proseTurns(type: string): number[] | null {
  const m = type.match(/\((?:T|Turn\s*)(\d+)(?:\s*[-–]\s*T?(\d+))?[,)]/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function guideEntries(): { slug: string; name: string; numbers: number[]; type: string }[] {
  const src = readFileSync(resolve(import.meta.dir, "../server/ai/track-guides.ts"), "utf8");
  const out: { slug: string; name: string; numbers: number[]; type: string }[] = [];
  let slug = "";
  for (const line of src.split("\n")) {
    const id = line.match(/^\s*id: "([a-z0-9-]+)"/);
    if (id) {
      slug = id[1];
      continue;
    }
    const c = line.match(/^\s*\{ name: "([^"]+)", numbers: \[([0-9, ]*)\], type: "([^"]+)"/);
    if (c && slug) {
      out.push({
        slug,
        name: c[1],
        numbers: c[2].split(",").map((x) => Number(x.trim())).filter(Number.isFinite),
        type: c[3],
      });
    }
  }
  return out;
}

/**
 * Entries whose own prose cites a turn that doesn't overlap its anchor.
 *
 * Every one of these points at the RIGHT meta segment ("Dunlop Curve" -> meta's
 * "Dunlop") — what disagrees is the turn number meta assigns to it. So these
 * record suspected defects in meta's numbering, not bad anchors.
 *
 * Suzuka is the clearest: the real circuit numbers the S Curves T3-T7, Dunlop
 * T8, Degner T9-T10, Hairpin T11. Meta has S Curves [3,4,5,6], Dunlop [7],
 * Degner [8,9], then re-syncs at Hairpin [11] — it drops a corner in the Esses
 * and picks the count back up later. Follow-up against the #84 curation.
 */
const KNOWN_NUMBERING_CONFLICTS = [
  "brands-hatch :: Clark Curve", // prose T9, meta T10
  "nurburgring :: Dunlop Kehre", // prose T7, meta T6
  "nurburgring :: NGK Chicane", // prose T15, meta T12-13
  "sebring :: Sunset Bend", // prose T17, meta T19
  "suzuka :: Degner 2", // prose T10, meta's Degner covers 8-9
  "suzuka :: Dunlop Curve", // prose T8, meta T7
];

describe("anchor cross-checks (independent of how anchors were derived)", () => {
  test("guide prose and its anchor overlap, except for known meta numbering conflicts", () => {
    const conflicts: string[] = [];
    for (const e of guideEntries()) {
      const prose = proseTurns(e.type);
      if (!prose) continue;
      // A merge makes prose a subset of the anchor ("Rivazza 1" prose [17],
      // anchor [17,18]) — fine. Disjoint means one of the two is wrong.
      if (!prose.some((n) => e.numbers.includes(n))) conflicts.push(`${e.slug} :: ${e.name}`);
    }
    expect(conflicts.sort()).toEqual(KNOWN_NUMBERING_CONFLICTS);
  });

  test("anchors ascend in guide order, except where the guide lists out of sequence", () => {
    // Guides list corners in lap order, so anchors should ascend. A decrease is
    // either a transposed anchor or a guide listing corners out of order — it
    // found the Watkins Glen "Inner Loop" mislabel (T8 then T5). The entries
    // below are verified as the guide listing out of order, anchors correct.
    const KNOWN_OUT_OF_ORDER = [
      "misano :: Curvone -> Quercia",
      "mugello :: Arrabbiata 1 & 2 -> Casanova-Savelli",
      "snetterton :: Coram -> Palmer",
    ];
    const bySlug = new Map<string, { name: string; numbers: number[] }[]>();
    for (const e of guideEntries()) {
      bySlug.set(e.slug, [...(bySlug.get(e.slug) ?? []), e]);
    }
    const anomalies: string[] = [];
    for (const [slug, entries] of bySlug) {
      for (let i = 1; i < entries.length; i++) {
        const prev = Math.min(...entries[i - 1].numbers);
        const cur = Math.min(...entries[i].numbers);
        // Equal is a legitimate merge (both halves of one meta segment).
        if (cur < prev) anomalies.push(`${slug} :: ${entries[i - 1].name} -> ${entries[i].name}`);
      }
    }
    expect(anomalies.sort()).toEqual(KNOWN_OUT_OF_ORDER);
  });
});

describe("guide corner naming defers to meta", () => {
  test("Monaco: guide's own names give way to meta's", () => {
    // The guide says "Swimming Pool" and "Grand Hotel Hairpin"; meta (and so
    // the track map, and the prompt's corner whitelist) say Piscine / Fairmont.
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    expect(out).toContain("Piscine (14-15)");
    expect(out).toContain("Fairmont Hairpin (6)");
    expect(out).not.toContain("Swimming Pool");
    expect(out).not.toContain("Grand Hotel Hairpin");
  });

  test("Spa: accent/article drift resolves to the meta spelling", () => {
    const out = buildTrackGuideContext("Spa", { slug: "spa", gameId: "f1-2025" });
    // Guide spells it "Fagnes"; meta spells it "Les Fagnes".
    expect(out).toContain("Les Fagnes");
  });

  test("priority corners use the same labels as the corner list", () => {
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    const priority = out.split("Priority corners (most impactful on lap time): ")[1]?.split("\n")[0] ?? "";
    expect(priority).toContain("Fairmont Hairpin (6)");
    // A priority entry naming a corner the list above labels differently would
    // hand the model two names for one corner.
    for (const label of priority.split(", ")) {
      expect(out).toContain(`• ${label} [`);
    }
  });

  test("without a slug, falls back to the guide's own names (no crash)", () => {
    const out = buildTrackGuideContext("Monaco");
    expect(out).toContain("Expert Track Guide");
    expect(out).toContain("Swimming Pool");
  });

  test("guideCornerLabels matches the labels the context block emits", () => {
    const labels = guideCornerLabels("Monaco", { slug: "monaco", gameId: "f1-2025" });
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(out).toContain(`• ${l} [`);
  });

  test("unknown track yields no guide", () => {
    expect(buildTrackGuideContext("Wibble Speedway")).toBe("");
    expect(guideCornerLabels("nonexistent-track")).toEqual([]);
  });

  test("meta merging two corners into one segment emits one bullet", () => {
    // Monaco meta has a single "Rascasse / Antony Noghès" segment; the guide
    // coaches the two separately. Printing both would read as two corners.
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    const occurrences = out.split("• Rascasse / Antony Noghès (18-19) [").length - 1;
    expect(occurrences).toBe(1);
  });

  test("every guide id resolves", () => {
    expect(getAvailableTrackGuides().length).toBeGreaterThan(50);
  });
});
