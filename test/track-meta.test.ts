/**
 * Track meta: facts are shared per layout, geometry is per game.
 *
 * The load-bearing assertion here is `checkKeys` across the whole roster: every
 * game that ships a layout must place exactly the corners the facts file
 * declares. Games model the same real circuit, so a difference is a detection
 * bug or a curation gap — it fails the build rather than being recorded as data
 * and quietly ignored.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  cornerKey,
  cornerNumbers,
  straightKey,
  joinSegments,
  splitSegments,
  isPlaceholderName,
  checkKeys,
  parseCornerKey,
  parseStraightKey,
  numberCorner,
  unnumberCorner,
  type TrackFacts,
  type TrackGeometry,
} from "../shared/track-meta";
import { SHARED_DIR } from "../shared/resolve-data";

const META_DIR = resolve(SHARED_DIR, "tracks", "meta");
const GAME_IDS = ["fm-2023", "acc", "ac-evo", "f1-2025"] as const;

function loadFacts(slug: string): TrackFacts {
  return JSON.parse(readFileSync(resolve(META_DIR, `${slug}.json`), "utf-8")) as TrackFacts;
}

function geometryFor(slug: string): Record<string, TrackGeometry> {
  const out: Record<string, TrackGeometry> = {};
  for (const gameId of GAME_IDS) {
    const path = resolve(SHARED_DIR, "tracks", gameId, `${slug}-segments.json`);
    if (existsSync(path)) out[gameId] = JSON.parse(readFileSync(path, "utf-8")) as TrackGeometry;
  }
  return out;
}

const SLUGS = readdirSync(META_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""))
  .sort();

/**
 * Corners a game's detector folds into a neighbour, leaving its geometry with
 * no row for them.
 *
 * These are gaps in one game's segmentation of its own centerline, not
 * disagreements about what the circuit is — so the facts file rightly declares
 * the union and the short game is simply missing geometry. Closing one means
 * re-running the corner detector for that game, not editing the facts.
 *
 * Shrink-only. A gap that gets fixed must be deleted from here (enforced
 * below), and any gap NOT listed fails the build.
 */
const KNOWN_CORNER_GAPS: Record<string, string[]> = {
  // acc and ac-evo fold Sheene (T7) into the Stirling's approach.
  "brands-hatch/acc": ["t7"],
  "brands-hatch/ac-evo": ["t7"],
  // acc misses T6; f1 and fm miss T14. Both are real Catalunya turns.
  "catalunya/acc": ["t6"],
  "catalunya/f1-2025": ["t14"],
  "catalunya/fm-2023": ["t14"],
  // Imola's full 19 turns were curated off the ac-evo centerline, but ac-evo's
  // own geometry still folds T1, T8, T10, T13 and T16 into their neighbours;
  // acc and f1-2025 fold T1, T10 and T16.
  "imola/acc": ["t1", "t10", "t16"],
  "imola/ac-evo": ["t1", "t10", "t13", "t16", "t8"],
  "imola/f1-2025": ["t1", "t10", "t16"],
  // laguna-seca T1 and sebring T6/T12/T18 are real corners on ACC/FM that
  // ac-evo's centerline doesn't register at all (not merged into a
  // neighbour — genuinely absent).
  "laguna-seca/ac-evo": ["t1"],
  "sebring/ac-evo": ["t12", "t18", "t6"],
  // fm subdivides the Nordschleife into 69 corners; acc and ac-evo stop at 60.
  "nordschleife/acc": ["t61", "t62", "t63", "t64", "t65", "t66", "t67", "t68", "t69"],
  "nordschleife/ac-evo": ["t61", "t62", "t63", "t64", "t65", "t66", "t67", "t68", "t69"],
  // acc folds Aintree (T5) into the Wellington Straight exit.
  "silverstone/acc": ["t5"],
  // ac-evo folds Blanchimont (T16) into the Bus Stop approach.
  "spa/ac-evo": ["t16"],
  // acc folds Hans Ernst Bocht (T13) into T12.
  "zandvoort/acc": ["t13"],
};

