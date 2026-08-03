/**
 * CLI for curation coverage — core logic lives in shared/racing/tracks/curation/coverage.ts.
 *
 * Usage:
 *   bun run tracks:coverage           # print the table
 *   bun run tracks:coverage --write   # refresh tables in docs/contributing/track-curation.md
 *
 *   # sign off data you have actually checked against a real turn-by-turn guide
 *   bun run tracks:coverage --verify meta:spa --by "racingcircuits.info"
 *   bun run tracks:coverage --verify segments:f1-2025/spa --by "svg render"
 *
 * Run with --write after curating a track; test/track-coverage.test.ts fails if
 * docs/contributing/track-curation.md drifts from the repo. --verify only ever records a
 * human's word for it: nothing in the pipeline may stamp the ledger on its own.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { curatedCoverage, renderCoverageTable, renderDetailTables } from "../shared/racing/tracks/curation/coverage";
import { stampVerified } from "../shared/racing/tracks/curation/verified";
import type { GameId } from "../shared/games/ids";

/** `meta:spa` or `segments:f1-2025/spa`. */
export function parseVerifyTarget(spec: string): { kind: "meta" | "segments"; slug: string; gameId?: GameId } {
  const [kind, rest] = spec.split(":", 2);
  if ((kind !== "meta" && kind !== "segments") || !rest) {
    throw new Error(`bad --verify target "${spec}" — use meta:<slug> or segments:<gameId>/<slug>`);
  }
  if (kind === "meta") return { kind, slug: rest };
  const [gameId, slug] = rest.split("/", 2);
  if (!gameId || !slug) throw new Error(`bad --verify target "${spec}" — use segments:<gameId>/<slug>`);
  return { kind, slug, gameId: gameId as GameId };
}

export const CURATION_DOC = resolve(import.meta.dir, "..", "docs", "contributing", "track-curation.md");
export const COVERAGE_START = "<!-- track-coverage:start -->";
export const COVERAGE_END = "<!-- track-coverage:end -->";
export const DETAIL_START = "<!-- track-detail:start -->";
export const DETAIL_END = "<!-- track-detail:end -->";

/** Replace the block between a pair of markers. Throws if they're missing. */
export function spliceBlock(md: string, table: string, startMark: string, endMark: string): string {
  const start = md.indexOf(startMark);
  const end = md.indexOf(endMark);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`markdown is missing the ${startMark} / ${endMark} markers`);
  }
  const eol = md.startsWith("\r\n", start + startMark.length) ? "\r\n" : "\n";
  const normalizedTable = table.replace(/\r?\n/g, eol);
  return `${md.slice(0, start)}${startMark}${eol}${normalizedTable}${eol}${md.slice(end)}`;
}

/** Summary table block in docs/contributing/track-curation.md. */
export function spliceCoverage(md: string, table: string): string {
  return spliceBlock(md, table, COVERAGE_START, COVERAGE_END);
}

/** Per-game detail tables in docs/contributing/track-curation.md. */
export function spliceDetail(md: string, tables: string): string {
  return spliceBlock(md, tables, DETAIL_START, DETAIL_END);
}

if (import.meta.main) {
  const write = process.argv.includes("--write");

  const verifyIdx = process.argv.indexOf("--verify");
  if (verifyIdx !== -1) {
    const spec = process.argv[verifyIdx + 1];
    if (!spec) throw new Error("--verify needs a target, e.g. meta:spa or segments:f1-2025/spa");
    const byIdx = process.argv.indexOf("--by");
    const by = byIdx === -1 ? undefined : process.argv[byIdx + 1];
    const { kind, slug, gameId } = parseVerifyTarget(spec);
    const entry = stampVerified(kind, slug, { gameId, by });
    console.log(`verified ${spec} @ ${entry.hash} on ${entry.date}${entry.by ? ` (${entry.by})` : ""}\n`);
  }

  const rows = curatedCoverage();
  const table = renderCoverageTable(rows);
  console.log(table);
  for (const r of rows) {
    if (r.uncurated.length > 0) console.log(`\n${r.gameId} uncurated: ${r.uncurated.join(", ")}`);
  }
  if (write) {
    const refresh = (path: string, label: string, splice: (md: string) => string) => {
      const md = readFileSync(path, "utf8");
      const next = splice(md);
      if (next === md) console.log(`\n${label} already up to date.`);
      else {
        writeFileSync(path, next);
        console.log(`\n${label} updated.`);
      }
    };
    refresh(CURATION_DOC, "docs/contributing/track-curation.md", (md) =>
      spliceDetail(spliceCoverage(md, table), renderDetailTables(rows)),
    );
  }
}
