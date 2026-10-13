process.title = "RaceIQ";

import { captureConsole } from "@raceiq/backend-core/runtime/logger";
import { client } from "@raceiq/backend-core/db/index";
import { bootServer } from "./runtime/boot";
import { disableDashboardProtection, resetDashboardPassword } from "./runtime/auth-cli";

captureConsole();
if (process.argv.slice(2)[0] === "auth") {
  try {
    const args = process.argv.slice(2);
    if (args[1] === "disable") await disableDashboardProtection(args);
    else if (args[1] === "reset") await resetDashboardPassword(args);
    else throw new Error("Usage: raceiq auth reset | raceiq auth disable --confirm-exposure");
  } finally {
    client.close();
  }
  process.exit(0);
} else {
  await bootServer();
}
