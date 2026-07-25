/**
 * Branch-relative version labels for the Setup Engineer commit graph.
 *
 * Rule: EVERY child of a node nests by appending a `.k` segment (v1→v1.1,
 * v1.2, … in creation order). Fan-outs of sibling variants therefore read as
 * equals — no child ever claims the parent's "continuation" name (the old
 * v1→v2 rule made the first of five equal variants look like the mainline
 * successor). Labels are display-only; row id + integer version are the real
 * identity, so a rare collision is resolved cosmetically by nextFreeLabel.
 */

/** Split "v1.2" → { prefix: "v1.", last: 2 } | null when there's no trailing number. */
function splitLast(label: string): { prefix: string; last: number } | null {
  const m = label.match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1]!, last: Number(m[2]!) };
}

export function computeChildLabel(parentLabel: string, existingChildCount: number): string {
  // Parent has no trailing number (e.g. seeded "base"): its children start
  // the top-level line at v1, v2, …
  if (!splitLast(parentLabel)) return `v${existingChildCount + 1}`;
  // Nest: the k-th child of vX is vX.k (1-based, creation order).
  return `${parentLabel}.${existingChildCount + 1}`;
}

/**
 * Short human-readable slug describing the applied changes, for file/label
 * names — e.g. "soft-rarb", "more-rwing-lo-fride". Uses up to two changes;
 * three or more collapse the tail into "mix" so names stay short.
 */
export function changeSlug(changes: { component: string; direction: "increase" | "decrease" }[]): string {
  if (changes.length === 0) return "";
  const parts = changes.slice(0, 2).map((c) => `${directionWord(c.component, c.direction)}-${componentToken(c.component)}`);
  if (changes.length > 2) parts.push("mix");
  return parts.join("-");
}

/** Stiffness-flavoured knobs read better as soft/stiff; heights as lo/hi; the rest as more/less. */
function directionWord(component: string, direction: "increase" | "decrease"): string {
  const c = component.toLowerCase();
  if (/anti-?roll|spring|damper|bump|rebound|arb/.test(c)) return direction === "increase" ? "stiff" : "soft";
  if (/height/.test(c)) return direction === "increase" ? "hi" : "lo";
  return direction === "increase" ? "more" : "less";
}

/** Compress a component name to a short token: "Front Anti-Roll Bar" → "farb". */
function componentToken(component: string): string {
  const c = component.toLowerCase();
  const axle = /front/.test(c) ? "f" : /rear/.test(c) ? "r" : "";
  if (/anti-?roll/.test(c)) return `${axle}arb`;
  if (/wing|splitter/.test(c)) return `${axle}wing`;
  if (/tyre pressure|pressure/.test(c)) {
    const corner = c.match(/\b([fr][lr])\b/)?.[1] ?? axle;
    return `${corner}press`;
  }
  if (/ride height/.test(c)) return `${axle}ride`;
  if (/brake bias/.test(c)) return "bias";
  if (/preload|diff/.test(c)) return "diff";
  if (/spring/.test(c)) return `${axle}spring`;
  if (/bump/.test(c)) return `${axle}bump`;
  if (/rebound/.test(c)) return `${axle}reb`;
  if (/camber/.test(c)) return `${axle}camber`;
  if (/toe/.test(c)) return `${axle}toe`;
  // Fallback: first 4 letters of each word, joined.
  return c.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.slice(0, 4)).join("").slice(0, 12) || "chg";
}

export function nextFreeLabel(candidate: string, taken: Set<string>): string {
  let out = candidate;
  while (taken.has(out)) {
    const s = splitLast(out);
    out = s ? `${s.prefix}${s.last + 1}` : `${out}.1`;
  }
  return out;
}
