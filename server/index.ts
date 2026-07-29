process.title = "RaceIQ";

import { captureConsole } from "./logger";
captureConsole();

import { spawn } from "child_process";
import app from "./routes";
import { udpListener } from "./udp";
import { wsManager, type WSData } from "./ws";
import { loadSettings } from "./settings";
import { initServerGameAdapters } from "./games/init";
import { initGameAdapters } from "../shared/games/init";
import { accRecorder } from "./games/acc/recorder";
import { acEvoRecorder } from "./games/ac-evo/recorder";
import { iracingRecorder } from "./games/iracing/recorder";
import { reconcileDiscoveredCars, listDiscoveredCars } from "./db/discovered-cars";
import { listDiscoveredTracks } from "./db/discovered-tracks";
import { injectDiscoveredAcEvoCars } from "../shared/ac-evo-car-data";
import { getOnboardingOverride } from "./runtime-options";

// Register all game adapters (shared + server)
initGameAdapters();
initServerGameAdapters();

import { existsSync } from "fs";
import { resolve } from "path";
import { PUBLIC_DIR, IS_COMPILED } from "./paths";

// In production, serve static assets from disk (dist/public/)
const staticDir = IS_COMPILED && existsSync(resolve(PUBLIC_DIR, "index.html"))
  ? PUBLIC_DIR
  : null;
if (staticDir) {
  console.log(`[Server] Serving static assets from ${staticDir}`);
}
// In dev, serve public assets (wheels, etc.) so they work when hitting the server directly
const devPublicDir = !IS_COMPILED ? PUBLIC_DIR : null;

// Prevent macOS sleep while the server is running
if (process.platform === "darwin") {
  try {
    const caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: true });
    caffeinate.unref();
    process.on("exit", () => { try { caffeinate.kill(); } catch {} });
    console.log("[Server] caffeinate started — macOS will not sleep while server is running");
  } catch {
    console.log("[Server] caffeinate not available — sleep prevention disabled");
  }
}

const HTTP_PORT = Number(process.env.SERVER_PORT) || 3117;
const onboardingOverride = getOnboardingOverride();

if (onboardingOverride !== null) {
  console.log(`[Server] Development onboarding override: ${onboardingOverride ? "show" : "skip"}`);
}

// Check for recording mode flag: --record=gameId
// e.g. bun run dev --record=acc
const recordingGameId = (() => {
  const arg = process.argv.find((a) => a.startsWith("--record="));
  return arg ? arg.split("=")[1] : null;
})();

if (recordingGameId) {
  console.log(`[Server] Recording mode enabled for game: ${recordingGameId}`);
}

// Prepare the DB (PRAGMAs, migrations, backfills) before anything queries it.
// This used to be implicit in the import — `import "./db/index"` blocked on
// top-level await inside that module. It is now an explicit awaited call so a
// stuck DB fails here, at startup, instead of silently wedging the module graph.
import { initDb } from "./db/index";
import { deleteEmptySessions, setCacheMaxBytes } from "./db/queries";
import { injectDiscoveredIRacingIdentity } from "../shared/games/iracing";

await initDb();

// Promote any discovered_cars rows whose name has since landed in cars.csv,
// then load whatever's left into the in-memory name-resolution map so
// getAcEvoCarName()/getCarName() resolve runtime-discovered cars immediately.
await reconcileDiscoveredCars();
injectDiscoveredAcEvoCars(await listDiscoveredCars("ac-evo"));

// Rehydrate each distinct native iRacing identity before HTTP routes begin
// resolving historical sessions.
const [iracingCars, iracingTracks] = await Promise.all([
  listDiscoveredCars("iracing"),
  listDiscoveredTracks("iracing"),
]);
injectDiscoveredIRacingIdentity(iracingCars, iracingTracks);

// Detect first run (settings file doesn't exist yet) before loadSettings creates it
import { isFirstRun } from "./settings";
const firstRun = isFirstRun();

// Load persisted settings and apply
const settings = loadSettings();
if (settings.wsRefreshRate) {
  wsManager.setRefreshRate(settings.wsRefreshRate);
}
setCacheMaxBytes(settings.cacheMaxMB * 1024 * 1024);

// Clean up empty sessions on startup. Orphan-file sweep is handled by the
// session compressor's maintenance loop (runs immediately on start, then
// every 5 minutes — see session-compressor.ts::runMaintenance).
const emptyCleaned = await deleteEmptySessions();
if (emptyCleaned > 0) console.log(`[DB] Cleaned up ${emptyCleaned} empty session(s)`);

