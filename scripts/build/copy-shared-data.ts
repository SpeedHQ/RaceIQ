/**
 * Copies shared data required at runtime directly into dist/data and preserves
 * other shared umbrella names beneath dist/data. Used by production builds so
 * compiled code sees the same logical data roots as source code.
 *
 * Also copies server/runtime/platform/credstore.ps1 next to the binary (dist/credstore.ps1):
 * server/runtime/platform/keystore.ts resolves it relative to process.execPath when compiled,
 * and it can't be embedded in the binary because PowerShell needs a real file
 * on disk for `-File`. This script is the one choke point every build path
 * (scripts/build/build.ts, scripts/build/build-installer.ts, release.yml) runs through.
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const DIST = path.resolve(ROOT, "dist", "data");

let count = 0;

function copyFile(src: string, dest: string) {
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  count++;
}

function copyDir(srcDir: string, destDir: string, filter?: (sourcePath: string) => boolean) {
  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        copyDir(sourcePath, path.join(destDir, entry.name), filter);
      } else if (!filter || filter(sourcePath)) {
        copyFile(sourcePath, path.join(destDir, entry.name));
      }
    }
  } catch {}
}

// Static data umbrella is compiled data root. Track packaging is path-aware:
// generated registry plus canonical geometry, imagery, and guides only.
const sharedDir = path.join(ROOT, "shared");
const staticDataRoot = path.join(sharedDir, "data");
copyDir(staticDataRoot, DIST, (sourcePath) => {
  const components = path.relative(staticDataRoot, sourcePath).split(path.sep);
  if (components[0] !== "tracks") return sourcePath.endsWith(".csv") || sourcePath.endsWith(".json");
  if (components.length === 2 && components[1] === "registry.json") return true;
  if (components[1] !== "venues") return false;
  return components.includes("geometry") || components.includes("imagery") || components.at(-1) === "guide.json";
});
for (const entry of readdirSync(sharedDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "data") continue;
  copyDir(path.join(sharedDir, entry.name), path.join(DIST, entry.name), (sourcePath) => sourcePath.endsWith(".csv") || sourcePath.endsWith(".json"));
}

console.log(`Copied ${count} data files → ${DIST}`);

// Credential-store PowerShell helper — must sit next to the compiled binary
const credSrc = path.join(ROOT, "server", "runtime", "platform", "credstore.ps1");
const credDst = path.resolve(ROOT, "dist", "credstore.ps1");
mkdirSync(path.dirname(credDst), { recursive: true });
cpSync(credSrc, credDst);
console.log(`Copied credstore.ps1 → ${credDst}`);
