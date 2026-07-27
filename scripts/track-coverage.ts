/**
 * CLI for curation coverage — core logic lives in shared/track-coverage.ts.
 *
 * Usage:
 *   bun run tracks:coverage           # print the table
 *   bun run tracks:coverage --write   # refresh the table committed in CLAUDE.md
 *
 *   # sign off data you have actually checked against a real turn-by-turn guide
 *   bun run tracks:coverage --verify meta:spa --by "racingcircuits.info"
 *   bun run tracks:coverage --verify segments:f1-2025/spa --by "svg render"
 *
 * Run with --write after curating a track; test/track-coverage.test.ts fails if
 * CLAUDE.md drifts from the repo. --verify only ever records a human's word for
 * it: nothing in the pipeline may stamp the ledger on its own.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { curatedCoverage, renderCoverageTable } from "../shared/track-coverage";
import { stampVerified } from "../shared/track-verified";
import type { GameId } from "../shared/types";

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

export const CLAUDE_MD = resolve(import.meta.dir, "..", "CLAUDE.md");
export const COVERAGE_START = "<!-- track-coverage:start -->";
export const COVERAGE_END = "<!-- track-coverage:end -->";

/** Replace the block between the coverage markers. Throws if they're missing. */
export function spliceCoverage(md: string, table: string): string {
  const start = md.indexOf(COVERAGE_START);
  const end = md.indexOf(COVERAGE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`CLAUDE.md is missing the ${COVERAGE_START} / ${COVERAGE_END} markers`);
  }
  return `${md.slice(0, start)}${COVERAGE_START}\n${table}\n${md.slice(end)}`;
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
    const md = readFileSync(CLAUDE_MD, "utf8");
    const next = spliceCoverage(md, table);
    if (next === md) console.log("\nCLAUDE.md already up to date.");
    else {
      writeFileSync(CLAUDE_MD, next);
      console.log("\nCLAUDE.md coverage table updated.");
    }
  }
}
