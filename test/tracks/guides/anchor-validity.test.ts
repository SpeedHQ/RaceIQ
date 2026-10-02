import { describe, test, expect } from "bun:test";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { KNOWN_ANCHOR_GAPS, guideAnchors, knownTurns, loadFacts, unanchoredEntries } from "../../support/tracks/track-guides";

initGameAdapters();
initServerGameAdapters();

describe("unanchored guide entries are a known, justified set", () => {
  test("register matches reality exactly (fails both ways)", () => {
    const actual = unanchoredEntries();
    const flat = (r: Record<string, string[]>) => Object.entries(r).flatMap(([s, names]) => names.map((n) => `${s} :: ${n}`)).sort();
    expect(flat(actual)).toEqual(flat(KNOWN_ANCHOR_GAPS));
  });
});
describe("track guide turn-number anchors", () => {
  const anchors = guideAnchors();
  test("the guides carry anchors at all", () => expect(anchors.length).toBeGreaterThan(200));
  test("every anchored turn exists in that track's meta", () => {
    const offenders: string[] = [];
    for (const a of anchors) {
      const facts = loadFacts(a.slug);
      if (!facts) { offenders.push(`${a.slug} :: ${a.name} — anchored but no facts file`); continue; }
      const turns = knownTurns(facts);
      const missing = a.numbers.filter((n) => !turns.has(n));
      if (missing.length) offenders.push(`${a.slug} :: ${a.name} — layout has no turn ${missing.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
  test("anchors are non-empty and ascending", () => {
    const bad = anchors.filter((a) => a.numbers.length === 0 || a.numbers.some((n, i) => i > 0 && n <= a.numbers[i - 1]));
    expect(bad.map((b) => `${b.slug} :: ${b.name}`)).toEqual([]);
  });
});
