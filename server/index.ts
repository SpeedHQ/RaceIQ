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

// Check for recording mode flag: --record=gameId
// e.g. bun run dev --record=acc
const recordingGameId = (() => {
  const arg = process.argv.find((a) => a.startsWith("--record="));
  return arg ? arg.split("=")[1] : null;
})();

if (recordingGameId) {
  console.log(`[Server] Recording mode enabled for game: ${recordingGameId}`);
}

// Import DB to ensure schema is created on startup
import "./db/index";
import { deleteEmptySessions, setCacheMaxBytes } from "./db/queries";

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

    // API routes always go to Hono
    if (url.pathname.startsWith("/api")) {
      return app.fetch(req);
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
// three recorders buffer via Bun.file().writer() — without this handler the
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
    if (recordingGameId) {
      tasks.push(udpListener.stop(), accRecorder.stop(), acEvoRecorder.stop());
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

// Check for sessions recorded with an older lap detector version.
// Stores the notification in wsManager so it's sent to each client on connect.
import { countStaleSessions } from "./db/queries";
import { LAP_DETECTOR_ID } from "./lap-detector";
import { LAP_DETECTOR_V2_ID } from "./lap-detector-acc";
import { LAP_DETECTOR_AC_EVO_ID } from "./lap-detector-ac-evo";
const ALL_DETECTOR_IDS = [LAP_DETECTOR_ID, LAP_DETECTOR_V2_ID, LAP_DETECTOR_AC_EVO_ID];
countStaleSessions(ALL_DETECTOR_IDS).then((count) => {
  if (count > 0) {
    console.log(`[Server] ${count} session(s) recorded with stale lap detector — will prompt user to reprocess`);
    wsManager.setStaleSessionsNotification({
      type: "stale-lap-detection",
      sessionCount: count,
      currentVersion: `${LAP_DETECTOR_ID},${LAP_DETECTOR_V2_ID}`,
    });
  }
}).catch((err) => {
  console.error("[Server] Failed to check stale sessions:", err);
});

import { AccSharedMemoryReader } from "./games/acc/shared-memory";
import { AcEvoSharedMemoryReader } from "./games/ac-evo/shared-memory";
import { startTray } from "./tray";
import { isGameRunning } from "./games/registry";

// Readers are instantiated + started only when the underlying game process is
// detected. No idle SHM polling, no process-checker thread running while the
// game isn't open. Central poll cadence matches per-reader ProcessCheckers (2s).
export let accReader: AccSharedMemoryReader | null = null;
export let acEvoReader: AcEvoSharedMemoryReader | null = null;

function superviseReader<R extends { start(): void; stop(): Promise<void> }>(
  gameId: string,
  label: string,
  factory: () => R,
  getCurrent: () => R | null,
  setCurrent: (r: R | null) => void,
): void {
  const running = isGameRunning(gameId);
  const current = getCurrent();
  if (running && !current) {
    console.log(`[Server] ${label} process detected — starting shared memory reader`);
    const reader = factory();
    reader.start();
    setCurrent(reader);
  } else if (!running && current) {
    console.log(`[Server] ${label} process lost — stopping shared memory reader`);
    current.stop().catch((err) => {
      console.error(`[Server] ${label} reader stop failed:`, err instanceof Error ? err.message : err);
    });
    setCurrent(null);
  }
}

if (process.platform === "win32") {
  console.log("[Supervisor] Watching for shared-memory games (acc, ac-evo) — 2s poll");
  setInterval(() => {
    superviseReader(
      "acc",
      "ACC",
      () => new AccSharedMemoryReader(recordingGameId === "acc"),
      () => accReader,
      (r) => { accReader = r; },
    );
    superviseReader(
      "ac-evo",
      "AC Evo",
      () => new AcEvoSharedMemoryReader(recordingGameId === "ac-evo"),
      () => acEvoReader,
      (r) => { acEvoReader = r; },
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
