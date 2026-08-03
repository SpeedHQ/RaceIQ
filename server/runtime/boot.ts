import { existsSync } from "fs";
import { resolve } from "path";
import { initGameAdapters } from "../../shared/games/init";
import { injectDiscoveredAcEvoCars } from "../../shared/racing/cars/ac-evo";
import { injectDiscoveredIRacingIdentity } from "../../shared/games/iracing";
import app from "../routes/index";
import { initServerGameAdapters } from "../games/init";
import { initDb } from "../db/index";
import { reconcileDiscoveredCars, listDiscoveredCars } from "../db/discovered-cars";
import { listDiscoveredTracks } from "../db/discovered-tracks";
import { deleteEmptySessions } from "../db/session-queries";
import { setCacheMaxBytes } from "../db/telemetry-replay-storage";
import { isFirstRun, loadSettings } from "./config/settings";
import { wsManager, type WSData } from "./websocket-manager";
import { udpListener } from "./udp-listener";
import { PUBLIC_DIR, IS_COMPILED } from "./config/paths";
import { getOnboardingOverride } from "./options";
import { preventMacSleep, openFirstRunDashboard } from "./desktop";
import { clearHttpPort, startHttpServer } from "./http-server";
import { startNativeSourceSupervisor, type NativeSourceSupervisor } from "./native-sources";
import { installShutdown } from "./shutdown";
import { startMaintenanceJobs, startSyncAndStaleSessionJobs } from "./startup-jobs";
import { startTray } from "./platform/tray";

export interface BootOptions {
  httpPort?: number;
  udpPort?: number;
  recordingGameId?: string | null;
}

export interface RunningServer {
  httpServer: Bun.Server<WSData>;
  httpPort: number;
  udpPort: number;
}

function recordingGameIdFromArgs(args: readonly string[]): string | null {
  const arg = args.find((value) => value.startsWith("--record="));
  return arg ? arg.split("=")[1] ?? null : null;
}

export async function bootServer(options: BootOptions = {}): Promise<RunningServer> {
  initGameAdapters();
  initServerGameAdapters();

  const staticDir = IS_COMPILED && existsSync(resolve(PUBLIC_DIR, "index.html"))
    ? PUBLIC_DIR
    : null;
  if (staticDir) {
    console.log(`[Server] Serving static assets from ${staticDir}`);
  }
  const devPublicDir = !IS_COMPILED ? PUBLIC_DIR : null;

  preventMacSleep();

  const httpPort = options.httpPort ?? (Number(process.env.SERVER_PORT) || 3117);
  const onboardingOverride = getOnboardingOverride();
  if (onboardingOverride !== null) {
    console.log(`[Server] Development onboarding override: ${onboardingOverride ? "show" : "skip"}`);
  }

  const recordingGameId = options.recordingGameId === undefined
    ? recordingGameIdFromArgs(process.argv)
    : options.recordingGameId;
  if (recordingGameId) {
    console.log(`[Server] Recording mode enabled for game: ${recordingGameId}`);
  }

  await initDb();
  await reconcileDiscoveredCars();
  injectDiscoveredAcEvoCars(await listDiscoveredCars("ac-evo"));

  const [iracingCars, iracingTracks] = await Promise.all([
    listDiscoveredCars("iracing"),
    listDiscoveredTracks("iracing"),
  ]);
  injectDiscoveredIRacingIdentity(iracingCars, iracingTracks);

  const firstRun = isFirstRun();
  const settings = loadSettings();
  if (settings.wsRefreshRate) {
    wsManager.setRefreshRate(settings.wsRefreshRate);
  }
  setCacheMaxBytes(settings.cacheMaxMB * 1024 * 1024);

  const emptyCleaned = await deleteEmptySessions();
  if (emptyCleaned > 0) {
    console.log(`[DB] Cleaned up ${emptyCleaned} empty session(s)`);
  }

  console.log("[Server] Starting RaceIQ Server...");
  clearHttpPort(httpPort);
  console.log("[Boot] Port cleared");

  // Dynamic import is required here: dev-studio pulls @mastra/hono and the
  // DuckDB-backed Mastra instance, which must stay out of the production bundle.
  if (process.env.NODE_ENV !== "production") {
    const { mountStudioServer } = await import("./dev-studio");
    await mountStudioServer(app);
  }

  const httpServer = startHttpServer({
    app,
    port: httpPort,
    staticDir,
    devPublicDir,
  });
  console.log(`[Server] HTTP/WS server listening on http://localhost:${httpPort}`);

  if (recordingGameId === "fm-2023" || recordingGameId === "f1-2025") {
    udpListener.setRecordingGameId(recordingGameId);
  }

  let nativeSources: NativeSourceSupervisor | null = null;
  installShutdown({
    recordingGameId,
    getNativeSources: () => nativeSources,
  });

  const udpPort = options.udpPort ?? settings.udpPort ?? (Number(process.env.UDP_PORT) || 5301);
  void udpListener.start(udpPort);

  startSyncAndStaleSessionJobs();

  nativeSources = startNativeSourceSupervisor(recordingGameId);
  startTray(httpPort);

  if (firstRun) {
    openFirstRunDashboard(httpPort);
  }

  startMaintenanceJobs();

  console.log("[Server] RaceIQ Server is ready!");
  console.log(`[Server] Listening for UDP on port ${udpPort}`);

  return { httpServer, httpPort, udpPort };
}
