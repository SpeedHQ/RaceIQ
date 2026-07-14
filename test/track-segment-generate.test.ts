/**
 * Runs the real segment generator (same code path as `bun run
 * tracks:segments`) over every curated track and asserts:
 *   1. every game centerline aligns cleanly (no unsanctioned fuzz), and
 *   2. the committed meta files exactly match what --write would produce —
 *      i.e. name lists, detector, and shared/tracks/meta cannot drift apart.
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
import { loadSharedTrackMeta } from "../shared/track-data";
import { validateNameList } from "../shared/track-segment-align";

const slugs = listCuratedSlugs();

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
          expect(o.ok, `${slug}/${o.gameId}: ${o.detail}`).toBe(true);
          expect(o.cost, `${slug}/${o.gameId} has unsanctioned fuzz: ${o.detail}`).toBeLessThan(1);
        }
        expect(writableAlignments(aligned)).toHaveLength(aligned.length);
      });

      test("committed meta matches generator output (run tracks:segments --all --write if stale)", () => {
        const existing = loadSharedTrackMeta(slug);
        expect(existing).not.toBeNull();
        const regenerated = buildUpdatedMeta(existing, nameList, writableAlignments(aligned));
        expect(existing).toEqual(regenerated);
      });

      // Per-track invariants, checked on every game's generated output
      for (const a of aligned) {
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
            const expectedNames = new Set<string>();
            const optionalNames = new Set<string>();
            for (const c of nameList.corners) {
              const label = c.group ?? c.name;
              if (!label) continue;
              if (c.optional) optionalNames.add(label);
              else expectedNames.add(label);
            }
            for (const s of nameList.straights ?? []) expectedNames.add(s.name);
            for (const name of expectedNames) {
              expect(segmentNames, `${slug}/${a.gameId} missing "${name}"`).toContain(name);
            }
            // No curated name may appear twice (each is one section)
            const counts = new Map<string, number>();
            for (const n of segmentNames) counts.set(n, (counts.get(n) ?? 0) + 1);
            for (const [n, count] of counts) {
              if (expectedNames.has(n) || optionalNames.has(n)) {
                expect(count, `${slug}/${a.gameId} has ${count}× "${n}"`).toBe(1);
              }
            }
          });

          if (nameList.sectors) {
            test("anchored sector boundaries coincide with a corner section end", () => {
              expect(a.sectors).not.toBeNull();
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