/**
 * Named straights a game's detector never resolves, so its players never see
 * the name while every other game's do.
 *
 * Both are the same shape: the layout has the turn, the game places the turn,
 * and every other game places the gap after it — this one just runs the two
 * corners together. Fixing means retuning that centerline's gap detection, not
 * editing the facts.
 *
 * Shrink-only, same contract as KNOWN_CORNER_GAPS.
 */
const KNOWN_STRAIGHT_GAPS: Record<string, string[]> = {
  // fm runs T13 into T14; acc and f1-2025 both place Hangar Straight.
  "silverstone/fm-2023": ["s13"],
  // fm runs T58 into T59; acc and ac-evo both place Döttinger Höhe.
  "nordschleife/fm-2023": ["s58"],
};

describe("join keys", () => {
  test("corner key is the turn numbers, sorted", () => {
    expect(cornerKey([3])).toBe("t3");
    expect(cornerKey([11, 10])).toBe("t10-11");
  });

  test("straight key is the turn it follows", () => {
    expect(straightKey(3)).toBe("s3");
  });

  test("keys round-trip through their parsers", () => {
    expect(parseCornerKey("t10-11")).toEqual([10, 11]);
    expect(parseStraightKey("s7")).toBe(7);
  });

  test("malformed keys parse to empty rather than throwing", () => {
    expect(parseCornerKey("s3")).toEqual([]);
    expect(parseStraightKey("t3")).toBeNull();
  });
});

describe("placeholder names", () => {
  test("generated turn and straight tokens are placeholders, not names", () => {
    for (const token of ["", "T1", "T10-11", "S2", "S"]) {
      expect(isPlaceholderName(token)).toBe(true);
    }
  });

  test("real corner names are not placeholders", () => {
    for (const name of ["Paddock Hill Bend", "Eau Rouge", "Castrol-S", "Turn Five"]) {
      expect(isPlaceholderName(name)).toBe(false);
    }
  });
});

describe("join", () => {
  const facts: TrackFacts = {
    slug: "x",
    track: "x",
    layout: "gp",
    layoutName: "Grand Prix",
    name: "X",
    corners: [
      { number: 1, name: "Big Bend", direction: "right" },
      { number: 2, covers: [3], name: "", direction: "left" },
    ],
    straights: [{ after: 1, name: "Back Straight" }],
  };
  const geometry: TrackGeometry = {
    segments: [
      { key: "t1", startFrac: 0, endFrac: 0.2 },
      { key: "s1", startFrac: 0.2, endFrac: 0.5 },
      { key: "t2-3", startFrac: 0.5, endFrac: 0.9 },
    ],
  };

  test("facts supply the labels, geometry supplies the fractions", () => {
    const joined = joinSegments(facts, geometry);
    expect(joined[0]).toMatchObject({ type: "corner", name: "Big Bend", direction: "right", number: 1, startFrac: 0 });
    expect(joined[1]).toMatchObject({ type: "straight", name: "Back Straight", startFrac: 0.2 });
  });

  test("an unnamed corner renders its turn span as a display token", () => {
    const joined = joinSegments(facts, geometry);
    expect(joined[2]).toMatchObject({ type: "corner", name: "T2-3", number: 2, covers: [3] });
  });

  test("output is ordered along the lap regardless of geometry order", () => {
    const shuffled: TrackGeometry = { segments: [...geometry.segments].reverse() };
    expect(joinSegments(facts, shuffled).map((s) => s.startFrac)).toEqual([0, 0.2, 0.5]);
  });

  test("split is the inverse of join: labels back to facts, fractions back to geometry", () => {
    const { corners, straights, geometry: geom } = splitSegments(joinSegments(facts, geometry));
    expect(geom).toEqual(geometry.segments);
    expect(corners).toEqual(facts.corners);
    expect(straights).toEqual(facts.straights!);
  });

  test("split does not promote a synthesized token into a stored name", () => {
    const { corners } = splitSegments([
      { type: "corner", name: "T4", number: 4, startFrac: 0, endFrac: 0.1 },
    ]);
    expect(corners[0].name).toBe("");
  });
});

