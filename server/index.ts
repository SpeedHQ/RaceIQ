process.title = "RaceIQ";

import { captureConsole } from "./logger";
captureConsole();

import { spawn, execSync } from "child_process";
import app from "./routes";
import { udpListener } from "./udp";
import { wsManager, type WSData } from "./ws";
import { loadSettings, saveSettings } from "./settings";
import { initServerGameAdapters } from "./games/init";
import { initGameAdapters } from "../shared/games/init";

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

// Import DB to ensure schema is created on startup
import { client } from "./db/index";
import { deleteEmptySessions } from "./db/queries";

// Detect first run (settings file doesn't exist yet) before loadSettings creates it
import { isFirstRun } from "./settings";
const firstRun = isFirstRun();

// Load persisted settings and apply
const settings = loadSettings();
if (settings.wsRefreshRate) {
  wsManager.setRefreshRate(settings.wsRefreshRate);
}

// Auto-activate the first profile if no activeProfileId is set yet
{
  const _settings = loadSettings();
  if (_settings.activeProfileId == null) {
    const result = await client.execute("SELECT id FROM profiles LIMIT 1");
    const firstProfile = result.rows.length > 0 ? { id: Number(result.rows[0].id) } : null;
    if (firstProfile) {
      saveSettings({ ..._settings, activeProfileId: firstProfile.id });
    }
  }
}

// Clean up empty sessions on startup
const emptyCleaned = await deleteEmptySessions();
if (emptyCleaned > 0) console.log(`[DB] Cleaned up ${emptyCleaned} empty session(s)`);

console.log(`[Server] Starting RaceIQ Server...`);

// Kill any process already listening on the port (e.g. previous hot-reload instance)
function killPort(port: number): void {
  try {
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
const server = Bun.serve<WSData>({
  port: HTTP_PORT,
  idleTimeout: 120, // seconds — AI analysis via Claude CLI can take up to 90s
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

// Start UDP listener — settings.udpPort takes priority, env var is the fallback
const udpPort = settings.udpPort ?? (Number(process.env.UDP_PORT) || 5301);
udpListener.start(udpPort);

import { accReader } from "./games/acc/shared-memory";
import { startTray } from "./tray";

// Start ACC shared memory reader + system tray (Windows only)
if (process.platform === "win32") {
  accReader.start();
  console.log("[Server] ACC shared memory reader started (will connect when ACC is running)");
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

console.log(`[Server] RaceIQ Server is ready!`);
console.log(`[Server] Listening for UDP on port ${udpPort}`);
