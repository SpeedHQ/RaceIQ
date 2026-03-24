/**
 * Copies shared data files to dist/ organized by type:
 *   dist/data/cars/     — cars.csv, car-specs.csv
 *   dist/data/tracks/   — tracks.csv, outlines/, boundaries/
 *   dist/data/tunes/    — (placeholder for future tune data)
 */
import { cpSync, mkdirSync, readdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const DIST = path.resolve(ROOT, "dist", "data");

let count = 0;

function copyFile(src: string, dest: string) {
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  count++;
}

function copyDir(srcDir: string, destDir: string, filter?: (name: string) => boolean) {
  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        copyDir(path.join(srcDir, entry.name), path.join(destDir, entry.name), filter);
      } else if (!filter || filter(entry.name)) {
        copyFile(path.join(srcDir, entry.name), path.join(destDir, entry.name));
      }
    }
  } catch {}
}

// Cars
copyFile(path.join(ROOT, "shared", "cars.csv"), path.join(DIST, "cars", "cars.csv"));
copyFile(path.join(ROOT, "shared", "car-specs.csv"), path.join(DIST, "cars", "car-specs.csv"));

// Tracks
copyFile(path.join(ROOT, "shared", "tracks.csv"), path.join(DIST, "tracks", "tracks.csv"));

// Track outlines (CSVs and JSONs)
const outlinesDir = path.join(ROOT, "shared", "track-outlines");
copyDir(outlinesDir, path.join(DIST, "tracks", "outlines"), (name) =>
  name.endsWith(".csv") || name.endsWith(".json")
);

// Track boundaries
const boundariesDir = path.join(ROOT, "shared", "track-outlines", "boundaries");
copyDir(boundariesDir, path.join(DIST, "tracks", "outlines", "boundaries"));

// Tunes
copyDir(path.join(ROOT, "shared", "tunes"), path.join(DIST, "tunes"), (name) =>
  name.endsWith(".json")
);

console.log(`Copied ${count} data files → ${DIST}`);
