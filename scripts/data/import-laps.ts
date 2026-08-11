#!/usr/bin/env bun
/**
 * Import laps from a zip file exported by export-laps.
 *
 * Usage:
 *   bun run scripts/data/import-laps.ts <path-to-zip>
 */
import { importLapsZip } from "../../server/laps/archive"
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: bun run scripts/data/import-laps.ts <path-to-zip>");
  process.exit(1);
}

const zipPath = resolve(input);
console.log(`Importing from ${zipPath}...`);

try {
  const zipData = new Uint8Array(readFileSync(zipPath));
  const { imported, skipped } = await importLapsZip(zipData);
  console.log(`Done: ${imported} laps imported, ${skipped} skipped`);
} catch (e: unknown) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
