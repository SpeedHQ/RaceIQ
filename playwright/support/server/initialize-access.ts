import { initDb, DB_PATH, client } from "@raceiq/backend-core/db/index";
import { DashboardAuth } from "../../../apps/backend/src/runtime/dashboard-auth";

// Explicit fixture choices, rather than a production authentication bypass.
if (!process.env.DATA_DIR?.split(/[\\/]+/).some((part) => part.includes("test-data"))) throw new Error("Access fixtures require an isolated test-data directory");
await initDb();
try {
  const auth = await DashboardAuth.create(client, DB_PATH);
  await auth.initialize(false);
  if (process.env.PW_ACCESS_MODE === "disabled") await auth.setup(null, true);
} finally {
  client.close();
}
