/**
 * The curation-coverage tables in docs/contributing/track-curation.md are a committed
 * statistic. Curating a track (or adding a game's centerlines) changes them, so
 * this test fails until `bun run tracks:coverage --write` is run.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { curatedCoverage, renderCoverageTable, renderDetailTables } from "../shared/racing/tracks/curation/coverage";
import { fileHash, loadVerified, verifiedKey, verifyState } from "../shared/racing/tracks/curation/verified";
import type { GameId } from "../shared/games/ids";
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

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Split a ledger key back into the (kind, slug, gameId) it was built from. */
function keyParts(key: string): { kind: "meta" | "segments"; slug: string; gameId?: GameId } {
  const [, , , dir = "", file = ""] = key.split("/");
  return dir === "meta"
    ? { kind: "meta", slug: file.replace(/\.json$/, "") }
    : { kind: "segments", slug: file.replace(/-segments\.json$/, ""), gameId: dir as GameId };
}

describe("track curation coverage", () => {
  const doc = readFileSync(CURATION_DOC, "utf8");

  test("docs/contributing/track-curation.md has the generated-block markers", () => {
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
    expect(claudeMd).toContain("docs/contributing/track-curation.md");
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
    for (const key of Object.keys(ledger)) {
      expect(existsSync(resolve(REPO_ROOT, key)), `${key} signed but the file is gone`).toBe(true);
    }
  });

  test("keys are repo-relative paths under shared/data/tracks", () => {
    for (const key of Object.keys(ledger)) {
      expect(key, `${key} is not a shared/data/tracks path`).toMatch(/^shared\/data\/tracks\/[\w-]+\/[\w-]+\.json$/);
    }
  });

  test("a stamped hash matches the file, otherwise the entry reads stale", () => {
    for (const [key, entry] of Object.entries(ledger)) {
      const live = fileHash(resolve(REPO_ROOT, key));
      const { kind, slug, gameId } = keyParts(key);
      expect(verifyState(ledger, kind, slug, gameId)).toBe(entry.hash === live ? "verified" : "stale");
    }
  });

  test("signatures are dated and attributed", () => {
    for (const entry of Object.values(ledger)) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.hash).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  test("editing a signed file makes it stale rather than silently verified", () => {
    const key = Object.keys(ledger)[0];
    if (!key) return;
    const tampered = { ...ledger, [key]: { ...ledger[key]!, hash: "0".repeat(12) } };
    const { kind, slug, gameId } = keyParts(key);
    expect(verifyState(tampered, kind, slug, gameId)).toBe("stale");
  });

  test("a key round-trips through verifiedKey()", () => {
    for (const key of Object.keys(ledger)) {
      const { kind, slug, gameId } = keyParts(key);
      expect(verifiedKey(kind, slug, gameId)).toBe(key);
    }
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
