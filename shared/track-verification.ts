/**
 * Human sign-off, shared by both halves of the track model.
 *
 * Kept in its own module because it is the one field neither the facts file nor
 * the geometry file may derive: `shared/track-facts.ts` and
 * `shared/track-geometry.ts` both import it, neither owns it.
 */

/**
 * A human looked at this file and agreed with it.
 *
 * The ledger lives in the files themselves, one `verified` block per file, so
 * a sign-off travels in the same diff as the thing it signs off and can never
 * drift from it. Nothing derives it: no script may write this block, and no
 * agent may add one on a human's behalf. It says a person checked the content
 * against something real — the facts file against a published circuit map, a
 * geometry file against that game's rendered lap — which is exactly the claim
 * no amount of re-running the detector can make.
 *
 * Absence means unverified, which is the honest default for a file the
 * generator produced. `carryVerified` drops the block the moment the content
 * changes, so a stale sign-off cannot survive a regeneration.
 */
export interface Verification {
  /** Who checked it. A person, not a tool. */
  by: string;
  /** ISO date (YYYY-MM-DD) of the check. */
  date: string;
  /** What they checked it against, when the file's own `source` doesn't say. */
  note?: string;
}

/**
 * Carry a sign-off onto a rewritten file, but only if the content is unchanged.
 *
 * Every writer runs its output through this. Regeneration that lands on exactly
 * the same corners and fractions has not invalidated anything, so the block
 * survives and a curated track doesn't lose its ledger entry to a no-op run.
 * The moment a single name or fraction moves, the block is dropped: what the
 * human agreed with no longer exists, and silently re-signing the replacement
 * would make the whole ledger worthless.
 */
export function carryVerified<T extends { verified?: Verification }>(previous: T | null | undefined, next: T): T {
  if (!previous?.verified) return next;
  if (!sameContent(previous, next)) return next;
  return { ...next, verified: previous.verified };
}

/** Deep equality ignoring `verified` and key order. */
function sameContent<T extends { verified?: Verification }>(a: T, b: T): boolean {
  return canonical(strip(a)) === canonical(strip(b));
}

function strip<T extends { verified?: Verification }>(v: T): Omit<T, "verified"> {
  const { verified: _drop, ...rest } = v;
  return rest;
}

/** JSON with object keys sorted, so field order in a hand-edited file doesn't read as a change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const entries = Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return Object.fromEntries(entries);
  });
}
