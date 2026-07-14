/**
 * Turn-count accuracy against real-world data: the `turnCount` in each
 * shared/tracks/corner-names/<slug>.json is the official turn count from the
 * circuit's own map / FIA track guide (see the `source` field). Every game's
 * centerline must align onto that list such that every official turn 1..turnCount
 * is accounted for.
 *
 * This is deliberately NOT a snapshot of what the detector currently finds — a
 * detector regression that drops Blanchimont must fail, not be re-baselined.
 * The only turns allowed to go unmatched are ones the name list explicitly marks
 * `optional` (shallow kinks some games' centerlines don't model at all).
 */
import { describe, test, expect } from "bun:test";
import { validateNameList } from "../shared/track-segment-align";
import { findCenterlines, generateTrackSegments, listCuratedSlugs, loadCornerNameList } from "../shared/track-segment-generate";

const slugs = listCuratedSlugs();

describe("turn counts match real-world circuit data", () => {
  test("curated tracks exist", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  for (const slug of slugs) {
    const nameList = loadCornerNameList(slug)!;

    test(`${slug}: name list accounts for all ${nameList.turnCount} official turns`, () => {
      const errors = validateNameList(nameList).filter((i) => i.severity === "error");
      expect(errors.map((e) => e.message), `${slug} (${nameList.circuit})`).toEqual([]);
    });

    test(`${slug}: cites its real-world source`, () => {
      expect(nameList.source?.trim(), `${slug}: add a "source" naming the circuit map / track guide`).toBeTruthy();
    });

    const { aligned, outcomes } = generateTrackSegments(slug, nameList);
    // Turns a game's centerline is permitted to miss entirely.
    const optional = new Set(nameList.corners.filter((c) => c.optional).flatMap((c) => [c.number, ...(c.covers ?? [])]));

    // A failed alignment produces no GameAlignment, so without this every
    // per-game assertion below would silently vanish instead of failing.
    test(`${slug}: every game centerline aligns`, () => {
      const games = [...new Set(findCenterlines(slug).map((c) => c.gameId))];
      const alignedGames = new Set(aligned.map((a) => a.gameId));
      const failed = games.filter((g) => !alignedGames.has(g));
      const why = outcomes.filter((o) => !o.ok).map((o) => `${o.gameId}: ${o.detail}`);
      expect(failed, `${slug} (${nameList.circuit}) failed to align — ${why.join(" | ")}`).toEqual([]);
      expect(games.length, `${slug}: no centerline found for any game`).toBeGreaterThan(0);
    });

    for (const a of aligned) {
      test(`${a.gameId}/${slug}: detects ${nameList.turnCount} official turns`, () => {
        const matched = new Set(a.corners.flatMap((c) => c.numbers));
        const missing: number[] = [];
        for (let n = 1; n <= nameList.turnCount; n++) {
          if (!matched.has(n) && !optional.has(n)) missing.push(n);
        }
        const extra = [...matched].filter((n) => n < 1 || n > nameList.turnCount);

        expect(
          missing,
          `${a.gameId}/${slug} (${nameList.circuit}): official turns ${missing.join(", ")} not detected — ` +
            `real turn count is ${nameList.turnCount} per ${nameList.source}. Check the SVG in ` +
            `test/e2e/output/track-segments; fix the detector or mark the turn optional if the game's centerline genuinely omits it.`,
        ).toEqual([]);
        expect(extra, `${a.gameId}/${slug}: aligned turn numbers outside 1..${nameList.turnCount}`).toEqual([]);
      });
    }
  }
});
