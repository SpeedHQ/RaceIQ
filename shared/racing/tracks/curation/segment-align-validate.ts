import { NO_DETECT_HINTS, type DetectHints } from "../detect-hints";
import type { TrackFacts } from "../facts";
import type { AlignmentIssue } from "./segment-align-match";

/**
 * The official turn count, derived: the highest number any corner accounts for.
 * Facts used to declare this separately, which only worked while a second file
 * carried the circuit's own claim. With names living in the facts file the
 * declaration would just be `max(numbers)` restated, so it is computed instead.
 */
export function officialTurnCount(facts: TrackFacts): number {
  let max = 0;
  for (const c of facts.corners) {
    for (const n of [c.number, ...(c.covers ?? [])]) {
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return max;
}

/**
 * Validate a track's corner facts as a turn numbering: every turn from 1 to the
 * highest number present must be accounted for exactly once (via `number` or
 * `covers`), in strictly increasing order around the lap. A hole in the run is
 * a real error — turn 3 missing between 2 and 4 means a corner was lost.
 *
 * The one legitimate hole is a number the circuit map carries but no corner
 * roster does — Baku 13/14, a Catalunya chicane half. Those are declared
 * `optional` in layout-local `detect-hints.json`; pass the layout's hints and
 * they count as accounted for.
 */
export function validateFacts(facts: TrackFacts, hints: DetectHints = NO_DETECT_HINTS): AlignmentIssue[] {
  const issues: AlignmentIssue[] = [];
  const turnCount = officialTurnCount(facts);
  if (turnCount < 1) {
    issues.push({ severity: "error", message: "no numbered corners" });
    return issues;
  }
  const seen = new Set<number>();
  let prevMax = 0;
  for (const c of facts.corners) {
    const nums = [c.number, ...(c.covers ?? [])];
    for (const n of nums) {
      if (!Number.isInteger(n) || n < 1) {
        issues.push({ severity: "error", message: `turn ${n} is not a positive integer` });
        continue;
      }
      if (seen.has(n)) issues.push({ severity: "error", message: `turn ${n} listed twice` });
      seen.add(n);
    }
    const lo = Math.min(...nums);
    if (lo <= prevMax) issues.push({ severity: "error", message: `turn ${c.number} out of racing order` });
    prevMax = Math.max(prevMax, ...nums);
  }
  for (let n = 1; n <= turnCount; n++) {
    if (seen.has(n) || hints.get(n)?.optional) continue;
    issues.push({
      severity: "error",
      message: `turn ${n} unaccounted for (add an entry, covers, or an optional detect hint)`,
    });
  }
  return issues;
}
