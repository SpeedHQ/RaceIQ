#!/usr/bin/env bun
/**
 * Import laps from a zip file exported by export-laps.
 *
 * Usage:
 *   bun run apps/backend/scripts/data/import-laps.ts <path-to-zip>
 */
import { importLapsZip } from "../../src/laps/archive";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { client, initDb } from "@raceiq/backend-core/db/index";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { initMotecTargets } from "../../src/games/motec-init";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { notifyDriverProfileLap } from "../../src/driver-profile/runner";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";

initGameAdapters(developmentReleaseFeatures);
initServerGameAdapters(developmentReleaseFeatures);
initMotecTargets();
registerDriverProfileLapNotifier(notifyDriverProfileLap);

const input = process.argv[2];
if (!input) {
  console.error("Usage: bun run apps/backend/scripts/data/import-laps.ts <path-to-zip>");
  process.exit(1);
}

const zipPath = resolve(input);
console.log(`Importing from ${zipPath}...`);

let exitCode = 0;
try {
  await initDb();
  const zipData = new Uint8Array(readFileSync(zipPath));
  const { imported, skipped, errors } = await importLapsZip(zipData);
  for (const error of errors) console.error(`Error: ${error}`);
  console.log(`Done: ${imported} laps imported, ${skipped} skipped`);
  if (skipped > 0 || errors.length > 0 || imported === 0) exitCode = 1;
} catch (e: unknown) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  exitCode = 1;
} finally {
  stopMaintenanceTasks();
  client.close();
}
process.exitCode = exitCode;