describe("checkKeys", () => {
  const facts: TrackFacts = {
    slug: "x",
    track: "x",
    layout: "gp",
    layoutName: "Grand Prix",
    name: "X",
    corners: [
      { number: 1, name: "One" },
      { number: 2, name: "Two" },
    ],
  };

  test("a game placing every declared corner is clean", () => {
    const clean = checkKeys(facts, {
      acc: { segments: [{ key: "t1", startFrac: 0, endFrac: 0.1 }, { key: "t2", startFrac: 0.5, endFrac: 0.6 }] },
    });
    expect(clean).toEqual([]);
  });

  test("a named straight the game never places is reported", () => {
    const withNamed: TrackFacts = { ...facts, straights: [{ after: 1, name: "Back Straight" }] };
    const [mismatch] = checkKeys(withNamed, {
      acc: { segments: [{ key: "t1", startFrac: 0, endFrac: 0.1 }, { key: "t2", startFrac: 0.5, endFrac: 0.6 }] },
    });
    expect(mismatch).toMatchObject({ gameId: "acc", unplacedStraights: ["s1"] });
  });

  test("an unnamed gap the game never places is not reported", () => {
    // Only named straights are constrained — an unresolved anonymous gap costs
    // nobody a label, so it is not a finding.
    const withUnnamed: TrackFacts = { ...facts, straights: [{ after: 1, name: "" }] };
    const clean = checkKeys(withUnnamed, {
      acc: { segments: [{ key: "t1", startFrac: 0, endFrac: 0.1 }, { key: "t2", startFrac: 0.5, endFrac: 0.6 }] },
    });
    expect(clean).toEqual([]);
  });

  test("splitting one named straight across several rows is clean", () => {
    const withNamed: TrackFacts = { ...facts, straights: [{ after: 1, name: "Back Straight" }] };
    const clean = checkKeys(withNamed, {
      acc: {
        segments: [
          { key: "t1", startFrac: 0, endFrac: 0.1 },
          { key: "s1", startFrac: 0.1, endFrac: 0.2 },
          { key: "s1", startFrac: 0.2, endFrac: 0.3 },
          { key: "t2", startFrac: 0.5, endFrac: 0.6 },
        ],
      },
    });
    expect(clean).toEqual([]);
  });

  test("a game missing a declared corner is reported", () => {
    const [mismatch] = checkKeys(facts, { acc: { segments: [{ key: "t1", startFrac: 0, endFrac: 0.1 }] } });
    expect(mismatch).toMatchObject({ gameId: "acc", missing: ["t2"] });
  });

  test("a corner no facts file declares is reported as unknown", () => {
    const [mismatch] = checkKeys(facts, {
      acc: {
        segments: [
          { key: "t1", startFrac: 0, endFrac: 0.1 },
          { key: "t2", startFrac: 0.3, endFrac: 0.4 },
          { key: "t9", startFrac: 0.5, endFrac: 0.6 },
        ],
      },
    });
    expect(mismatch.unknown).toEqual(["t9"]);
  });

  test("a straight following a turn that does not exist is reported", () => {
    const [mismatch] = checkKeys(facts, {
      acc: {
        segments: [
          { key: "t1", startFrac: 0, endFrac: 0.1 },
          { key: "t2", startFrac: 0.3, endFrac: 0.4 },
          { key: "s8", startFrac: 0.5, endFrac: 0.6 },
        ],
      },
    });
    expect(mismatch.unknown).toEqual(["s8"]);
  });

  test("several geometry rows may share one straight key", () => {
    // A detector that splits one gap in two is not a disagreement about the
    // circuit, so the straight count is deliberately not constrained.
    const clean = checkKeys(facts, {
      acc: {
        segments: [
          { key: "t1", startFrac: 0, endFrac: 0.1 },
          { key: "s1", startFrac: 0.1, endFrac: 0.2 },
          { key: "s1", startFrac: 0.2, endFrac: 0.3 },
          { key: "t2", startFrac: 0.3, endFrac: 0.4 },
        ],
      },
    });
    expect(clean).toEqual([]);
  });
});

