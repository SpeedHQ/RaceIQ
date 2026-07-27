/**
 * The curation-coverage table in CLAUDE.md is a committed statistic. Curating a
 * track (or adding a game's centerlines) changes it, so this test fails until
 * `bun run tracks:coverage --write` is run.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { curatedCoverage, renderCoverageTable } from "../shared/track-coverage";
import { fileHash, loadVerified, verifiableFile, verifyState } from "../shared/track-verified";
import {
  CLAUDE_MD,
  COVERAGE_END,
  COVERAGE_START,
  parseVerifyTarget,
  spliceCoverage,
} from "../scripts/track-coverage";

describe("track curation coverage", () => {
  const md = readFileSync(CLAUDE_MD, "utf8");

  test("CLAUDE.md has the coverage markers", () => {
    expect(md).toContain(COVERAGE_START);
    expect(md).toContain(COVERAGE_END);
  });

  test("committed table matches the repo — run `bun run tracks:coverage --write`", () => {
    expect(spliceCoverage(md, renderCoverageTable())).toBe(md);
  });

  test("every game reports a non-empty roster count", () => {
    const rows = curatedCoverage();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.total, `${r.gameId} ships no centerlines`).toBeGreaterThan(0);
      expect(r.curated, `${r.gameId} has no curated rosters`).toBeGreaterThan(0);
      expect(r.curated).toBeLessThanOrEqual(r.total);
      expect(r.uncurated.length).toBe(r.total - r.curated);
    }
  });

  test("verified counts never exceed what the game ships", () => {
    for (const r of curatedCoverage()) {
      expect(r.metaVerified + r.metaStale, `${r.gameId} meta`).toBeLessThanOrEqual(r.total);
      expect(r.segmentsVerified + r.segmentsStale, `${r.gameId} segments`).toBeLessThanOrEqual(r.total);
      // Verification is a claim about curated data — you cannot sign off a roster
      // that was never hand-authored.
      expect(r.metaVerified, `${r.gameId} verified more rosters than it curates`).toBeLessThanOrEqual(r.curated);
    }
  });
});

describe("verification ledger", () => {
  const ledger = loadVerified();

  test("every signature points at a file that still exists", () => {
    for (const slug of Object.keys(ledger.meta)) {
      expect(verifiableFile("meta", slug), `meta:${slug} signed but the roster is gone`).not.toBeNull();
    }
    for (const [gameId, byGame] of Object.entries(ledger.segments)) {
      for (const slug of Object.keys(byGame ?? {})) {
        expect(
          verifiableFile("segments", slug, gameId as never),
          `segments:${gameId}/${slug} signed but the geometry is gone`,
        ).not.toBeNull();
      }
    }
  });

  test("a stamped hash matches the file, otherwise the entry reads stale", () => {
    for (const [slug, entry] of Object.entries(ledger.meta)) {
      const live = fileHash(verifiableFile("meta", slug));
      const state = verifyState(ledger, "meta", slug);
      expect(state).toBe(entry.hash === live ? "verified" : "stale");
    }
  });

  test("signatures are dated and attributed", () => {
    for (const entry of Object.values(ledger.meta)) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.hash).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  test("editing a signed file makes it stale rather than silently verified", () => {
    const signed = Object.keys(ledger.meta)[0];
    if (!signed) return;
    const tampered = { ...ledger, meta: { ...ledger.meta, [signed]: { ...ledger.meta[signed], hash: "0".repeat(12) } } };
    expect(verifyState(tampered, "meta", signed)).toBe("stale");
  });

  test("--verify target parsing", () => {
    expect(parseVerifyTarget("meta:spa")).toEqual({ kind: "meta", slug: "spa" });
    expect(parseVerifyTarget("segments:f1-2025/spa")).toEqual({
      kind: "segments",
      slug: "spa",
      gameId: "f1-2025" as never,
    });
    expect(() => parseVerifyTarget("spa")).toThrow();
    expect(() => parseVerifyTarget("segments:spa")).toThrow();
  });
});
