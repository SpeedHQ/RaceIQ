/**
 * Copies shared data and track registry assets directly into dist/data and preserves
 * other shared umbrella names beneath dist/data. Used by production builds so
 * compiled code sees the same logical data roots as source code.
 *
 * Also copies server/runtime/platform/credstore.ps1 next to the binary (dist/credstore.ps1):
 * server/runtime/platform/keystore.ts resolves it relative to process.execPath when compiled,
 * and it can't be embedded in the binary because PowerShell needs a real file
 * on disk for `-File`. This script is the one choke point every build path
 * (scripts/build/build.ts, scripts/build/build-installer.ts, release.yml) runs through.
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { assertTrackRegistryArtifactsCurrent } from "../../shared/racing/tracks/registry-source";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const DIST = path.resolve(ROOT, "dist", "data");

let count = 0;
const DATA_EXTENSIONS: Record<string, true> = { ".csv": true, ".json": true, ".sqlite": true, ".rqi": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true };
const isDataFile = (name: string) => DATA_EXTENSIONS[path.extname(name).toLowerCase()] === true;

const EXCLUDED_TRACK_REGISTRY_SOURCES: Record<string, true> = {
  [path.resolve(ROOT, "shared", "data", "tracks", "registry-source")]: true,
  [path.resolve(ROOT, "shared", "data", "tracks", "registry-report.json")]: true,
};
const EXCLUDED_TRACK_REGISTRY_DESTINATIONS = [
  path.resolve(DIST, "tracks", "registry-source"),
  path.resolve(DIST, "tracks", "registry-report.json"),
];

function copyFile(src: string, dest: string) {
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  count++;
}

function copyDir(srcDir: string, destDir: string, filter?: (name: string) => boolean) {
  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      if (EXCLUDED_TRACK_REGISTRY_SOURCES[path.resolve(srcPath)] === true) continue;

      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath, filter);
      } else if (!filter || filter(entry.name)) {
        copyFile(srcPath, destPath);
      }
    }
  } catch {}
}

assertTrackRegistryArtifactsCurrent();

// Remove stale excluded registry outputs before copying.
for (const destination of EXCLUDED_TRACK_REGISTRY_DESTINATIONS) {
  rmSync(destination, { recursive: true, force: true });
}

// Static data umbrella is the compiled data root; other shared umbrellas keep
// their names so game catalogs and generated telemetry remain addressable.
const sharedDir = path.join(ROOT, "shared");
copyDir(path.join(sharedDir, "data"), DIST, isDataFile);
for (const entry of readdirSync(sharedDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "data") continue;
  copyDir(path.join(sharedDir, entry.name), path.join(DIST, entry.name), isDataFile);
}

console.log(`Copied ${count} data files → ${DIST}`);

// Credential-store PowerShell helper — must sit next to the compiled binary
const credSrc = path.join(ROOT, "server", "runtime", "platform", "credstore.ps1");
const credDst = path.resolve(ROOT, "dist", "credstore.ps1");
mkdirSync(path.dirname(credDst), { recursive: true });
cpSync(credSrc, credDst);
console.log(`Copied credstore.ps1 → ${credDst}`);
