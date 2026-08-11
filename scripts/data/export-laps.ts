#!/usr/bin/env bun
/**
 * Export laps to a zip file for transfer to another machine.
 *
 * Usage:
 *   bun run scripts/data/export-laps.ts                    # export all laps → laps-export.zip
 *   bun run scripts/data/export-laps.ts -- --ids 1,2,3     # export specific laps
 *   bun run scripts/data/export-laps.ts -- -o my-laps.zip  # custom output path
 */
import { buildLapsZip } from "../../server/laps/archive";
import { getLapsRaw } from "../../server/db/lap-read-queries";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);

let ids: number[] | undefined;
let output = resolve("laps-export.zip");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ids" && args[i + 1]) {
    ids = args[++i].split(",").map(Number).filter((n) => !Number.isNaN(n));
  } else if ((args[i] === "-o" || args[i] === "--output") && args[i + 1]) {
    output = resolve(args[++i]);
  }
}

console.log(ids ? `Exporting laps: ${ids.join(", ")}` : "Exporting all laps...");
try {
  const lapIds = ids ?? (await getLapsRaw()).map((lap) => lap.id);
  const zip = await buildLapsZip(lapIds);
  writeFileSync(output, zip.bytes);
  console.log(`Wrote ${(zip.bytes.length / 1024).toFixed(1)} KB → ${output}`);
} catch (e: unknown) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
