import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NamedSegment as LegacyNamedSegment } from "../../shared/racing/tracks/named-segments";

export interface LegacyGameBlock {
  sectors?: { s1End: number; s2End: number; source?: string };
  segments?: LegacyNamedSegment[];
}

export interface LegacyMeta {
  name: string;
  sectors?: { s1End: number; s2End: number; source?: string };
  segments?: LegacyNamedSegment[];
  games?: Record<string, LegacyGameBlock>;
}

/** Per-game blocks, falling back to the top-level list for single-source files. */
export function gameBlocks(
  meta: LegacyMeta,
): Record<string, { sectors?: LegacyMeta["sectors"]; segments: LegacyNamedSegment[] }> {
  const games = meta.games ?? {};
  const keys = Object.keys(games);
  if (keys.length > 0) {
    const out: Record<string, { sectors?: LegacyMeta["sectors"]; segments: LegacyNamedSegment[] }> = {};
    for (const g of keys) out[g] = { sectors: games[g].sectors ?? meta.sectors, segments: games[g].segments ?? [] };
    return out;
  }
  return {};
}

export function loadLegacyFiles(metaDir: string): Record<string, LegacyMeta> {
  const legacy: Record<string, LegacyMeta> = {};
  for (const file of readdirSync(metaDir).filter((name) => name.endsWith(".json"))) {
    legacy[file.replace(".json", "")] = JSON.parse(readFileSync(resolve(metaDir, file), "utf8"));
  }
  return legacy;
}

/** Fold layouts that share one physical circuit before deriving facts. */
export function mergeLegacyLayouts(
  legacy: Record<string, LegacyMeta>,
  merges: { from: string; to: string }[],
): string[] {
  const mergedAway: string[] = [];
  for (const { from, to } of merges) {
    if (!legacy[from] || !legacy[to]) {
      console.log(`  ! merge skipped, missing file: ${from} -> ${to}`);
      continue;
    }
    const fromBlocks = gameBlocks(legacy[from]);
    const toBlocks = gameBlocks(legacy[to]);
    for (const [gameId, block] of Object.entries(fromBlocks)) {
      if (toBlocks[gameId]) {
        console.log(`  ! ${to} already has ${gameId}; ${from} block dropped`);
        continue;
      }
      legacy[to].games = legacy[to].games ?? {};
      legacy[to].games![gameId] = { sectors: block.sectors, segments: block.segments };
    }
    mergedAway.push(from);
  }
  for (const slug of mergedAway) delete legacy[slug];
  return mergedAway;
}
