/**
 * One-shot migration: legacy per-game track meta -> facts + per-game geometry.
 *
 * Default is dry-run: reports writes and unresolved conflicts, touching nothing.
 * Pass --write to persist.
 *
 * Usage:
 *   bun run scripts/tracks/migrate-track-meta.ts                 # dry-run
 *   bun run scripts/tracks/migrate-track-meta.ts --track spa     # one layout
 *   bun run scripts/tracks/migrate-track-meta.ts --write
 */
import { resolve } from "node:path";
import { SHARED_DIR } from "../../shared/platform/runtime/data-paths";
import { gameBlocks, loadLegacyFiles, mergeLegacyLayouts } from "./migrate-track-meta-input";
import { MERGES, buildIdentityMap, type LayoutIdentity } from "./migrate-track-meta-identity";
import { applyVenueNames, buildLayout, type Conflict } from "./migrate-track-meta-layout";
import { removeMergedLegacyFiles, writeMigrationOutputs, type BuiltLayout } from "./migrate-track-meta-files";

export { MERGES, buildIdentityMap } from "./migrate-track-meta-identity";
export { gameBlocks } from "./migrate-track-meta-input";
export { buildLayout } from "./migrate-track-meta-layout";
export type { Conflict } from "./migrate-track-meta-layout";
export type { LayoutIdentity } from "./migrate-track-meta-identity";
export type { LegacyMeta } from "./migrate-track-meta-input";

const META_DIR = resolve(SHARED_DIR, "tracks", "meta");
const TRACKS_DIR = resolve(SHARED_DIR, "tracks");

interface Args {
  track?: string;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--track") args.track = argv[++i];
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const legacy = loadLegacyFiles(META_DIR);
  const mergedAway = mergeLegacyLayouts(legacy, MERGES);
  const slugs = args.track ? [args.track].filter((slug) => legacy[slug]) : Object.keys(legacy).sort();
  if (slugs.length === 0) {
    console.error("no matching layout");
    process.exit(1);
  }

  const identityMap = buildIdentityMap(Object.fromEntries(MERGES.map(({ from, to }) => [from, to])));
  const allConflicts: Conflict[] = [];
  let dormant = 0;
  const built: BuiltLayout[] = [];

  for (const slug of slugs) {
    const meta = legacy[slug];
    const blocks = gameBlocks(meta);
    if (Object.keys(blocks).length === 0) dormant++;
    const identity: LayoutIdentity = identityMap[slug] ?? { track: slug, layout: "full", layoutName: "Full" };
    const { facts, geometry, conflicts } = buildLayout(slug, meta, blocks, identity);
    allConflicts.push(...conflicts);
    built.push({ slug, facts, geometry });
  }

  applyVenueNames(built.map(({ facts }) => facts));
  for (const { slug, facts, geometry } of built) {
    const games = Object.keys(geometry).join(", ");
    console.log(
      `[ok] ${slug}: "${facts.name}" [${facts.layoutName}] — ${facts.corners.length} corners, ` +
        `${facts.straights?.length ?? 0} named straights, games: ${games}`,
    );
  }

  let wroteFacts = 0;
  let wroteGeom = 0;
  if (args.write) {
    ({ wroteFacts, wroteGeom } = writeMigrationOutputs(built, META_DIR, TRACKS_DIR));
    removeMergedLegacyFiles(mergedAway, META_DIR);
  }

  console.log("");
  if (allConflicts.length) {
    console.log(`── ${allConflicts.length} unresolved conflict(s) ──`);
    for (const conflict of allConflicts) {
      console.log(`  ${conflict.slug} ${conflict.key} ${conflict.field}: ${conflict.values.map((value) => `"${value}"`).join(" vs ")}`);
    }
    console.log("");
  }
  console.log(
    `${slugs.length} layouts, ${dormant} dormant (no game maps to them), ` +
      `${mergedAway.length} merged away: ${mergedAway.join(", ")}`,
  );
  if (args.write) console.log(`wrote ${wroteFacts} facts files, ${wroteGeom} geometry files`);
  else console.log("(dry-run — pass --write to persist)");

  process.exit(allConflicts.length > 0 ? 1 : 0);
}

if (import.meta.main) main();
