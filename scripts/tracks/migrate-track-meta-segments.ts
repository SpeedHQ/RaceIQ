import type { NamedSegment as LegacyNamedSegment } from "../../shared/racing/tracks/named-segments";
import { cornerKey, straightKey } from "../../shared/racing/tracks/keys";

/** `T1`, `T10-11`, `S3` are generated placeholders, not authored names. */
export function isPlaceholderName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  return /^T\d+(?:[-/]\d+)*$/i.test(n) || /^S\d*\??$/i.test(n);
}

/** Geometry row plus legacy labels retained for cross-game voting. */
export interface KeyedRow {
  key: string;
  startFrac: number;
  endFrac: number;
  legacy: LegacyNamedSegment;
}

/** Assign each straight the turn it follows, wrapping at start/finish. */
export function keySegments(segs: LegacyNamedSegment[]): KeyedRow[] {
  const ordered = [...segs].sort((a, b) => a.startFrac - b.startFrac);
  const n = ordered.length;
  const precedingTurn = new Array<number | null>(n).fill(null);
  let last: number | null = null;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const segment = ordered[i];
      if (segment.type === "corner" && segment.number != null) last = segment.number;
      else if (pass === 1) precedingTurn[i] = last;
    }
  }

  return ordered.map((segment, i): KeyedRow => {
    if (segment.type === "corner" && segment.number != null) {
      return {
        key: cornerKey([segment.number, ...(segment.covers ?? [])]),
        startFrac: segment.startFrac,
        endFrac: segment.endFrac,
        legacy: segment,
      };
    }
    const after = precedingTurn[i];
    return {
      key: after == null ? "s?" : straightKey(after),
      startFrac: segment.startFrac,
      endFrac: segment.endFrac,
      legacy: segment,
    };
  });
}

/** Vote one authored field across games, optionally dropping generated labels. */
export function vote(values: string[], stripPlaceholders: boolean): { value: string; conflict: string[] | null } {
  const present = values
    .map((value) => (value ?? "").trim())
    .filter((value) => value && (!stripPlaceholders || !isPlaceholderName(value)));
  if (present.length === 0) return { value: "", conflict: null };
  const distinct = [...new Set(present.map((value) => value.toLowerCase()))];
  if (distinct.length === 1) return { value: present[0], conflict: null };
  return { value: present[0], conflict: [...new Set(present)] };
}

/** Resolve physical direction across games, preferring majority then authored labels. */
export function voteDirection(rows: LegacyNamedSegment[]): {
  value: "" | "left" | "right";
  conflict: string[] | null;
} {
  const present = rows.filter((row) => row.direction === "left" || row.direction === "right");
  if (present.length === 0) return { value: "", conflict: null };

  const tally: Record<string, number> = {};
  for (const row of present) tally[row.direction!] = (tally[row.direction!] ?? 0) + 1;
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
    return { value: ranked[0][0] as "left" | "right", conflict: null };
  }

  const authored = [...new Set(present.filter((row) => !isPlaceholderName(row.name ?? "")).map((row) => row.direction!))];
  if (authored.length === 1) return { value: authored[0] as "left" | "right", conflict: null };

  return { value: ranked[0][0] as "left" | "right", conflict: ranked.map(([direction, count]) => `${direction}x${count}`) };
}
