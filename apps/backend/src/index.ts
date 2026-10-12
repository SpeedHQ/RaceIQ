process.title = "RaceIQ";

import { captureConsole } from "@raceiq/backend-core/runtime/logger";
import { bootServer } from "./runtime/boot";
import { resetDashboardPassword } from "./runtime/auth-cli";

captureConsole();
if (process.argv.slice(2)[0] === "auth") {
  await resetDashboardPassword(process.argv.slice(2));
  process.exit(0);
} else {
  await bootServer();
}
