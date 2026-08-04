import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TrackFacts } from "../../shared/racing/tracks/facts";
import type { TrackGeometry } from "../../shared/racing/tracks/geometry";

export interface BuiltLayout {
  slug: string;
  facts: TrackFacts;
  geometry: Record<string, TrackGeometry>;
}

export function writeMigrationOutputs(
  built: BuiltLayout[],
  metaDir: string,
  tracksDir: string,
): { wroteFacts: number; wroteGeom: number } {
  let wroteFacts = 0;
  let wroteGeom = 0;
  for (const { slug, facts, geometry } of built) {
    writeFileSync(resolve(metaDir, `${slug}.json`), `${JSON.stringify(facts, null, 2)}\n`);
    wroteFacts++;
    for (const [gameId, geom] of Object.entries(geometry)) {
      const dir = resolve(tracksDir, gameId);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${slug}-segments.json`), `${JSON.stringify(geom, null, 2)}\n`);
      wroteGeom++;
    }
  }
  return { wroteFacts, wroteGeom };
}

export function removeMergedLegacyFiles(mergedAway: string[], metaDir: string): void {
  for (const slug of mergedAway) {
    const path = resolve(metaDir, `${slug}.json`);
    if (existsSync(path)) rmSync(path);
  }
}

