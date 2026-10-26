process.title = "RaceIQ";

import { openDashboard } from "@raceiq/backend-core/runtime/desktop";
import { dispatchCloudLapImport } from "./routes/cloud-lap-import-routes";
import { forwardRaceIqActivation, isRaceIqImportActivation, parseRaceIqActivation, startRaceIqActivationBroker } from "./runtime/protocol-activation";
import { captureConsole } from "@raceiq/backend-core/runtime/logger";
import { closeDb } from "@raceiq/backend-core/db/index";
import { disableDashboardProtection, resetDashboardPassword } from "./runtime/auth-cli";
import { bootServer } from "./runtime/boot";

captureConsole();
if (process.argv.slice(2)[0] === "auth") {
  try {
    const args = process.argv.slice(2);
    if (args[1] === "disable") await disableDashboardProtection(args);
    else if (args[1] === "reset") await resetDashboardPassword(args);
    else throw new Error("Usage: raceiq auth reset | raceiq auth disable --confirm-exposure");
  } finally {
    closeDb();
  }
  process.exit(0);
} else {
  const args = process.argv.slice(2);
  const activation = args.map(parseRaceIqActivation).find((value) => value !== null) ?? null;
  if (activation && await forwardRaceIqActivation(activation)) process.exit(0);
  const { promise: serverReady, resolve: markReady } = Promise.withResolvers<void>();
  let dashboardUrl = "";
  const broker = await startRaceIqActivationBroker(async (url) => {
    await serverReady;
    if (isRaceIqImportActivation(url)) await dispatchCloudLapImport(url);
    openDashboard(dashboardUrl, "/");
  });
  if (process.platform === "win32" && !broker) {
    if (activation) await forwardRaceIqActivation(activation);
    process.exit(0);
  }
  try {
    const server = await bootServer();
    dashboardUrl = server.dashboardUrl;
    markReady();
    if (activation) {
      if (isRaceIqImportActivation(activation)) await dispatchCloudLapImport(activation);
      openDashboard(server.dashboardUrl, "/");
    }
  } catch (error) {
    broker?.close();
    throw error;
  }
}