console.log(`[Server] Starting RaceIQ Server...`);

// Kill any process already listening on the port (e.g. previous hot-reload instance)
function killPort(port: number): void {
  try {
    const { execSync } = require("child_process");
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -EA 0 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA 0 }"`,
        { stdio: "ignore", windowsHide: true },
      );
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: "ignore", shell: true });
    }
  } catch {
    // Nothing was listening — that's fine
  }
}

killPort(HTTP_PORT);
console.log("[Boot] Port cleared");

// Dev-only: mount the Mastra API in-process so `mastra studio` can read the
// running app's real Metrics/Logs/Traces without a second DuckDB writer (which
// would file-lock the single-writer observability store). Isolated in
// ./dev-studio and dynamically imported here so @mastra/hono + the DuckDB-backed
// mastra instance never enter the prod bundle — same boundary as ai/agents.ts.
if (process.env.NODE_ENV !== "production") {
  const { mountStudioServer } = await import("./dev-studio");
  await mountStudioServer(app);
}

// Start the HTTP/WebSocket server
Bun.serve<WSData>({
  port: HTTP_PORT,
  idleTimeout: 255, // seconds (Bun max) — local model first-token latency can spike
  async fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { createdAt: Date.now() },
      });
      // Bun expects undefined on successful upgrade; cast satisfies TypeScript
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes always go to Hono. `/studio-api` is the dev-only Mastra API
    // (see dev-studio.ts); the prefix check is a cheap no-op in prod where it's
    // never mounted.
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/studio-api")) {
      return app.fetch(req);
    }

    // Dev-only: Mastra Studio's connection check does a bare `GET /` (no prefix)
    // against the Mastra server and treats a non-2xx as "server down". The dev
    // server's root isn't otherwise used (the client is served via portless), so
    // answer it 2xx with reflected CORS so Studio proceeds to the dashboard.
    if (process.env.NODE_ENV !== "production" && url.pathname === "/") {
      const origin = req.headers.get("origin") ?? "*";
      return new Response("ok", {
        status: 200,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
        },
      });
    }

    // In production, serve static assets from disk
    if (staticDir) {
      const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const filePath = resolve(staticDir, pathname.slice(1));
      // Security: ensure path is within staticDir
      if (filePath.startsWith(staticDir)) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file);
        }
      }
      // SPA fallback
      return new Response(Bun.file(resolve(staticDir, "index.html")));
    }

    // In dev, serve public assets (wheels, sounds, etc.) directly
    if (devPublicDir) {
      const pathname = decodeURIComponent(url.pathname);
      const filePath = resolve(devPublicDir, pathname.slice(1));
      if (filePath.startsWith(devPublicDir)) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file);
        }
      }
    }

    // Handle HTTP via Hono (dev mode)
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      wsManager.addClient(ws);
    },
    close(ws) {
      wsManager.removeClient(ws);
    },
    message(_ws, _msg) {
      // No client-to-server messages expected
    },
  },
});

console.log(`[Server] HTTP/WS server listening on http://localhost:${HTTP_PORT}`);

// UDP-based recording for `dev:dump:fm` / `dev:dump:f1`. Shared-memory games
// (acc, ac-evo) record via their own readers further down. Set before start()
// so the listener opens its .bin the moment it begins receiving packets —
// same init-time shape as AccSharedMemoryReader's constructor flag.
if (recordingGameId === "fm-2023" || recordingGameId === "f1-2025") {
  udpListener.setRecordingGameId(recordingGameId);
}

// Flush every recorder on Ctrl+C / kill so each .bin has a clean tail. All
// recorders buffer via Bun.file().writer() — without this handler the
// default SIGINT path exits before the buffer drains and the file ends up
// zero-length (or missing the tail).
import { flushSessionRecorder } from "./pipeline";
import { stopSessionCompressor } from "./session-compressor";

