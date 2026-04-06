#!/usr/bin/env bun
/**
 * Import laps from a zip file exported by export-laps.
 *
 * Usage:
 *   bun run laps:import data/laps-export.zip
 */
import { importLapsZip } from "../server/zip";
import { readFileSync } from "fs";
import { resolve } from "path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: bun run laps:import <path-to-zip>");
  process.exit(1);
}

const zipPath = resolve(input);
console.log(`Importing from ${zipPath}...`);

try {
  const zipData = new Uint8Array(readFileSync(zipPath));
  const { imported, skipped } = await importLapsZip(zipData);
  console.log(`Done: ${imported} laps imported, ${skipped} skipped`);
} catch (e: any) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
