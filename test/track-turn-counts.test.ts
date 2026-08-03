/**
 * Turn-count accuracy against real-world data: the corner roster in each
 * shared/tracks/meta/<slug>.json is the official turn count from the
 * circuit's own map / FIA track guide (see the `source` field). Every game's
 * centerline must align onto that roster such that every official turn
 * 1..officialTurnCount is accounted for.
 *
 * This is deliberately NOT a snapshot of what the detector currently finds — a
 * detector regression that drops Blanchimont must fail, not be re-baselined.
 * The only turns allowed to go unmatched are ones marked `optional` in
 * shared/tracks/detect-hints.json (shallow kinks some games' centerlines don't
 * model at all) — a detector allowance, not a fact about the circuit.
 */
import { describe, test, expect } from "bun:test";
import { turnNumbers } from "../shared/track/segment-label";
import { officialTurnCount, validateFacts } from "../shared/track/curation/segment-align-validate";
import { loadTrackFacts } from "../shared/track/storage/meta";
import { loadDetectHints } from "../shared/track/detect-hints";
import {
  findCenterlines,
  generateTrackSegments,
  listCuratedSlugs,
  listMetaSlugs,
} from "../shared/track/curation/generate";
import { KNOWN_ALIGNMENT_GAPS, KNOWN_TURN_GAPS } from "./helpers/track-known-gaps";

const slugs = listCuratedSlugs();

/**
 * Rosters that predate the meta migration and were never traced to a circuit
 * map. They are excluded from the curated assertions below; cite them and they
 * join the suite.
 */
const UNCITED_ROSTERS = ["fuji"];


describe("turn counts match real-world circuit data", () => {
  test("curated tracks exist", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  // `source` is what makes a roster checkable against the real circuit, and it
  // is also what promotes a meta into the curated set asserted below. A roster
  // that appears without one is invisible to every assertion in this file, so
  // name the known offenders here — a new one is a migration that forgot to
  // carry the citation across.
  test("no roster outside the curated set carries a source", () => {
    // listCuratedSlugs() keys off `corners`, not `source`. If a meta ever grows a
    // citation without a roster the per-slug tests below would never see it.
    const orphaned = listMetaSlugs().filter((slug) => {
      const f = loadTrackFacts(slug);
      return !!f?.source?.trim() && (f?.corners.length ?? 0) === 0;
    });
    expect(orphaned, "source with no corner roster — transcribe it or drop the citation").toEqual([]);
  });

  // An optional corner is only honest if EVERY game misses it. Where one game
  // finds it and another doesn't, the corner is real and the detector is the
  // problem — surface that instead of letting `optional` absorb it.
  test("no undeclared detector gaps (optional corner one game sees and another misses)", () => {
    const found: string[] = [];
    for (const slug of slugs) {
      const facts = loadTrackFacts(slug)!;
      const hints = loadDetectHints(slug);
      const optional = facts.corners.filter((c) => hints.get(c.number)?.optional);
      if (optional.length === 0) continue;
      const { aligned } = generateTrackSegments(slug, facts);
      if (aligned.length < 2) continue; // nothing to compare against

      for (const opt of optional) {
        const misses = aligned.filter((a) => !a.corners.some((c) => turnNumbers(c).includes(opt.number)));
        const hits = aligned.filter((a) => a.corners.some((c) => turnNumbers(c).includes(opt.number)));
        if (hits.length === 0 || misses.length === 0) continue; // all or nothing is consistent
        for (const m of misses) found.push(`${slug} T${opt.number} ${m.gameId}`);
      }
    }
    const undeclared = found.filter((f) => !KNOWN_TURN_GAPS.has(f));
    const fixed = [...KNOWN_TURN_GAPS].filter((k) => !found.includes(k));
    expect(
      undeclared,
      `new detector gap — these games see the corner, this one doesn't: ${undeclared.join(", ")}`,
    ).toEqual([]);
    expect(fixed, `fixed! remove from KNOWN_TURN_GAPS: ${fixed.join(", ")}`).toEqual([]);
  });

  for (const slug of slugs) {
    const facts = loadTrackFacts(slug)!;
    const turnCount = officialTurnCount(facts);

    test(`${slug}: roster accounts for all ${turnCount} official turns`, () => {
      const errors = validateFacts(facts, loadDetectHints(slug)).filter((i) => i.severity === "error");
      expect(errors.map((e) => e.message), `${slug} (${facts.name})`).toEqual([]);
    });

    // Without a citation the turn numbers are unverifiable, so every assertion
    // below is asserting against nothing. Known offenders are listed in
    // UNCITED_ROSTERS; a new one is a migration that forgot to carry it across.
    test(`${slug}: cites its real-world source`, () => {
      const cited = !!facts.source?.trim();
      if (UNCITED_ROSTERS.includes(slug)) {
        expect(cited, `${slug} now cites a source — remove it from UNCITED_ROSTERS`).toBe(false);
      } else {
        expect(cited, `${slug} (${facts.name}) has a roster with no source — add one`).toBe(true);
      }
    });

    const { aligned, outcomes } = generateTrackSegments(slug, facts);
    // Turns a game's centerline is permitted to miss entirely.
    const hints = loadDetectHints(slug);
    const optional = new Set(
      facts.corners.filter((c) => hints.get(c.number)?.optional).flatMap((c) => [c.number, ...(c.covers ?? [])]),
    );

    // A failed alignment produces no GameAlignment, so without this every
    // per-game assertion below would silently vanish instead of failing.
    test(`${slug}: every game centerline aligns`, () => {
      const games = [...new Set(findCenterlines(slug).map((c) => c.gameId))];
      const alignedGames = new Set(aligned.map((a) => a.gameId));
      // Sanctioned gaps stay asserted-broken, so a fixed centerline fails here
      // until its entry is removed.
      for (const g of games.filter((g) => KNOWN_ALIGNMENT_GAPS.has(`${slug}/${g}`))) {
        expect(alignedGames.has(g), `${slug}/${g} now aligns — drop it from KNOWN_ALIGNMENT_GAPS`).toBe(false);
      }
      const failed = games.filter((g) => !alignedGames.has(g) && !KNOWN_ALIGNMENT_GAPS.has(`${slug}/${g}`));
      const why = outcomes.filter((o) => !o.ok).map((o) => `${o.gameId}: ${o.detail}`);
      expect(failed, `${slug} (${facts.name}) failed to align — ${why.join(" | ")}`).toEqual([]);
      expect(games.length, `${slug}: no centerline found for any game`).toBeGreaterThan(0);
    });

    for (const a of aligned) {
      test(`${a.gameId}/${slug}: detects ${turnCount} official turns`, () => {
        const matched = new Set(a.corners.flatMap(turnNumbers));
        const missing: number[] = [];
        for (let n = 1; n <= turnCount; n++) {
          if (!matched.has(n) && !optional.has(n)) missing.push(n);
        }
        const extra = [...matched].filter((n) => n < 1 || n > turnCount);

        expect(
          missing,
          `${a.gameId}/${slug} (${facts.name}): official turns ${missing.join(", ")} not detected — ` +
            `real turn count is ${turnCount} per ${facts.source}. Check the SVG in ` +
            `test/e2e/output/track-segments; fix the detector or mark the turn optional in detect-hints.json if the game's centerline genuinely omits it.`,
        ).toEqual([]);
        expect(extra, `${a.gameId}/${slug}: aligned turn numbers outside 1..${turnCount}`).toEqual([]);
      });
    }
  }
});
