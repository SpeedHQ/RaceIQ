process.title = "RaceIQ";

import { captureConsole } from "@raceiq/backend-core/runtime/logger";
import { client } from "@raceiq/backend-core/db/index";
import { bootServer } from "./runtime/boot";
import { resetDashboardPassword } from "./runtime/auth-cli";

captureConsole();
if (process.argv.slice(2)[0] === "auth") {
  try {
    await resetDashboardPassword(process.argv.slice(2));
  } finally {
    client.close();
  }
  process.exit(0);
} else {
  await bootServer();
}
