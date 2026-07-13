/**
 * Generate named track segments + sector boundaries from static sources:
 *   - geometry: extracted game centerlines (shared/tracks/<game>/*-centerline.csv)
 *   - names/sectors: curated lists (shared/tracks/corner-names/<slug>.json)
 *
 * No telemetry involved. The curvature detector finds WHERE corners are; the
 * curated list says WHAT they're called; alignment refuses to write when the
 * two disagree (count/direction checksums).
 *
 * Usage:
 *   bun run scripts/generate-track-segments.ts --track spa            # dry-run one track
 *   bun run scripts/generate-track-segments.ts --all                  # dry-run everything
 *   bun run scripts/generate-track-segments.ts --track spa --write    # persist to meta
 *   bun run scripts/generate-track-segments.ts --track spa --game f1-2025
 *   --allow-fuzzy   also write when alignment cost > 0 (soft mismatches)
 *   --verbose       print full segment tables for failed alignments too
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, basename } from "path";
import {
  alignSegments,
  detectCornerRegions,
  resolveSectors,
  type CornerNameList,
  type CornerRegion,
} from "../shared/track-segment-align";
import {
  loadSharedTrackMeta,
  saveSharedTrackMeta,
  type SharedTrackMeta,
} from "../shared/track-data";
import { SHARED_DIR } from "../shared/resolve-data";

const CORNER_NAMES_DIR = resolve(SHARED_DIR, "tracks", "corner-names");
const GAME_DIRS: Record<string, string> = {
  "f1-2025": resolve(SHARED_DIR, "tracks", "f1-2025"),
  acc: resolve(SHARED_DIR, "tracks", "acc"),
  "fm-2023": resolve(SHARED_DIR, "tracks", "fm-2023"),
};
/** Preference order for the top-level (global) meta segments. */
const GLOBAL_PRIORITY = ["fm-2023", "f1-2025", "acc"];

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

function loadCenterline(filePath: string): { x: number; z: number }[] | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const pts = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
    return pts.length >= 20 ? pts : null;
  } catch {
    return null;
  }
}

