import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { dashboardAccessMarkerPath } from "@raceiq/backend-core/runtime/config/dashboard-access-state";
import { parseOptions } from "@raceiq/tooling-data/data/seed-db-options";

const options = parseOptions();
if (options.clean) {
  const databasePath = join(resolveDataDir(), process.env.RACEIQ_TEST_MODE === "1" ? "test.db" : "app.db");
  // Reset before importing anything that opens the database. Stop the server first.
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, dashboardAccessMarkerPath(databasePath)]) {
    rmSync(path, { force: true });
  }
  console.log("[DB Seed] Deleted database and dashboard authentication; dashboard access setup is required again.");
}

// Static import would open the database before the explicit reset above.
await import("./seed-db-runner");