const gracefulShutdown = async (signal: NodeJS.Signals) => {
  console.log(`[Server] Received ${signal} — flushing session recorder...`);
  stopSessionCompressor();
  try {
    const tasks: Promise<unknown>[] = [flushSessionRecorder()];
    if (accReader) tasks.push(accReader.stop());
    if (acEvoReader) tasks.push(acEvoReader.stop());
    if (iracingSource) tasks.push(iracingSource.stop());
    if (recordingGameId) {
      tasks.push(
        udpListener.stop(),
        accRecorder.stop(),
        acEvoRecorder.stop(),
        iracingRecorder.stop(),
      );
    }
    await Promise.allSettled(tasks);
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

// Start UDP listener — settings.udpPort takes priority, env var is the fallback
const udpPort = settings.udpPort ?? (Number(process.env.UDP_PORT) || 5301);
udpListener.start(udpPort);

// Sync community tunes from the CDN (non-blocking) and schedule the 6h refresh.
import { startCommunityTunesSync } from "./community-tunes-sync";
startCommunityTunesSync();

// Sync the community leaderboard (reference lap times) from the CDN.
import { startLaptimesSync } from "./laptimes-sync";
startLaptimesSync();

// Check for sessions recorded with an older lap detector version.
// Stores the notification in wsManager so it's sent to each client on connect.
import { countStaleSessions } from "./db/queries";
import { LAP_DETECTOR_ID } from "./lap-detector";
import { LAP_DETECTOR_V2_ID } from "./lap-detector-acc";
import { LAP_DETECTOR_AC_EVO_ID } from "./lap-detector-ac-evo";
import { LAP_DETECTOR_IRACING_ID } from "./lap-detector-iracing";
const ALL_DETECTOR_IDS = [
  LAP_DETECTOR_ID,
  LAP_DETECTOR_V2_ID,
  LAP_DETECTOR_AC_EVO_ID,
  LAP_DETECTOR_IRACING_ID,
];
countStaleSessions(ALL_DETECTOR_IDS).then((count) => {
  if (count > 0) {
    console.log(`[Server] ${count} session(s) recorded with stale lap detector — will prompt user to reprocess`);
    wsManager.setStaleSessionsNotification({
      type: "stale-lap-detection",
      sessionCount: count,
      currentVersion: ALL_DETECTOR_IDS.join(","),
    });
  }
}).catch((err) => {
  console.error("[Server] Failed to check stale sessions:", err);
});

import { AccSharedMemoryReader } from "./games/acc/shared-memory";
import { AcEvoSharedMemoryReader } from "./games/ac-evo/shared-memory";
import { IRacingTelemetrySource } from "./games/iracing/source";
import { registerLiveIRacingIdentity } from "./games/iracing/identity";
import { startTray } from "./tray";
import { isGameRunning } from "./games/registry";
import { superviseSource } from "./source-supervisor";

// Readers are instantiated + started only when the underlying game process is
// detected. No idle SHM polling, no process-checker thread running while the
// game isn't open. Central poll cadence matches per-reader ProcessCheckers (2s).
export let accReader: AccSharedMemoryReader | null = null;
export let acEvoReader: AcEvoSharedMemoryReader | null = null;
export let iracingSource: IRacingTelemetrySource | null = null;

if (process.platform === "win32") {
  console.log("[Supervisor] Watching for native telemetry games (acc, ac-evo, iracing) — 2s poll");
  setInterval(() => {
    superviseSource(
      isGameRunning("acc"),
      "ACC",
      () => new AccSharedMemoryReader(recordingGameId === "acc"),
      () => accReader,
      (r) => { accReader = r; },
    );
    superviseSource(
      isGameRunning("ac-evo"),
      "AC Evo",
      () => new AcEvoSharedMemoryReader(recordingGameId === "ac-evo"),
      () => acEvoReader,
      (r) => { acEvoReader = r; },
    );
    superviseSource(
      isGameRunning("iracing"),
      "iRacing",
      () => new IRacingTelemetrySource({
        recordingEnabled: recordingGameId === "iracing",
        registerIdentity: registerLiveIRacingIdentity,
      }),
      () => iracingSource,
      (source) => { iracingSource = source; },
    );
  }, 2000);

  startTray(HTTP_PORT);
}

// On first install, auto-open the dashboard in the default browser
if (firstRun) {
  const url = `http://localhost:${HTTP_PORT}`;
  console.log(`[Server] First run detected — opening ${url}`);
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {}
}

import { startSessionCompressor } from "./session-compressor";
startSessionCompressor();

import { startUpdateCheckSchedule } from "./update-check";
startUpdateCheckSchedule();

console.log(`[Server] RaceIQ Server is ready!`);
console.log(`[Server] Listening for UDP on port ${udpPort}`);
