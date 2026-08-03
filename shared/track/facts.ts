/**
 * Track facts: what the circuit IS. Game-agnostic, no fractions.
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
 * Geometry lives in `shared/track/geometry.ts`; the keys that join the two in
 * `shared/track/keys.ts`; the join itself in `shared/track/curation/join.ts`.
 */

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
  // No detector allowances here — how many arcs a centerline resolves this
  // corner into, or whether a game draws it at all, is not a property of the
  // circuit. Those live in shared/tracks/detect-hints.json.
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
  /**
   * Where these corner names came from — official circuit map, FIA track guide,
   * or an explicit admission that the numbering was detected rather than sourced
   * ("Sequential detected corners"). Names in this file are real-world claims;
   * this is the citation that makes them auditable. Never invent one.
   */
  source?: string;
  corners: CornerFact[];
  /** Only gaps that carry a real name. */
  straights?: StraightFact[];
}

/** Turn numbers a corner fact occupies, sorted. */
export function cornerNumbers(c: CornerFact): number[] {
  return [c.number, ...(c.covers ?? [])].sort((a, b) => a - b);
}
