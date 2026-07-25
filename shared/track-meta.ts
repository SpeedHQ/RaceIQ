/**
 * Track meta model: physical facts once, per-game geometry separately.
 *
 * Two files describe a track layout.
 *
 *   shared/tracks/meta/<slug>.json         facts  — what the circuit IS
 *   shared/tracks/<gameId>/<slug>-segments.json   geometry — where it is, per game
 *
 * The facts file carries turn numbers, turn names, named straights, groups and
 * layout identity. It is game-agnostic and holds no fractions. Every game that
 * ships this layout is modelling the same real-world circuit, so the set of
 * turns is identical across games — only where each turn sits along the lap
 * differs, because each game digitises its own centerline.
 *
 * That is the whole invariant: classification is a property of the track,
 * geometry is a property of the (track, game) pair. A name never appears in a
 * geometry file, and a fraction never appears in a facts file.
 *
 * ── Keys ────────────────────────────────────────────────────────────────
 *
 * Corners key on turn number: `t3`, or `t10-11` for one corner that officially
 * spans several numbers (Pouhon). Turn numbering is the one identifier every
 * game agrees on — verified across the roster: 1793 corners, all numbered,
 * and 16 of 22 multi-game layouts already agree exactly.
 *
 * Straights key on the corner they follow: the gap after turn 3 is `s3`. On a
 * closed lap with n corners there are exactly n gaps, so straights are derived
 * from the corner list rather than enumerated as independent facts. Only the
 * gaps with real names (Kemmel, Hangar Straight — 31 across the whole roster)
 * get a facts entry; the rest are unnamed connective tissue.
 *
 * Keying straights this way is deliberate. The earlier scheme keyed them by
 * sector + ordinal, which made identity depend on sector boundaries and on the
 * straight count matching between games. Neither holds: detectors disagree on
 * whether a gap is one straight or two (98 such splits in the roster), and that
 * shifts every ordinal behind the split. "The gap after turn 3" is stable under
 * both. It also lets several geometry rows share one key — a game that splits
 * Cooper Straight in two emits two `s3` rows, both correctly named Cooper
 * Straight, with no uniqueness constraint to violate.
 */
import type { TrackSectors } from "./track-sectors";
import type { NamedSegment as LegacyNamedSegment } from "./track-named-segments";

// ── Facts: shared/tracks/meta/<slug>.json ────────────────────────────────

/** One officially numbered corner. `number` plus `covers` is its identity. */
export interface CornerFact {
  /** Official turn number. Lowest number when the corner spans several. */
  number: number;
  /** Further official numbers this one corner subsumes (Pouhon: 10, covers [11]). */
  covers?: number[];
  /** Canonical name, untranslated. Empty when the circuit doesn't name this turn. */
  name: string;
  direction?: "left" | "right";
  /**
   * Complex this corner belongs to (Rivazza, Senna S, Bus Stop). Members share
   * the key so consumers can label the piece once instead of once per apex.
   */
  group?: string;
}

/** A named gap between corners. Unnamed gaps get no entry — they're derived. */
export interface StraightFact {
  /** Turn number this straight follows. The pre-T1 straight follows the last corner. */
  after: number;
  name: string;
  group?: string;
}

/** The facts file. No fractions, no per-game anything. */
export interface TrackFacts {
  slug: string;
  /** Physical venue, groups layouts: brands-hatch-indy and brands-hatch-gp share "brands-hatch". */
  track: string;
  /** Layout id within the venue: "gp", "indy", "national". */
  layout: string;
  /** Display layout name, rendered as "<name> — <layoutName>". */
  layoutName: string;
  /** Venue name, identical across layouts of the same venue. */
  name: string;
  corners: CornerFact[];
  /** Only gaps that carry a real name. */
  straights?: StraightFact[];
}

// ── Geometry: shared/tracks/<gameId>/<slug>-segments.json ────────────────

/** Where one segment sits along this game's lap. Classification-free. */
export interface GeometrySegment {
  /** `t3` / `t10-11` for corners, `s3` for the gap after turn 3. */
  key: string;
  startFrac: number;
  endFrac: number;
}

export interface TrackGeometry {
  sectors?: TrackSectors & { source?: string };
  segments: GeometrySegment[];
}

// ── Keys ─────────────────────────────────────────────────────────────────

/** Corner key from turn numbers: [3] -> "t3", [10,11] -> "t10-11". */
export function cornerKey(numbers: number[]): string {
  return `t${[...numbers].sort((a, b) => a - b).join("-")}`;
}

/** Straight key from the turn it follows: 3 -> "s3". */
export function straightKey(afterCorner: number): string {
  return `s${afterCorner}`;
}

/** Turn numbers a corner fact occupies, sorted. */
export function cornerNumbers(c: CornerFact): number[] {
  return [c.number, ...(c.covers ?? [])].sort((a, b) => a - b);
}


// ── Join ─────────────────────────────────────────────────────────────────

