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

/**
 * Optional corners that one game's centerline shows and another's doesn't.
 * `optional` means "may match nothing", so these fail silently — but a corner
 * detected on one game is real, and its absence on another is a detector gap,
 * not a track that lacks the corner. Nine of the eleven are ACC, which is the
 * shape of a systemic issue rather than nine unrelated corners.
 *
 * The big-radius cases (Curva Grande, Courbe Paul Frère) are fixed: the loose
 * second pass in detectCornerRegions now finds sweeps sitting on the strict
 * entry threshold. What remains are corners no pass sees at any threshold.
 *
 * This list is a defect register, not a baseline to re-bless: entries should
 * only be removed by fixing the detector, and a new entry means something
 * regressed.
 */
const KNOWN_DETECTOR_GAPS = new Set([
  "brands-hatch T7 acc", // Dingle Dell
  "catalunya T6 acc",
  "catalunya T14 f1-2025",
  "catalunya T14 fm-2023",
  "imola T8 acc",
  "imola T13 acc",
  "silverstone T5 acc", // Aintree
  "spa T16 acc", // Courbe Paul Frère — found on fm-2023 and f1-2025, not ACC
  "zandvoort T13 acc",
]);

describe("turn counts match real-world circuit data", () => {
  test("curated tracks exist", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  // An optional corner is only honest if EVERY game misses it. Where one game
  // finds it and another doesn't, the corner is real and the detector is the
  // problem — surface that instead of letting `optional` absorb it.
  test("no undeclared detector gaps (optional corner one game sees and another misses)", () => {
    const found: string[] = [];
    for (const slug of slugs) {
      const nameList = loadCornerNameList(slug)!;
      const optional = nameList.corners.filter((c) => c.optional);
      if (optional.length === 0) continue;
      const { aligned } = generateTrackSegments(slug, nameList);
      if (aligned.length < 2) continue; // nothing to compare against

      for (const opt of optional) {
        const misses = aligned.filter((a) => !a.corners.some((c) => c.numbers.includes(opt.number)));
        const hits = aligned.filter((a) => a.corners.some((c) => c.numbers.includes(opt.number)));
        if (hits.length === 0 || misses.length === 0) continue; // all or nothing is consistent
        for (const m of misses) found.push(`${slug} T${opt.number} ${m.gameId}`);
      }
    }
    const undeclared = found.filter((f) => !KNOWN_DETECTOR_GAPS.has(f));
    const fixed = [...KNOWN_DETECTOR_GAPS].filter((k) => !found.includes(k));
    expect(
      undeclared,
      `new detector gap — these games see the corner, this one doesn't: ${undeclared.join(", ")}`,
    ).toEqual([]);
    expect(fixed, `fixed! remove from KNOWN_DETECTOR_GAPS: ${fixed.join(", ")}`).toEqual([]);
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
