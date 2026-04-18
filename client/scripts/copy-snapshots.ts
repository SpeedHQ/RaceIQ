#!/usr/bin/env bun
/**
 * Copy Playwright-generated dashboard snapshots into the top-level
 * assets/screenshots/ directory so they can be embedded in the README
 * and Steam Community posts.
 *
 * Each `snapshot-<Name>.png` in src/stories/__snapshots__/ becomes
 * ../assets/screenshots/<Name>.png.
 */
import { readdirSync, copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const clientDir = dirname(fileURLToPath(import.meta.url)) + "/..";
const snapshotDir = join(clientDir, "src/stories/__snapshots__");
const destDir = join(clientDir, "../assets/screenshots");

if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

const prefix = "snapshot-";
const suffix = ".png";
const entries = readdirSync(snapshotDir).filter(
  (f) => f.startsWith(prefix) && f.endsWith(suffix),
);

if (entries.length === 0) {
  console.error(`No snapshots found in ${snapshotDir}`);
  process.exit(1);
}

for (const file of entries) {
  const name = file.slice(prefix.length); // drop "snapshot-" prefix → "Name.png"
  copyFileSync(join(snapshotDir, file), join(destDir, name));
  console.log(`copied ${file} → assets/screenshots/${name}`);
}
