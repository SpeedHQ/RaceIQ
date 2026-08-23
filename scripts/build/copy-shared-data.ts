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
const DATA_EXTENSIONS: Record<string, true> = { ".csv": true, ".json": true, ".sqlite": true, ".rqi": true, ".svg": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true };
const isDataFile = (name: string) => DATA_EXTENSIONS[path.extname(name).toLowerCase()] === true;

const TRACKS_SOURCE = path.resolve(ROOT, "shared", "data", "tracks");
const TRACKS_DESTINATION = path.resolve(DIST, "tracks");

function isTrackRegistryMetadata(candidate: string, tracksRoot: string): boolean {
  const relative = path.relative(tracksRoot, path.resolve(candidate));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;

  const filename = path.basename(relative);
  if (relative === "registry-report.json") return true;
  if (relative === "registry-source" || relative.startsWith(`registry-source${path.sep}`)) return true;
  if (!relative.startsWith(`venues${path.sep}`)) return false;
  return filename === "venue.json"
    || filename === "revision.json"
    || filename === "metadata.json"
    || filename === "detect-hints.json";
}

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
      if (isTrackRegistryMetadata(srcPath, TRACKS_SOURCE)) continue;

      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath, filter);
      } else if (!filter || filter(entry.name)) {
        copyFile(srcPath, destPath);
      }
    }
  } catch {}
}

function removeTrackRegistryMetadata(root: string): void {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      if (isTrackRegistryMetadata(candidate, TRACKS_DESTINATION)) {
        rmSync(candidate, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        removeTrackRegistryMetadata(candidate);
      }
    }
  } catch {}
}
function removeRetiredMapDirectories(root: string): void {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (entry.name === "maps") rmSync(candidate, { recursive: true, force: true });
      else removeRetiredMapDirectories(candidate);
    }
  } catch {}
}

function removeLegacyDirectTrackDirectories(root: string): void {
  const venuesRoot = path.resolve(root, "venues");
  function removeBeforeRevision(directory: string): void {
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "revisions") continue;
        const candidate = path.resolve(directory, entry.name);
        if (entry.name === "tracks") rmSync(candidate, { recursive: true, force: true });
        else removeBeforeRevision(candidate);
      }
    } catch {}
  }
  removeBeforeRevision(venuesRoot);
}


assertTrackRegistryArtifactsCurrent();

// Remove stale canonical metadata and report files while preserving colocated assets.
removeTrackRegistryMetadata(TRACKS_DESTINATION);
removeRetiredMapDirectories(TRACKS_DESTINATION);
removeLegacyDirectTrackDirectories(TRACKS_DESTINATION);
rmSync(path.resolve(TRACKS_DESTINATION, "guides"), { recursive: true, force: true });
for (const retiredDirectory of ["ac-evo", "acc", "f1-2025", "fm-2023", "tumftm"]) {
  rmSync(path.resolve(TRACKS_DESTINATION, retiredDirectory), { recursive: true, force: true });
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
