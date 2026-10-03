import { ROOT_DIR } from "../root";
import { KNOWN_GAME_IDS } from "@raceiq/shared/games/ids";
/**
 * Copies shared/data CSV/JSON/SVG contents directly into dist/data and preserves
 * other shared umbrella names beneath dist/data. Used by production builds so
 * compiled code sees the same logical data roots as source code.
 *
 * Also copies server/runtime/platform/credstore.ps1 next to the binary (dist/credstore.ps1):
 * server/runtime/platform/keystore.ts resolves it relative to process.execPath when compiled,
 * and it can't be embedded in the binary because PowerShell needs a real file
 * on disk for `-File`. This script is the one choke point every build path
 * (packages/tooling-build/src/build/build.ts, build-installer.ts, release.yml) runs through.
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = ROOT_DIR;
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

// Static data umbrella is the compiled data root; other shared umbrellas keep
// their names so game catalogs and generated telemetry remain addressable.
const sharedDir = path.join(ROOT, "shared");
copyDir(path.join(sharedDir, "data"), DIST, (name) => /\.(?:csv|json|svg)$/.test(name));
for (const entry of readdirSync(sharedDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "data") continue;
  copyDir(
    path.join(sharedDir, entry.name),
    path.join(DIST, entry.name),
    (name) => /\.(?:csv|json|svg)$/.test(name),
  );
}

// Metadata catalogs and game assets share the original compiled game-ID layout.
for (const gameId of KNOWN_GAME_IDS) {
  const gameDist = path.join(DIST, "games", gameId);
  copyDir(
    path.join(ROOT, "packages", `game-${gameId}-metadata`, "src"),
    gameDist,
    (name) => /\.(?:csv|json|svg)$/.test(name),
  );
  const assets = path.join(ROOT, "packages", `game-${gameId}`, "assets");
  let assetEntries;
  try {
    assetEntries = readdirSync(assets, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw error;
  }
  for (const asset of assetEntries) {
    if (asset.name === "public") continue; // Vite owns URL-addressed client assets.
    const src = path.join(assets, asset.name);
    const dest = path.join(gameDist, asset.name);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
}

console.log(`Copied ${count} data files → ${DIST}`);

// Credential-store PowerShell helper — must sit next to the compiled binary
const credSrc = path.join(ROOT, "server", "runtime", "platform", "credstore.ps1");
const credDst = path.resolve(ROOT, "dist", "credstore.ps1");
mkdirSync(path.dirname(credDst), { recursive: true });
cpSync(credSrc, credDst);
console.log(`Copied credstore.ps1 → ${credDst}`);
