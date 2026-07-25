/**
 * Runs the real segment generator (same code path as `bun run
 * tracks:segments`) over every curated track and asserts:
 *   1. every game centerline aligns cleanly (no unsanctioned fuzz), and
 *   2. the committed meta files exactly match what --write would produce — the
 *      shared facts and every game's geometry file — i.e. name lists, detector,
 *      shared/tracks/meta and shared/tracks/<game> cannot drift apart.
 *
 * If this fails after editing a name list or the detector, regenerate with:
 *   bun run tracks:segments --all --write
 */
import { describe, test, expect } from "bun:test";
import {
  buildUpdatedMeta,
  generateTrackSegments,
  listCuratedSlugs,
  loadCornerNameList,
  writableAlignments,
} from "../shared/track-segment-generate";
import { loadTrackFacts, loadTrackGeometry } from "../shared/track-data";
import type { TrackGeometry } from "../shared/track-meta";
import { validateNameList } from "../shared/track-segment-align";

const slugs = listCuratedSlugs();

/**
 * ac-evo centerlines that under-detect corner regions, so the curated name list
 * cannot align against them. The corner-name lists are shared across games and
 * align cleanly on ACC/F1/FM, so the gap is ac-evo centerline/detector quality —
 * regrouping the names to suit ac-evo would break the other games.
 *
 * TODO(follow-up PR): retune the ac-evo centerlines for these tracks and delete
 * this list. Deliberately keyed by `slug/gameId` so a newly broken track fails
 * loudly instead of being silently absorbed.
 */
const KNOWN_DETECTOR_GAPS = new Set([
  "laguna-seca/ac-evo",
  "road-atlanta/ac-evo",
  "sebring/ac-evo",
]);

/**
 * Pairings that align, but too loosely to persist (cost >= 1), so the committed
 * geometry stays whatever the migration produced from that game's own data.
 *
 * `nordschleife` folded three games onto one slug, but its curated name list was
 * authored against ACC's centerline: 60 corners, starting at the ACC start line.
 * Forza's Nordschleife is the same tarmac digitised into 69 corners from a
 * different lap origin (rotation offset 88) in a mirrored frame, so the list
 * cannot place itself on it. Forza's committed geometry came from Forza's own
 * legacy segmentation and is correct; only regeneration can't reproduce it.
 *
 * TODO(follow-up PR): reconcile shared/tracks/corner-names/nordschleife.json to
 * the 69-corner segmentation and delete this. Same shrink-only contract as
 * KNOWN_DETECTOR_GAPS — a pairing that starts aligning cleanly fails here.
 */
const KNOWN_FUZZY_ALIGNMENTS = new Set(["nordschleife/fm-2023"]);

describe("track segment generator", () => {
  test("curated corner-name lists exist", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  for (const slug of slugs) {
    describe(slug, () => {
      const nameList = loadCornerNameList(slug)!;
      const { outcomes, aligned } = generateTrackSegments(slug, nameList);

      test("accounts for every official turn (turnCount)", () => {
        expect(nameList.turnCount).toBeGreaterThan(0);
        expect(validateNameList(nameList)).toEqual([]);
      });

      test("aligns on every available game centerline", () => {
        expect(outcomes.length).toBeGreaterThan(0);
        for (const o of outcomes) {
          if (KNOWN_DETECTOR_GAPS.has(`${slug}/${o.gameId}`)) {
            // Still assert it stays broken: if the centerline gets fixed, this
            // fails and the entry must be removed from KNOWN_DETECTOR_GAPS.
            expect(o.ok, `${slug}/${o.gameId} now aligns — drop it from KNOWN_DETECTOR_GAPS`).toBe(false);
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
        const facts = loadTrackFacts(slug);
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
        const regenerated = buildUpdatedMeta(slug, facts, committed, nameList, writable);
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
            for (const c of nameList.corners) {
              if (c.group && !c.optional) expectedGroups.add(c.group);
              if (!c.name) continue;
              if (c.optional) optionalNames.add(c.name);
              else expectedNames.add(c.name);
            }
            for (const s of nameList.straights ?? []) {
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
              first?.type === "straight" && last?.type === "straight" && !!first.name && first.name === last.name
                ? first.name
                : null;
            const curatedCounts = new Map<string, number>();
            for (const c of nameList.corners) {
              if (c.name) curatedCounts.set(c.name, (curatedCounts.get(c.name) ?? 0) + 1);
            }
            for (const s of nameList.straights ?? []) {
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

          if (nameList.sectors) {
            test("anchored sector boundaries coincide with a corner section end", () => {
              // Rotated centerlines can wrap official sector anchors out of
              // order — the generator then drops sectors (with a warning)
              // rather than writing an invalid pair.
              if (a.sectors === null) return;
              const cornerEnds = new Set(
                a.segments.filter((s) => s.type === "corner").map((s) => s.endFrac),
              );
              const anchorChecks: [number | undefined, number][] = [
                [nameList.sectors!.s1EndAfterCorner, a.sectors!.s1End],
                [nameList.sectors!.s2EndAfterCorner, a.sectors!.s2End],
              ];
              for (const [anchor, frac] of anchorChecks) {
                if (anchor === undefined) continue;
                // Only exact when no meter offset is configured
                const offset = anchor === nameList.sectors!.s1EndAfterCorner
                  ? nameList.sectors!.s1OffsetM
                  : nameList.sectors!.s2OffsetM;
                if (!offset && a.sectors!.source === "corner-anchored") {
                  expect(cornerEnds.has(frac), `${slug}/${a.gameId} sector ${frac} not at a section end`).toBe(true);
                }
              }
              expect(a.sectors!.s1End).toBeGreaterThan(0);
              expect(a.sectors!.s1End).toBeLessThan(a.sectors!.s2End);
              expect(a.sectors!.s2End).toBeLessThan(1);
            });
          }
        });
      }
    });
  }
});