/**
 * Facts + one game's geometry -> the labelled segment list consumers expect.
 *
 * Geometry drives which segments exist and where; facts supply every label.
 * A geometry row whose key has no fact resolves to an unnamed segment rather
 * than throwing — the key-agreement test is what fails on drift, so a stale
 * geometry file degrades to unnamed instead of breaking the page.
 */
export function joinSegments(facts: TrackFacts, geometry: TrackGeometry): LegacyNamedSegment[] {
  const cornerByKey = new Map(facts.corners.map((c) => [cornerKey(cornerNumbers(c)), c]));
  const straightByAfter = new Map((facts.straights ?? []).map((s) => [s.after, s]));

  return [...geometry.segments]
    .sort((a, b) => a.startFrac - b.startFrac)
    .map((g): LegacyNamedSegment => {
      if (g.key.startsWith("t")) {
        const c = cornerByKey.get(g.key);
        const nums = c ? cornerNumbers(c) : parseCornerKey(g.key);
        return {
          type: "corner",
          // Facts leave unnamed turns empty; `T3` / `T3-4` is the display
          // convention for a turn the circuit doesn't name, synthesized here
          // so a name never has to be stored just to be shown.
          name: c?.name || (nums.length ? `T${nums.join("-")}` : ""),
          ...(c?.direction ? { direction: c.direction } : {}),
          startFrac: g.startFrac,
          endFrac: g.endFrac,
          ...(nums.length ? { number: nums[0] } : {}),
          ...(nums.length > 1 ? { covers: nums.slice(1) } : {}),
          ...(c?.group ? { group: c.group } : {}),
        };
      }
      const after = parseStraightKey(g.key);
      const s = after == null ? undefined : straightByAfter.get(after);
      return {
        type: "straight",
        name: s?.name ?? "",
        startFrac: g.startFrac,
        endFrac: g.endFrac,
        ...(s?.group ? { group: s.group } : {}),
      };
    });
}

/** "t10-11" -> [10, 11]. Returns [] for a malformed key. */
export function parseCornerKey(key: string): number[] {
  if (!key.startsWith("t")) return [];
  const nums = key
    .slice(1)
    .split("-")
    .map((p) => Number.parseInt(p, 10));
  return nums.every((n) => Number.isFinite(n)) ? nums : [];
}

/** "s3" -> 3. Returns null for a malformed key. */
export function parseStraightKey(key: string): number | null {
  if (!key.startsWith("s")) return null;
  const n = Number.parseInt(key.slice(1), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * `T1`, `T10-11`, `S3` are display tokens generated for turns and gaps the
 * circuit doesn't name. They are never stored as facts — `joinSegments`
 * synthesizes them on the way out, and this recognises them on the way back in
 * so a round-trip through the editor doesn't promote one into a real name.
 */
export function isPlaceholderName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  return /^T\d*\??$/i.test(n) || /^T\d+(?:[-/]\d+)*$/i.test(n) || /^S\d*\??$/i.test(n);
}

/** What one game's labelled segment list decomposes into. */
export interface SplitSegments {
  corners: CornerFact[];
  straights: StraightFact[];
  geometry: GeometrySegment[];
}

/**
 * Inverse of `joinSegments`: split an edited labelled list back into shared
 * facts and this game's geometry.
 *
 * The editor hands back the joined shape, so without this the save path would
 * write names straight into a per-game file and rebuild the duplication the
 * split exists to remove. Straights take the number of the corner they follow,
 * wrapping at start/finish, which is the same key rule the join reads.
 */
export function splitSegments(segments: LegacyNamedSegment[]): SplitSegments {
  const ordered = [...segments].sort((a, b) => a.startFrac - b.startFrac);
  const n = ordered.length;

  // Nearest numbered corner at or before each entry, wrapping the lap once so
  // the segments before the first corner attach to the last one.
  const precedingTurn = new Array<number | null>(n).fill(null);
  let last: number | null = null;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const s = ordered[i];
      if (s.type === "corner" && s.number != null) last = s.number;
      else if (pass === 1) precedingTurn[i] = last;
    }
  }

  const corners: CornerFact[] = [];
  const straights: StraightFact[] = [];
  const geometry: GeometrySegment[] = [];

  ordered.forEach((s, i) => {
    const name = (s.name ?? "").trim();
    if (s.type === "corner" && s.number != null) {
      const nums = [s.number, ...(s.covers ?? [])].sort((a, b) => a - b);
      geometry.push({ key: cornerKey(nums), startFrac: s.startFrac, endFrac: s.endFrac });
      corners.push({
        number: nums[0],
        ...(nums.length > 1 ? { covers: nums.slice(1) } : {}),
        name: isPlaceholderName(name) ? "" : name,
        ...(s.direction ? { direction: s.direction } : {}),
        ...(s.group ? { group: s.group } : {}),
      });
      return;
    }
    const after = precedingTurn[i];
    if (after == null) return; // no numbered corner anywhere — nothing to key against
    geometry.push({ key: straightKey(after), startFrac: s.startFrac, endFrac: s.endFrac });
    if (!isPlaceholderName(name) || s.group) {
      straights.push({ after, name: isPlaceholderName(name) ? "" : name, ...(s.group ? { group: s.group } : {}) });
    }
  });

  return { corners, straights, geometry };
}

