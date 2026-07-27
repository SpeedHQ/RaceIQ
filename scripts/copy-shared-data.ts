/**
 * Copies all data files (.csv, .json) from shared/ to dist/data/,
 * preserving directory structure. Used by the production build so
 * the compiled binary can find game data at runtime.
 *
 * Also copies server/credstore.ps1 next to the binary (dist/credstore.ps1):
 * server/keystore.ts resolves it relative to process.execPath when compiled,
 * and it can't be embedded in the binary because PowerShell needs a real file
 * on disk for `-File`. This script is the one choke point every build path
 * (scripts/build.ts, scripts/build-installer.ts, release.yml) runs through.
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

// Copy all data files (.csv, .json) from shared/ preserving directory structure
const sharedDir = path.join(ROOT, "shared");
copyDir(sharedDir, DIST, (name) => name.endsWith(".csv") || name.endsWith(".json"));

console.log(`Copied ${count} data files → ${DIST}`);

// Credential-store PowerShell helper — must sit next to the compiled binary
const credSrc = path.join(ROOT, "server", "credstore.ps1");
const credDst = path.resolve(ROOT, "dist", "credstore.ps1");
mkdirSync(path.dirname(credDst), { recursive: true });
cpSync(credSrc, credDst);
console.log(`Copied credstore.ps1 → ${credDst}`);
