import { createClient } from "@libsql/client/sqlite3";
import { bootstrap, runMigrations } from "@raceiq/backend-core/test-support/db/migrations";
import type { ClassificationMigrationStatus } from "@raceiq/shared/racing/laps/classification-migration";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startUpgradeServer } from "./upgrade-server";

export async function status(address: string): Promise<ClassificationMigrationStatus> {
  const response = await fetch(`${address}/api/sessions/classification-migration-status`);
  if (!response.ok) throw new Error(`Migration status ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function openUpgrade(dataDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const server = startUpgradeServer(dataDir, extraEnv);
  try {
    const address = await server.address();
    const access = await fetch(`${address}/api/auth/status`).then((response) => response.json()) as { pending: boolean };
    if (access.pending) {
      const response = await fetch(`${address}/api/auth/setup`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: address },
        body: JSON.stringify({ password: null, exposureConfirmed: true }),
      });
      if (!response.ok) throw new Error(`Access setup ${response.status}: ${await response.text()}`);
    }
    return { server, address };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

export async function settled(address: string, waitForAggregates = true) {
  const deadline = Date.now() + 180_000;
  let snapshot = await status(address);
  // The production server runs in another process; fake clocks cannot advance its worker.
  while (snapshot.total === 0 || snapshot.pending > 0 || snapshot.running > 0 ||
    (waitForAggregates && snapshot.status === "running")) {
    if (Date.now() >= deadline) throw new Error(`Migration did not settle: ${JSON.stringify(snapshot)}`);
    await Bun.sleep(50);
    snapshot = await status(address);
  }
  return snapshot;
}

export async function prepareCurrentSchema(dataDir: string): Promise<void> {
  const client = createClient({ url: pathToFileURL(join(dataDir, "app.db")).href });
  try {
    await bootstrap(client);
    await runMigrations(client);
  } finally {
    client.close();
  }
}
