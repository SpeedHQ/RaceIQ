/**
 * The curation-coverage tables in docs/track-curation.md are a committed
 * statistic. Curating a track (or adding a game's centerlines) changes them, so
 * this test fails until `bun run tracks:coverage --write` is run.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { curatedCoverage, renderCoverageTable, renderDetailTables } from "../shared/track-coverage";
import { fileHash, loadVerified, verifiableFile, verifyState } from "../shared/track-verified";
import {
  COVERAGE_END,
  COVERAGE_START,
  CURATION_DOC,
  DETAIL_END,
  DETAIL_START,
  parseVerifyTarget,
  spliceCoverage,
  spliceDetail,
} from "../scripts/track-coverage";

describe("track curation coverage", () => {
  const doc = readFileSync(CURATION_DOC, "utf8");

  test("docs/track-curation.md has the generated-block markers", () => {
    expect(doc).toContain(COVERAGE_START);
    expect(doc).toContain(COVERAGE_END);
    expect(doc).toContain(DETAIL_START);
    expect(doc).toContain(DETAIL_END);
  });

  test("committed summary matches the repo — run `bun run tracks:coverage --write`", () => {
    expect(spliceCoverage(doc, renderCoverageTable())).toBe(doc);
  });

  test("committed detail tables match the repo — run `bun run tracks:coverage --write`", () => {
    expect(spliceDetail(doc, renderDetailTables())).toBe(doc);
  });

  test("CLAUDE.md keeps no coverage numbers of its own", () => {
    const claudeMd = readFileSync(resolve(import.meta.dir, "..", "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain(COVERAGE_START);
    expect(claudeMd).toContain("docs/track-curation.md");
  });

  test("detail rows account for every track the summary counts", () => {
    for (const r of curatedCoverage()) {
      expect(r.tracks.length, `${r.gameId} detail rows`).toBe(r.total);
      expect(r.tracks.filter((t) => t.curated).length).toBe(r.curated);
      expect(r.tracks.filter((t) => t.meta === "verified").length).toBe(r.metaVerified);
      expect(r.tracks.filter((t) => t.segments === "verified").length).toBe(r.segmentsVerified);
      // a slug can never be verified without a roster to verify
      for (const t of r.tracks) {
        if (t.meta !== "unverified") expect(t.curated, `${t.slug} signed off but uncurated`).toBe(true);
      }
    }
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
