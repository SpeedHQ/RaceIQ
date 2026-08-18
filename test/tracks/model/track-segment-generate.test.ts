/**
 * Runs the real segment generator (same code path as `bun run
 * tracks:segments`) over every curated track and asserts:
 *   1. every game centerline aligns cleanly (no unsanctioned fuzz), and
 *   2. committed registry rows exactly match what --write would produce —
 *      shared facts and every game's geometry. Names, detector, and geometry
 *      cannot drift apart.
 *
 * If this fails after editing a name list or the detector, regenerate with:
 *   bun run tracks:segments --all --write
 */
import { describe, test, expect } from "bun:test";
import {
  buildUpdatedMeta,
  generateTrackSegments,
  listCuratedSlugs,
  writableAlignments,
} from "../../../shared/racing/tracks/curation/generate";
import { loadTrackFacts, loadTrackGeometry } from "../../../shared/racing/tracks/storage/meta";
import type { TrackGeometry } from "../../../shared/racing/tracks/geometry";
import { officialTurnCount, validateFacts } from "../../../shared/racing/tracks/curation/segment-align-validate";
import { loadDetectHints } from "../../../shared/racing/tracks/detect-hints";
import { KNOWN_ALIGNMENT_GAPS, KNOWN_FUZZY_ALIGNMENTS } from "../../support/tracks/known-gaps";

const slugs = listCuratedSlugs();


