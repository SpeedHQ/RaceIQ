/** Committed track facts and geometry roster contracts. */
import { describe, test, expect } from "bun:test";
import { cornerNumbers, type TrackFacts } from "../../../shared/racing/tracks/facts";
import type { TrackGeometry } from "../../../shared/racing/tracks/geometry";
import { checkKeys } from "../../../shared/racing/tracks/curation/join";
import { loadTrackRegistrySource } from "../../../shared/racing/tracks/registry/source";

const GAME_IDS = ["fm-2023", "acc", "ac-evo", "f1-2025"] as const;
const SOURCE = loadTrackRegistrySource();
const FACTS_BY_SLUG = new Map(SOURCE.facts.facts.map((facts) => [facts.slug, facts]));
function loadFacts(slug: string): TrackFacts {
  const facts = FACTS_BY_SLUG.get(slug);
  if (!facts) throw new Error(`Missing track facts fixture: ${slug}`);
  return facts;
}
function geometryFor(slug: string): Record<string, TrackGeometry> {
  const out: Record<string, TrackGeometry> = {};
  for (const gameId of GAME_IDS) {
    const geometry = SOURCE.geometry.geometry.find((entry) => entry.factsSlug === slug && entry.gameId === gameId);
    if (geometry) out[gameId] = geometry;
  }
  return out;
}
const SLUGS = [...FACTS_BY_SLUG.keys()].sort();
const KNOWN_CORNER_GAPS: Record<string, string[]> = {
  "brands-hatch/acc": ["t7"], "brands-hatch/ac-evo": ["t7"],
  "catalunya/acc": ["t13", "t15", "t6"], "catalunya/f1-2025": ["t13", "t14", "t15"], "catalunya/fm-2023": ["t13", "t14", "t15"],
  "imola/acc": ["t1", "t16", "t8"], "imola/ac-evo": ["t1", "t10", "t13", "t16", "t8"], "imola/f1-2025": ["t1", "t8"],
  "laguna-seca/ac-evo": ["t1"], "sebring/ac-evo": ["t12", "t2"], "sebring/fm-2023": ["t2"],
  "silverstone/acc": ["t5"], "spa/ac-evo": ["t16"], "zandvoort/acc": ["t13"],
  "baku/f1-2025": ["t13", "t14"], "hockenheim/fm-2023": ["t11", "t4", "t5"], "jeddah/f1-2025": ["t19", "t25"],
  "las-vegas/f1-2025": ["t11"], "lusail/f1-2025": ["t11"], "mid-ohio/fm-2023": ["t3"], "montreal/f1-2025": ["t11"],
  "road-america/fm-2023": ["t2", "t4"], "sakhir/f1-2025": ["t15"], "shanghai/f1-2025": ["t15"], "vir/fm-2023": ["t2"],
  "donington/acc": ["t6"], "donington/ac-evo": ["t6"], "spielberg/acc": ["t2", "t8"], "spielberg/ac-evo": ["t2", "t8"], "spielberg/f1-2025": ["t2", "t8"],
  "road-atlanta/ac-evo": ["t8"],
};
const KNOWN_STRAIGHT_GAPS: Record<string, string[]> = {};

