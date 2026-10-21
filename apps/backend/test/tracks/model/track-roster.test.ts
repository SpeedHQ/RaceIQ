/** Committed track facts and geometry roster contracts. */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { cornerNumbers, type TrackFacts } from "@raceiq/shared/racing/tracks/facts";
import type { TrackGeometry } from "@raceiq/shared/racing/tracks/geometry";
import { checkKeys, joinSegments } from "@raceiq/shared/racing/tracks/curation/join";
import { SHARED_DIR } from "@raceiq/shared/platform/runtime/data-paths";
import { turnNumbers } from "@raceiq/shared/racing/tracks/segment-label";

const META_DIR = resolve(SHARED_DIR, "tracks", "meta");
const GAME_IDS = readdirSync(resolve(SHARED_DIR, "tracks"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
function loadFacts(slug: string): TrackFacts {
  return JSON.parse(readFileSync(resolve(META_DIR, `${slug}.json`), "utf-8")) as TrackFacts;
}
function geometryFor(slug: string): Record<string, TrackGeometry> {
  const out: Record<string, TrackGeometry> = {};
  for (const gameId of GAME_IDS) {
    const path = resolve(SHARED_DIR, "tracks", gameId, `${slug}-segments.json`);
    if (existsSync(path)) out[gameId] = JSON.parse(readFileSync(path, "utf-8")) as TrackGeometry;
  }
  return out;
}
const SLUGS = readdirSync(META_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort();
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
  test("facts account for every official turn exactly once", () => {
    for (const slug of SLUGS) {
      const turns = loadFacts(slug).corners.flatMap(cornerNumbers).sort((a, b) => a - b);
      const turnCount = turns.at(-1) ?? 0;
      expect(turns, `${slug}: missing or duplicate fact turn numbers`).toEqual(
        Array.from({ length: turnCount }, (_, index) => index + 1),
      );
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
  for (const slug of SLUGS) {
    const facts = loadFacts(slug);
    const expectedTurns = facts.corners.flatMap(cornerNumbers).sort((a, b) => a - b);
    for (const [gameId, geometry] of Object.entries(geometryFor(slug))) {
      test(`${gameId}/${slug}: displayed segments cover every fact turn exactly once`, () => {
        const corners = joinSegments(facts, geometry).filter((segment) => segment.type === "corner");
        expect(corners.every((corner) => Number.isInteger(corner.number)), "unnumbered corner").toBe(true);
        // Do not deduplicate: duplicates can hide a missing turn when counts match.
        const actualTurns = corners.flatMap(turnNumbers).sort((a, b) => a - b);
        const missing = expectedTurns.filter((number) => !actualTurns.includes(number));
        const extra = actualTurns.filter((number) => !expectedTurns.includes(number));
        const duplicates = actualTurns.filter((number, index) => actualTurns.indexOf(number) !== index);
        expect(
          actualTurns,
          `missing: [${missing}]; extra: [${extra}]; duplicate: [${duplicates}]; expected ${expectedTurns.length} official turns`,
        ).toEqual(expectedTurns);
      });
    }
  }
  test("no game silently drops a named straight", () => {
    const gaps: Record<string, string[]> = {};
    for (const slug of SLUGS) {
      const geometry = geometryFor(slug);
      if (!Object.keys(geometry).length) continue;
      for (const m of checkKeys(loadFacts(slug), geometry)) {
        expect(m.unknown, `${slug}/${m.gameId} references keys the layout lacks`).toEqual([]);
        if (m.unplacedStraights.length) gaps[`${slug}/${m.gameId}`] = m.unplacedStraights;
      }
    }
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

describe("curated native corner landmarks", () => {
  // Native centerline apex locations checked against the official maps cited
  // in the track README. These are independent of the edited section bounds:
  // a complete numbered list must not hide a turn placed on the wrong bend.
  const cases = [
    ["acc", "imola", [[14, 0.684449], [15, 0.696388], [16, 0.801587], [17, 0.850699], [18, 0.878461], [19, 0.936216]]],
    ["ac-evo", "imola", [[14, 0.686022], [15, 0.692708], [16, 0.808773], [17, 0.847632], [18, 0.871428], [19, 0.945783]]],
    ["f1-2025", "imola", [[14, 0.729924], [15, 0.737697], [16, 0.854711], [17, 0.889661], [18, 0.919032], [19, 0.988975]]],
    ["f1-2025", "catalunya-no-chicane", [[10, 0.751846], [11, 0.783967], [12, 0.830048], [13, 0.882708], [14, 0.927844]]],
    ["fm-2023", "catalunya-no-chicane", [[10, 0.727547], [11, 0.755778], [12, 0.788697], [13, 0.846450], [14, 0.908861]]],
    ["f1-2025", "shanghai", [[14, 0.882334], [15, 0.899322], [16, 0.950348]]],
  ] as const;

  for (const [gameId, slug, landmarks] of cases) {
    test(`${gameId}/${slug}: official turns own their native apex landmarks`, () => {
      const segments = joinSegments(loadFacts(slug), geometryFor(slug)[gameId]);
      for (const [number, apexFrac] of landmarks) {
        const section = segments.find((segment) => apexFrac >= segment.startFrac && apexFrac < segment.endFrac);
        expect(section?.type, `${gameId}/${slug} T${number} apex is not a straight`).toBe("corner");
        expect(section?.number, `${gameId}/${slug} apex at ${apexFrac} belongs to T${number}`).toBe(number);
      }
    });
  }
});