/** Minimum shape the editor's numbering helpers touch. */
export interface NumberedEntry {
  type: string;
  number?: number;
  covers?: number[];
}

const entryNumbers = (e: NumberedEntry): number[] => (e.number == null ? [] : [e.number, ...(e.covers ?? [])].sort((a, b) => a - b));

/**
 * Give the corner at `idx` an official turn number, because a corner without
 * one is not a corner: `splitSegments` keys on the number, so an unnumbered
 * entry silently saves as a straight.
 *
 * The number is positional — it must sit above every corner before it and
 * below every corner after it. Takes the first free number above the preceding
 * corner and pushes the corners after it up only far enough to stay ordered,
 * so a curated lap with a deliberate gap (a turn this game's detector misses)
 * keeps its existing numbers untouched.
 */
export function numberCorner<T extends NumberedEntry>(segments: T[], idx: number): T[] {
  const out = segments.map((s) => ({ ...s }));
  let floor = 0;
  for (let i = 0; i < idx; i++) {
    const nums = entryNumbers(out[i]);
    if (nums.length > 0) floor = Math.max(floor, ...nums);
  }
  out[idx].number = floor + 1;
  delete out[idx].covers;
  floor += 1;

  for (let i = idx + 1; i < out.length; i++) {
    const entry = out[i];
    if (entry.type !== "corner") continue;
    const nums = entryNumbers(entry);
    if (nums.length === 0) continue;
    const shift = Math.max(0, floor + 1 - nums[0]);
    if (shift > 0) {
      entry.number = nums[0] + shift;
      if (entry.covers) entry.covers = entry.covers.map((n) => n + shift);
    }
    floor = Math.max(...entryNumbers(entry));
  }
  return out;
}

/** Drop a corner's numbering. The gap it leaves is legitimate — another game
 *  may still place that turn — so the corners after it keep their numbers. */
export function unnumberCorner<T extends NumberedEntry>(segments: T[], idx: number): T[] {
  const out = segments.map((s) => ({ ...s }));
  delete out[idx].number;
  delete out[idx].covers;
  return out;
}

// ── Invariant check (the test gate) ──────────────────────────────────────

export interface KeyMismatch {
  gameId: string;
  /** Keys the geometry has that the facts file doesn't define. */
  unknown: string[];
  /** Corner keys the facts file defines that this game's geometry never places. */
  missing: string[];
  /** Named straights the facts file declares that this game never places. */
  unplacedStraights: string[];
}

/**
 * The ongoing invariant: every game's geometry places exactly the corners the
 * facts file declares, and every straight the facts file bothers to name. Same
 * circuit, same turns — a difference is a detection bug or a curation gap,
 * never something to paper over, so it is asserted as a test failure rather
 * than recorded as data.
 *
 * How many rows a game uses for its straights is deliberately NOT constrained.
 * Detectors disagree on whether a gap is one straight or two, and a short gap
 * may not be resolved at all; neither is a claim about the circuit. Measured
 * across the roster, straight row counts differ between games on 16 of 23
 * multi-game layouts, so requiring them to match would encode a falsehood.
 *
 * A *named* straight is different. If the facts name it and a game never places
 * it, that game's players never see the name while everyone else does, so it is
 * reported.
 */
export function checkKeys(facts: TrackFacts, geometryByGame: Record<string, TrackGeometry>): KeyMismatch[] {
  const factKeys = new Set(facts.corners.map((c) => cornerKey(cornerNumbers(c))));
  const validTurns = new Set(facts.corners.flatMap(cornerNumbers));
  const namedStraights = (facts.straights ?? []).filter((s) => s.name).map((s) => straightKey(s.after));
  const out: KeyMismatch[] = [];

  for (const [gameId, geom] of Object.entries(geometryByGame)) {
    const placed = new Set<string>();
    const placedStraights = new Set<string>();
    const unknown: string[] = [];

    for (const g of geom.segments) {
      if (g.key.startsWith("t")) {
        if (factKeys.has(g.key)) placed.add(g.key);
        else unknown.push(g.key);
      } else {
        const after = parseStraightKey(g.key);
        if (after == null || !validTurns.has(after)) unknown.push(g.key);
        else placedStraights.add(g.key);
      }
    }

    const missing = [...factKeys].filter((k) => !placed.has(k));
    const unplacedStraights = namedStraights.filter((k) => !placedStraights.has(k));
    if (unknown.length || missing.length || unplacedStraights.length) {
      out.push({
        gameId,
        unknown: [...new Set(unknown)].sort(),
        missing: missing.sort(),
        unplacedStraights: unplacedStraights.sort(),
      });
    }
  }
  return out;
}