describe("committed roster", () => {
  test("every layout has a facts file that parses", () => {
    expect(SLUGS.length).toBeGreaterThan(90);
    for (const slug of SLUGS) expect(() => loadFacts(slug)).not.toThrow();
  });

  test("facts carry layout identity and never carry fractions", () => {
    for (const slug of SLUGS) {
      const facts = loadFacts(slug);
      expect(facts.slug, slug).toBe(slug);
      expect(facts.track, slug).toBeTruthy();
      expect(facts.layout, slug).toBeTruthy();
      expect(facts.layoutName, slug).toBeTruthy();
      for (const corner of facts.corners) {
        const stray = Object.keys(corner).filter((k) => k === "startFrac" || k === "endFrac");
        expect(stray, `${slug} T${corner.number}`).toEqual([]);
      }
    }
  });

  test("geometry files never carry a name, group or direction", () => {
    for (const slug of SLUGS) {
      for (const [gameId, geom] of Object.entries(geometryFor(slug))) {
        for (const seg of geom.segments) {
          const leaked = Object.keys(seg).filter((k) => !["key", "startFrac", "endFrac"].includes(k));
          expect(leaked, `${slug}/${gameId}`).toEqual([]);
        }
      }
    }
  });

  test("a corner's turn numbers are unique within its layout", () => {
    for (const slug of SLUGS) {
      const facts = loadFacts(slug);
      const seen = new Set<number>();
      for (const corner of facts.corners) {
        for (const n of cornerNumbers(corner)) {
          expect(seen.has(n), `${slug} turn ${n} claimed twice`).toBe(false);
          seen.add(n);
        }
      }
    }
  });

  test("a corner's `number` is the lowest of the span it covers", () => {
    for (const slug of SLUGS) {
      for (const corner of loadFacts(slug).corners) {
        expect(corner.number, `${slug} T${corner.number}`).toBe(cornerNumbers(corner)[0]);
      }
    }
  });

  test("a named straight follows a turn the layout actually has", () => {
    for (const slug of SLUGS) {
      const facts = loadFacts(slug);
      const turns = new Set(facts.corners.flatMap(cornerNumbers));
      for (const s of facts.straights ?? []) {
        expect(turns.has(s.after), `${slug} straight after T${s.after}`).toBe(true);
      }
    }
  });

  test("no game silently drops a corner its layout declares", () => {
    const gaps: Record<string, string[]> = {};
    for (const slug of SLUGS) {
      const geometry = geometryFor(slug);
      if (Object.keys(geometry).length === 0) continue;
      for (const m of checkKeys(loadFacts(slug), geometry)) {
        // An unknown key is always a hard failure: the geometry references a
        // turn the circuit does not have, so one of the two files is wrong.
        expect(m.unknown, `${slug}/${m.gameId} references turns the layout lacks`).toEqual([]);
        if (m.missing.length) gaps[`${slug}/${m.gameId}`] = m.missing;
      }
    }

    const unexpected = Object.entries(gaps)
      .filter(([k, missing]) => (KNOWN_CORNER_GAPS[k] ?? []).join() !== missing.join())
      .map(([k, missing]) => `${k}: missing ${missing.join(",")}`);
    expect(unexpected, "new corner gap — fix the detector or record it in KNOWN_CORNER_GAPS").toEqual([]);
  });

  test("KNOWN_CORNER_GAPS has no stale entries", () => {
    // Keeps the list shrink-only: closing a gap must delete its entry, so the
    // allowlist can never quietly outlive the problem it documents.
    const live = new Set<string>();
    for (const slug of SLUGS) {
      const geometry = geometryFor(slug);
      if (Object.keys(geometry).length === 0) continue;
      for (const m of checkKeys(loadFacts(slug), geometry)) {
        if (m.missing.length) live.add(`${slug}/${m.gameId}`);
      }
    }
    const stale = Object.keys(KNOWN_CORNER_GAPS).filter((k) => !live.has(k));
    expect(stale, "gap is fixed — delete it from KNOWN_CORNER_GAPS").toEqual([]);
  });

  test("no game silently drops a named straight", () => {
    // Straight *count* is free — detectors legitimately split one gap into two
    // rows, and row counts differ on 16 of 23 multi-game layouts. But a straight
    // the facts bothered to name must actually be placed, or that game's players
    // never see the name while every other game's do.
    const gaps: Record<string, string[]> = {};
    for (const slug of SLUGS) {
      const geometry = geometryFor(slug);
      if (Object.keys(geometry).length === 0) continue;
      for (const m of checkKeys(loadFacts(slug), geometry)) {
        if (m.unplacedStraights.length) gaps[`${slug}/${m.gameId}`] = m.unplacedStraights;
      }
    }

    const unexpected = Object.entries(gaps)
      .filter(([k, unplaced]) => (KNOWN_STRAIGHT_GAPS[k] ?? []).join() !== unplaced.join())
      .map(([k, unplaced]) => `${k}: never places ${unplaced.join(",")}`);
    expect(unexpected, "new unplaced named straight — fix the detector or record it in KNOWN_STRAIGHT_GAPS").toEqual([]);
  });

  test("KNOWN_STRAIGHT_GAPS has no stale entries", () => {
    const live = new Set<string>();
    for (const slug of SLUGS) {
      const geometry = geometryFor(slug);
      if (Object.keys(geometry).length === 0) continue;
      for (const m of checkKeys(loadFacts(slug), geometry)) {
        if (m.unplacedStraights.length) live.add(`${slug}/${m.gameId}`);
      }
    }
    const stale = Object.keys(KNOWN_STRAIGHT_GAPS).filter((k) => !live.has(k));
    expect(stale, "straight is now placed — delete it from KNOWN_STRAIGHT_GAPS").toEqual([]);
  });

  test("every layout of a venue agrees on the venue name", () => {
    const nameByTrack: Record<string, { slug: string; name: string }> = {};
    for (const slug of SLUGS) {
      const facts = loadFacts(slug);
      const seen = nameByTrack[facts.track];
      if (!seen) {
        nameByTrack[facts.track] = { slug, name: facts.name };
        continue;
      }
      expect(facts.name, `${slug} vs ${seen.slug} under venue ${facts.track}`).toBe(seen.name);
    }
  });

  test("a venue never has two layouts with the same layout id", () => {
    const seen = new Set<string>();
    for (const slug of SLUGS) {
      const facts = loadFacts(slug);
      const pair = `${facts.track}/${facts.layout}`;
      expect(seen.has(pair), `duplicate layout ${pair} at ${slug}`).toBe(false);
      seen.add(pair);
    }
  });
});