describe("track segment generator", () => {
  test("curated corner-name lists exist", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  for (const slug of slugs) {
    describe(slug, () => {
      const facts = loadTrackFacts(slug)!;
      const hints = loadDetectHints(slug);
      const { outcomes, aligned } = generateTrackSegments(slug, facts);

      test("accounts for every official turn", () => {
        expect(officialTurnCount(facts)).toBeGreaterThan(0);
        expect(validateFacts(facts, hints)).toEqual([]);
      });

      test("aligns on every available game centerline", () => {
        expect(outcomes.length).toBeGreaterThan(0);
        for (const o of outcomes) {
          if (KNOWN_ALIGNMENT_GAPS.has(`${slug}/${o.gameId}`)) {
            // Still assert it stays broken: if the centerline gets fixed, this
            // fails and the entry must be removed from KNOWN_ALIGNMENT_GAPS.
            expect(o.ok, `${slug}/${o.gameId} now aligns — drop it from KNOWN_ALIGNMENT_GAPS`).toBe(false);
            continue;
          }
          if (KNOWN_FUZZY_ALIGNMENTS.has(`${slug}/${o.gameId}`)) {
            // Stays sanctioned only while it really is too fuzzy to persist.
            expect(o.cost, `${slug}/${o.gameId} now aligns cleanly — drop it from KNOWN_FUZZY_ALIGNMENTS`).toBeGreaterThanOrEqual(1);
            continue;
          }
          expect(o.ok, `${slug}/${o.gameId}: ${o.detail}`).toBe(true);
          expect(o.cost, `${slug}/${o.gameId} has unsanctioned fuzz: ${o.detail}`).toBeLessThan(1);
        }
        // A failed outcome never reaches `aligned`; a fuzzy one does but is too
        // loose to persist, so only those are subtracted here.
        const fuzzy = outcomes.filter((o) => KNOWN_FUZZY_ALIGNMENTS.has(`${slug}/${o.gameId}`)).length;
        expect(writableAlignments(aligned)).toHaveLength(aligned.length - fuzzy);
      });

      test("committed meta matches generator output (run tracks:segments --all --write if stale)", () => {
        expect(facts).not.toBeNull();
        const writable = writableAlignments(aligned);
        // Feeding the committed geometry back in is what proves curated sectors
        // survive: a generated pair may only fill a game that has none.
        const committed: Record<string, TrackGeometry> = {};
        for (const a of writable) {
          const geometry = loadTrackGeometry(slug, a.gameId);
          expect(geometry, `${slug}/${a.gameId} has no committed geometry file`).not.toBeNull();
          committed[a.gameId] = geometry!;
        }
        const regenerated = buildUpdatedMeta(slug, facts, committed, writable);
        expect(facts).toEqual(regenerated.facts);
        for (const [gameId, geometry] of Object.entries(regenerated.geometry)) {
          expect(committed[gameId], `${slug}/${gameId} geometry is stale`).toEqual(geometry);
        }
      });

      // Per-track invariants, checked on every game's generated output. A
      // sanctioned-fuzzy pairing is excluded: its segmentation is known not to
      // fit, it is never persisted, and asserting shape on it would just restate
      // the fuzz the entry above already records.
      for (const a of aligned.filter((x) => !KNOWN_FUZZY_ALIGNMENTS.has(`${slug}/${x.gameId}`))) {
        describe(a.gameId, () => {
          test("segments cover the whole lap in order without overlap", () => {
            expect(a.segments.length).toBeGreaterThan(0);
            expect(a.segments[0].startFrac).toBe(0);
            expect(a.segments[a.segments.length - 1].endFrac).toBe(1);
            for (let i = 0; i < a.segments.length; i++) {
              const s = a.segments[i];
              expect(s.endFrac).toBeGreaterThan(s.startFrac);
              // Contiguous up to sliver tolerance (tiny gaps between chicane
              // elements are absorbed, never overlapping)
              if (i > 0) {
                expect(s.startFrac).toBeGreaterThanOrEqual(a.segments[i - 1].endFrac - 1e-9);
                expect(s.startFrac - a.segments[i - 1].endFrac).toBeLessThan(0.003);
              }
            }
          });

          test("every curated name appears (optional corners at most once)", () => {
            const segmentNames = a.segments.map((s) => s.name).filter(Boolean);
            // A grouped complex (Rivazza, Les Combes, COTA's T13/T14) is NOT one
            // section: each turn is its own row carrying its own official number
            // so the debug editor can move a single apex. The complex name lives
            // on `group`, and consumers that label the map draw it once from there.
            const segmentGroups = new Set(a.segments.map((s) => s.group).filter(Boolean));
            const expectedNames = new Set<string>();
            const optionalNames = new Set<string>();
            const expectedGroups = new Set<string>();
            for (const c of facts.corners) {
              // A hinted-optional corner may be folded into the straight by a
              // game's centerline, so its name is allowed but never required.
              const optional = hints.get(c.number)?.optional === true;
              if (c.group && !optional) expectedGroups.add(c.group);
              if (!c.name) continue;
              if (optional) optionalNames.add(c.name);
              else expectedNames.add(c.name);
            }
            for (const s of facts.straights ?? []) {
              if (s.name) expectedNames.add(s.name);
            }
            for (const name of expectedNames) {
              expect(segmentNames, `${slug}/${a.gameId} missing "${name}"`).toContain(name);
            }
            for (const group of expectedGroups) {
              expect([...segmentGroups], `${slug}/${a.gameId} missing group "${group}"`).toContain(group);
            }
            // A curated name may appear once per curated entry bearing it. Most
            // names are unique, but a grouped complex can repeat a name across
            // its members (Donington T9+T10 are both "Fogarty Esses"), and each
            // member is its own section — so the expected count is data-driven.
            // The start/finish straight is the one extra case: the line splits
            // it into the lap's first and last segment.
            const first = a.segments[0];
            const last = a.segments[a.segments.length - 1];
            const splitByLine =
              first?.type === "straight" && last?.type === "straight" && first.name && first.name === last.name
                ? first.name
                : null;
            const curatedCounts = new Map<string, number>();
            for (const c of facts.corners) {
              if (c.name) curatedCounts.set(c.name, (curatedCounts.get(c.name) ?? 0) + 1);
            }
            for (const s of facts.straights ?? []) {
              if (s.name) curatedCounts.set(s.name, (curatedCounts.get(s.name) ?? 0) + 1);
            }
            const counts = new Map<string, number>();
            for (const n of segmentNames) counts.set(n, (counts.get(n) ?? 0) + 1);
            for (const [n, count] of counts) {
              if (expectedNames.has(n) || optionalNames.has(n)) {
                const allowed = (curatedCounts.get(n) ?? 1) + (n === splitByLine ? 1 : 0);
                expect(count, `${slug}/${a.gameId} has ${count}× "${n}", curated allows ${allowed}`).toBe(allowed);
              }
            }
          });

          // Sectors are per-game curation living in geometry, not something a
          // regeneration derives, so the invariant is checked on what is
          // committed for this game rather than on the alignment.
          const sectors = loadTrackGeometry(slug, a.gameId)?.sectors;
          if (sectors) {
            test("committed sector boundaries split the lap in order", () => {
              expect(sectors.s1End).toBeGreaterThan(0);
              expect(sectors.s1End).toBeLessThan(sectors.s2End);
              expect(sectors.s2End).toBeLessThan(1);
            });
          }
        });
      }
    });
  }
});
