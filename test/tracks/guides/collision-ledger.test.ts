import { describe, test, expect } from "bun:test";
import { numsOf, KNOWN_MERGES, guideAnchors, loadFacts } from "../../support/tracks/track-guides";

describe("guide entries sharing a meta segment are a known set", () => {
  test("no unregistered collisions (an unexpected one means a mislabeled entry)", () => {
    const anchors = guideAnchors();
    const bySlug = new Map<string, { name: string; numbers: number[] }[]>();
    for (const a of anchors) bySlug.set(a.slug, [...(bySlug.get(a.slug) ?? []), a]);
    const actual: string[] = [];
    for (const [slug, entries] of bySlug) {
      const facts = loadFacts(slug);
      if (!facts) continue;
      const labelOf = new Map<number, string>();
      for (const c of facts.corners ?? []) {
        const nums = numsOf(c);
        if (nums.length === 0) continue;
        for (const n of nums) labelOf.set(n, c.group ?? `${c.name || `T${nums.join("-")}`}|${nums.join(",")}`);
      }
      const grouped = new Map<string, string[]>();
      for (const e of entries) {
        const hit = labelOf.get(e.numbers[0]);
        if (!hit || !e.numbers.every((n) => labelOf.get(n) === hit)) continue;
        grouped.set(hit, [...(grouped.get(hit) ?? []), e.name]);
      }
      for (const names of grouped.values()) if (names.length > 1) actual.push(`${slug} :: ${names.join(" + ")}`);
    }
    const expected = Object.entries(KNOWN_MERGES).flatMap(([slug, groups]) => groups.map((g) => `${slug} :: ${g.join(" + ")}`)).sort();
    expect(actual.sort()).toEqual(expected);
  });
});
