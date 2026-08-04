/**
 * Extract ACC track geometry from game fastlane.ai files for ALL tracks.
 *
 * Reads each track's fastlane.ai from the ACC Cache directory, parses the
 * binary racing line and width data, and outputs centerline CSV + boundaries JSON.
 *
 * Usage: bun scripts/games/acc/extract-tracks.ts
 */

import { resolve } from "path";
import { extractAccTracks } from "../../../server/games/acc/extract-tracks";

const OUT_DIR = resolve(import.meta.dir, "../../..", "shared", "data", "tracks", "acc");

async function main(): Promise<void> {
  await extractAccTracks(OUT_DIR, (event) => {
    if (event.type === "total") {
      console.log(`[ACC] Found ${event.count} track directories`);
    } else if (event.type === "extracted") {
      console.log(`[ACC] Extracted ${event.count} tracks so far...`);
    }
  }).then(({ extracted }) => {
    console.log(`\n[ACC] Done — extracted ${extracted} tracks to ${OUT_DIR}`);
    process.exit(0);
  }).catch((err) => {
    console.error(`[ACC] Fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}

if (import.meta.main) main();
