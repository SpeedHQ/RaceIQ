/**
 * CLI for the track segment generator — core logic lives in
 * shared/racing/tracks/curation/generate.ts (shared with the test suite, so tests run
 * the exact code path that produces committed meta).
 *
 * Usage:
 *   bun run tracks:segments --track spa            # dry-run one track
 *   bun run tracks:segments --all                  # dry-run everything
 *   bun run tracks:segments --track spa --write    # persist to meta
 *   bun run tracks:segments --track spa --game f1-2025
 *   --allow-fuzzy   also write when alignment cost >= 1 (soft mismatches)
 *   --verbose       print detected corner tables for failed alignments
 */

import { detectCornerRegions, type CornerRegion } from "../../shared/racing/tracks/curation/segment-align-detect";
import {
  findCenterlines,
  generateTrackSegments,
  listCuratedSlugs,
  loadCenterline,
  writeTrackMeta,
} from "../../shared/racing/tracks/curation/generate";
import { loadTrackFacts } from "../../shared/racing/tracks/storage/meta";

interface Args {
  track?: string;
  game?: string;
  all: boolean;
  write: boolean;
  allowFuzzy: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, write: false, allowFuzzy: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--track") args.track = argv[++i];
    else if (a === "--game") args.game = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--write") args.write = true;
    else if (a === "--allow-fuzzy") args.allowFuzzy = true;
    else if (a === "--verbose") args.verbose = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printTable(corners: CornerRegion[]): void {
  console.log(`    idx | dir   | frac          | length | radius`);
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    const radius = c.peakKappa > 0 ? (1 / c.peakKappa).toFixed(0) : "-";
    console.log(
      `    ${String(i).padStart(3)} | ${c.direction.padEnd(5)} | ${c.startFrac.toFixed(3)}-${c.endFrac.toFixed(3)} | ${c.lengthM.toFixed(0).padStart(4)} m | ${radius} m`,
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.track && !args.all) {
    console.error("Usage: generate-track-segments.ts (--track <slug> | --all) [--game <id>] [--write] [--allow-fuzzy] [--verbose]");
    process.exit(2);
  }

  const slugs = args.track ? [args.track] : listCuratedSlugs();

  let failures = 0;
  for (const slug of slugs) {
    const facts = loadTrackFacts(slug);
    if (!facts) {
      console.error(`[${slug}] no facts rows in track registry`);
      failures++;
      continue;
    }
    const { outcomes, aligned } = generateTrackSegments(slug, facts, args.game);

    if (args.verbose) {
      for (const o of outcomes) {
        if (o.ok) continue;
        const cl = findCenterlines(slug, o.gameId === "-" ? undefined : o.gameId);
        for (const { file } of cl) {
          const outline = loadCenterline(file);
          if (!outline) continue;
          console.log(`  [${slug} / ${o.gameId}] detected corner regions:`);
          printTable(detectCornerRegions(outline).corners);
        }
      }
    }

    const wroteGames = args.write ? writeTrackMeta(slug, facts, aligned, args.allowFuzzy) : [];
    for (const o of outcomes) {
      const wrote = wroteGames.includes(o.gameId);
      const status = o.ok ? (wrote ? "WROTE" : o.cost < 1 ? "OK   " : "FUZZY") : "FAIL ";
      console.log(`[${status}] ${o.slug} / ${o.gameId}: ${o.detail}`);
      if (!o.ok) failures++;
    }
  }

  if (!args.write) console.log("\n(dry run — pass --write to persist facts + per-game geometry)");
  process.exit(failures > 0 ? 1 : 0);
}

main();