describe("committed roster", () => {
  test("every layout has a facts file that parses", () => {
    expect(SLUGS.length).toBeGreaterThan(90);
    for (const slug of SLUGS) expect(() => loadFacts(slug)).not.toThrow();
  });
  test("facts carry layout identity and never carry fractions", () => {
    for (const slug of SLUGS) {
      const facts = loadFacts(slug);
      expect(facts.slug, slug).toBe(slug); expect(facts.track, slug).toBeTruthy(); expect(facts.layout, slug).toBeTruthy(); expect(facts.layoutName, slug).toBeTruthy();
      for (const corner of facts.corners) {
        const stray = Object.keys(corner).filter((k) => k === "startFrac" || k === "endFrac");
        expect(stray, `${slug} T${corner.number}`).toEqual([]);
      }
    }
  });
  test("geometry files never carry a name, group or direction", () => {
    for (const slug of SLUGS) for (const [gameId, geom] of Object.entries(geometryFor(slug))) for (const seg of geom.segments) {
      const leaked = Object.keys(seg).filter((k) => !["key", "startFrac", "endFrac"].includes(k));
      expect(leaked, `${slug}/${gameId}`).toEqual([]);
    }
  });
  test("a corner's turn numbers are unique within its layout", () => {
    for (const slug of SLUGS) {
      const seen = new Set<number>();
      for (const corner of loadFacts(slug).corners) for (const n of cornerNumbers(corner)) { expect(seen.has(n), `${slug} turn ${n} claimed twice`).toBe(false); seen.add(n); }
    }
  });
  test("a corner's `number` is the lowest of the span it covers", () => {
    for (const slug of SLUGS) for (const corner of loadFacts(slug).corners) expect(corner.number, `${slug} T${corner.number}`).toBe(cornerNumbers(corner)[0]);
  });
  test("a named straight follows a turn the layout actually has", () => {
    for (const slug of SLUGS) {
      const facts = loadFacts(slug); const turns = new Set(facts.corners.flatMap(cornerNumbers));
      for (const s of facts.straights ?? []) expect(turns.has(s.after), `${slug} straight after T${s.after}`).toBe(true);
    }
  });
  test("no game silently drops a corner its layout declares", () => {
    const gaps: Record<string, string[]> = {};
    for (const slug of SLUGS) {
      const geometry = geometryFor(slug); if (Object.keys(geometry).length === 0) continue;
      for (const m of checkKeys(loadFacts(slug), geometry)) { expect(m.unknown, `${slug}/${m.gameId} references turns the layout lacks`).toEqual([]); if (m.missing.length) gaps[`${slug}/${m.gameId}`] = m.missing; }
    }
    const unexpected = Object.entries(gaps).filter(([k, missing]) => (KNOWN_CORNER_GAPS[k] ?? []).join() !== missing.join()).map(([k, missing]) => `${k}: missing ${missing.join(",")}`);
    expect(unexpected, "new corner gap — fix the detector or record it in KNOWN_CORNER_GAPS").toEqual([]);
  });
  test("KNOWN_CORNER_GAPS has no stale entries", () => {
    const live = new Set<string>();
    for (const slug of SLUGS) { const geometry = geometryFor(slug); if (!Object.keys(geometry).length) continue; for (const m of checkKeys(loadFacts(slug), geometry)) if (m.missing.length) live.add(`${slug}/${m.gameId}`); }
    expect(Object.keys(KNOWN_CORNER_GAPS).filter((k) => !live.has(k)), "gap is fixed — delete it from KNOWN_CORNER_GAPS").toEqual([]);
  });
  test("no game silently drops a named straight", () => {
    const gaps: Record<string, string[]> = {};
    for (const slug of SLUGS) { const geometry = geometryFor(slug); if (!Object.keys(geometry).length) continue; for (const m of checkKeys(loadFacts(slug), geometry)) if (m.unplacedStraights.length) gaps[`${slug}/${m.gameId}`] = m.unplacedStraights; }
    const unexpected = Object.entries(gaps).filter(([k, unplaced]) => (KNOWN_STRAIGHT_GAPS[k] ?? []).join() !== unplaced.join()).map(([k, unplaced]) => `${k}: never places ${unplaced.join(",")}`);
    expect(unexpected, "new unplaced named straight — fix the detector or record it in KNOWN_STRAIGHT_GAPS").toEqual([]);
  });
  test("KNOWN_STRAIGHT_GAPS has no stale entries", () => {
    const live = new Set<string>();
    for (const slug of SLUGS) { const geometry = geometryFor(slug); if (!Object.keys(geometry).length) continue; for (const m of checkKeys(loadFacts(slug), geometry)) if (m.unplacedStraights.length) live.add(`${slug}/${m.gameId}`); }
    expect(Object.keys(KNOWN_STRAIGHT_GAPS).filter((k) => !live.has(k)), "straight is now placed — delete it from KNOWN_STRAIGHT_GAPS").toEqual([]);
  });
  test("every layout of a venue agrees on the venue name", () => {
    const nameByTrack: Record<string, { slug: string; name: string }> = {};
    for (const slug of SLUGS) { const facts = loadFacts(slug); const seen = nameByTrack[facts.track]; if (!seen) { nameByTrack[facts.track] = { slug, name: facts.name }; continue; } expect(facts.name, `${slug} vs ${seen.slug} under venue ${facts.track}`).toBe(seen.name); }
  });
  test("a venue never has two layouts with the same layout id", () => {
    const seen = new Set<string>();
    for (const slug of SLUGS) { const facts = loadFacts(slug); const pair = `${facts.track}/${facts.layout}`; expect(seen.has(pair), `duplicate layout ${pair} at ${slug}`).toBe(false); seen.add(pair); }
  });
});
