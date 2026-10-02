import { describe, test, expect } from "bun:test";
import { guideEntries, KNOWN_NUMBERING_CONFLICTS, KNOWN_OUT_OF_ORDER } from "../../support/tracks/track-guides";

function proseTurns(type: string): number[] | null {
  const m = type.match(/\((?:T|Turn\s*)(\d+)(?:\s*[-–]\s*T?(\d+))?[,)]/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

describe("anchor cross-checks (independent of how anchors were derived)", () => {
  test("guide prose and its anchor overlap, except for known meta numbering conflicts", () => {
    const conflicts: string[] = [];
    for (const e of guideEntries()) {
      const prose = proseTurns(e.type);
      if (!prose) continue;
      if (!prose.some((n) => e.numbers.includes(n))) conflicts.push(`${e.slug} :: ${e.name}`);
    }
    expect(conflicts.sort()).toEqual(KNOWN_NUMBERING_CONFLICTS);
  });
  test("anchors ascend in guide order, except where the guide lists out of sequence", () => {
    const bySlug = new Map<string, { name: string; numbers: number[] }[]>();
    for (const e of guideEntries()) bySlug.set(e.slug, [...(bySlug.get(e.slug) ?? []), e]);
    const anomalies: string[] = [];
    for (const [slug, entries] of bySlug) for (let i = 1; i < entries.length; i++) {
      const prev = Math.min(...entries[i - 1].numbers); const cur = Math.min(...entries[i].numbers);
      if (cur < prev) anomalies.push(`${slug} :: ${entries[i - 1].name} -> ${entries[i].name}`);
    }
    expect(anomalies.sort()).toEqual(KNOWN_OUT_OF_ORDER);
  });
});
