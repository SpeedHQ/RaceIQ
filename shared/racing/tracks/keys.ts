/**
 * The keys that join facts to geometry.
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
 *
 * Pure string <-> number. No imports, by design: the format is the contract
 * between `track-facts.ts` and `track-geometry.ts`, so it must not depend on
 * either.
 */

/** Corner key from turn numbers: [3] -> "t3", [10,11] -> "t10-11". */
export function cornerKey(numbers: number[]): string {
  return `t${[...numbers].sort((a, b) => a - b).join("-")}`;
}


/** Straight key from the turn it follows: 3 -> "s3". */
export function straightKey(afterCorner: number): string {
  return `s${afterCorner}`;
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
