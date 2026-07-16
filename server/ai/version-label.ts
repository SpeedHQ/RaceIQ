/**
 * Branch-relative version labels for the Setup Engineer commit graph.
 *
 * Rules (design §B): the FIRST child of a node continues that node's line by
 * incrementing its last numeric segment (v1→v2, v1.1→v1.2 — mainline stays
 * flat). A FORK (second+ child) nests by appending a new `.k` segment
 * (v1→v1.1, v1.2). Labels are display-only; row id + integer version are the
 * real identity, so a rare collision is resolved cosmetically by nextFreeLabel.
 */

/** Split "v1.2" → { prefix: "v1.", last: 2 } | null when there's no trailing number. */
function splitLast(label: string): { prefix: string; last: number } | null {
  const m = label.match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1]!, last: Number(m[2]!) };
}

export function computeChildLabel(parentLabel: string, existingChildCount: number): string {
  if (existingChildCount === 0) {
    // Continue the parent's line: increment its last numeric segment.
    const s = splitLast(parentLabel);
    if (s) return `${s.prefix}${s.last + 1}`;
    // Parent has no trailing number (e.g. seeded "base"): start the line at v1.
    return "v1";
  }
  // Fork: append a nested segment. existingChildCount already counts the
  // continuation child, so the k-th fork is `.${existingChildCount}` growing
  // 1,2,3 as more forks are added.
  return `${parentLabel}.${existingChildCount}`;
}

export function nextFreeLabel(candidate: string, taken: Set<string>): string {
  let out = candidate;
  while (taken.has(out)) {
    const s = splitLast(out);
    out = s ? `${s.prefix}${s.last + 1}` : `${out}.1`;
  }
  return out;
}
