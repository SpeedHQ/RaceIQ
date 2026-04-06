#!/usr/bin/env bun
/**
 * Export laps to a zip file for transfer to another machine.
 *
 * Usage:
 *   bun run laps:export                    # export all laps → data/laps-export.zip
 *   bun run laps:export -- --ids 1,2,3     # export specific laps
 *   bun run laps:export -- -o my-laps.zip  # custom output path
 */
import { exportLapsZip } from "../server/zip";
import { writeFileSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);

let ids: number[] | undefined;
let output = resolve("laps-export.zip");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ids" && args[i + 1]) {
    ids = args[++i].split(",").map(Number).filter((n) => !isNaN(n));
  } else if ((args[i] === "-o" || args[i] === "--output") && args[i + 1]) {
    output = resolve(args[++i]);
  }
}

console.log(ids ? `Exporting laps: ${ids.join(", ")}` : "Exporting all laps...");

try {
  const zip = await exportLapsZip(ids);
  writeFileSync(output, zip);
  console.log(`Wrote ${(zip.length / 1024).toFixed(1)} KB → ${output}`);
} catch (e: any) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