describe("numberCorner", () => {
  const seg = (type: "corner" | "straight", number?: number, covers?: number[]) => ({
    type,
    ...(number != null ? { number } : {}),
    ...(covers ? { covers } : {}),
  });

  test("a straight promoted to a corner takes the number after the corner before it", () => {
    // The bug this exists for: the editor flipped `type` and left `number`
    // undefined, so splitSegments keyed the entry as a straight again.
    const out = numberCorner([seg("corner", 1), seg("corner"), seg("corner", 5)], 1);
    expect(out[1].number).toBe(2);
  });

  test("numbers the first corner T1 when nothing precedes it", () => {
    expect(numberCorner([seg("straight"), seg("corner")], 1)[1].number).toBe(1);
  });

  test("leaves a deliberate gap in the following corners alone", () => {
    // T4 is a turn this game's detector skips; inserting T2 must not renumber
    // the corners that already sit clear of it.
    const out = numberCorner([seg("corner", 1), seg("corner"), seg("corner", 5), seg("corner", 8)], 1);
    expect(out.map((s) => s.number)).toEqual([1, 2, 5, 8]);
  });

  test("pushes a colliding follower up, carrying its covered numbers", () => {
    const out = numberCorner([seg("corner", 1), seg("corner"), seg("corner", 2, [3])], 1);
    expect(out.map((s) => [s.number, s.covers])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, [4]],
    ]);
  });

  test("demoting a corner drops its numbering and keeps the rest", () => {
    const out = unnumberCorner([seg("corner", 1), seg("corner", 2, [3]), seg("corner", 4)], 1);
    expect(out[1].number).toBeUndefined();
    expect(out[1].covers).toBeUndefined();
    expect(out.map((s) => s.number)).toEqual([1, undefined, 4]);
  });

  test("a numbered corner survives the split that used to demote it", () => {
    const numbered = numberCorner([{ type: "corner", name: "", startFrac: 0, endFrac: 0.2 }], 0);
    const { corners, geometry } = splitSegments(numbered as never);
    expect(corners).toHaveLength(1);
    expect(geometry[0].key).toBe("t1");
  });
});