/** Find centerline files for a slug per game. FM files embed the ordinal. */
function findCenterlines(slug: string, gameFilter?: string): { gameId: string; file: string }[] {
  const found: { gameId: string; file: string }[] = [];
  for (const [gameId, dir] of Object.entries(GAME_DIRS)) {
    if (gameFilter && gameId !== gameFilter) continue;
    if (!existsSync(dir)) continue;
    if (gameId === "fm-2023") {
      const re = new RegExp(`^${slug}-\\d+-centerline\\.csv$`);
      for (const f of readdirSync(dir)) {
        if (re.test(f)) found.push({ gameId, file: resolve(dir, f) });
      }
    } else {
      const f = resolve(dir, `${slug}-centerline.csv`);
      if (existsSync(f)) found.push({ gameId, file: f });
    }
  }
  return found;
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

interface TrackOutcome {
  slug: string;
  gameId: string;
  ok: boolean;
  cost: number;
  wrote: boolean;
  detail: string;
}

function processTrack(slug: string, nameList: CornerNameList, args: Args): TrackOutcome[] {
  const outcomes: TrackOutcome[] = [];
  const centerlines = findCenterlines(slug, args.game);
  if (centerlines.length === 0) {
    outcomes.push({ slug, gameId: "-", ok: false, cost: Infinity, wrote: false, detail: "no centerline found" });
    return outcomes;
  }

  // Per-game results that aligned — used to update meta at the end
  const aligned: {
    gameId: string;
    segments: SharedTrackMeta["segments"];
    sectors: { s1End: number; s2End: number; source: string } | null;
    cost: number;
  }[] = [];

  const seenGames = new Set<string>();
  for (const { gameId, file } of centerlines) {
    // FM can have several layout variants per slug — first aligned one wins
    if (seenGames.has(gameId)) continue;

    const outline = loadCenterline(file);
    if (!outline) {
      outcomes.push({ slug, gameId, ok: false, cost: Infinity, wrote: false, detail: `unreadable centerline ${basename(file)}` });
      continue;
    }
    const detection = detectCornerRegions(outline);
    const result = alignSegments(detection.corners, nameList);

    if (!result.ok) {
      outcomes.push({
        slug, gameId, ok: false, cost: result.cost, wrote: false,
        detail: result.issues.map((i) => i.message).join("; "),
      });
      if (args.verbose) {
        console.log(`  [${slug} / ${gameId}] detected corner regions (${basename(file)}):`);
        printTable(detection.corners);
      }
      continue;
    }

    let sectors: { s1End: number; s2End: number; source: string } | null = null;
    if (nameList.sectors) {
      const resolved = resolveSectors(nameList.sectors, result.corners, detection.totalDist);
      for (const issue of resolved.issues) {
        result.issues.push(issue);
      }
      sectors = resolved.sectors;
    }

    seenGames.add(gameId);
    aligned.push({ gameId, segments: result.segments, sectors, cost: result.cost });
    const warnings = result.issues.filter((i) => i.severity === "warning").map((i) => i.message);
    outcomes.push({
      slug, gameId, ok: true, cost: result.cost, wrote: false,
      detail: `${result.segments.length} segments, ${result.corners.length} corners`
        + (sectors ? `, sectors ${sectors.s1End}/${sectors.s2End} (${sectors.source})` : "")
        + (warnings.length ? ` — ${warnings.join("; ")}` : ""),
    });
  }

  const writable = aligned.filter((a) => a.cost < 1 || args.allowFuzzy);
  if (args.write && writable.length > 0) {
    const meta: SharedTrackMeta = loadSharedTrackMeta(slug) ?? { name: nameList.circuit };
    meta.name = meta.name || nameList.circuit;
    for (const a of writable) {
      meta.games = meta.games ?? {};
      meta.games[a.gameId] = meta.games[a.gameId] ?? {};
      meta.games[a.gameId].segments = a.segments;
      if (a.sectors) meta.games[a.gameId].sectors = a.sectors;
    }
    // Global segments/sectors from the highest-priority aligned game
    const globalSrc = GLOBAL_PRIORITY.map((g) => writable.find((a) => a.gameId === g)).find(Boolean);
    if (globalSrc) {
      meta.segments = globalSrc.segments;
      if (globalSrc.sectors) meta.sectors = globalSrc.sectors;
    }
    saveSharedTrackMeta(slug, meta);
    for (const o of outcomes) {
      if (o.ok && writable.some((a) => a.gameId === o.gameId)) o.wrote = true;
    }
  }

  return outcomes;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.track && !args.all) {
    console.error("Usage: generate-track-segments.ts (--track <slug> | --all) [--game <id>] [--write] [--allow-fuzzy] [--verbose]");
    process.exit(2);
  }

  const slugs = args.track
    ? [args.track]
    : readdirSync(CORNER_NAMES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();

  let failures = 0;
  for (const slug of slugs) {
    const nameListPath = resolve(CORNER_NAMES_DIR, `${slug}.json`);
    if (!existsSync(nameListPath)) {
      console.error(`[${slug}] no corner-name list at ${nameListPath}`);
      failures++;
      continue;
    }
    const nameList: CornerNameList = JSON.parse(readFileSync(nameListPath, "utf-8"));
    const outcomes = processTrack(slug, nameList, args);
    for (const o of outcomes) {
      const status = o.ok ? (o.wrote ? "WROTE" : o.cost < 1 ? "OK   " : "FUZZY") : "FAIL ";
      console.log(`[${status}] ${o.slug} / ${o.gameId}: ${o.detail}`);
      if (!o.ok) failures++;
    }
  }

  if (!args.write) console.log("\n(dry run — pass --write to persist to shared/tracks/meta)");
  process.exit(failures > 0 ? 1 : 0);
}

main();
