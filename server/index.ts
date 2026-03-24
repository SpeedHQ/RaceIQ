// Prefix all console output with ISO timestamp
const _log = console.log;
const _warn = console.warn;
const _error = console.error;
console.log = (...args: unknown[]) => _log(new Date().toISOString(), ...args);
console.warn = (...args: unknown[]) => _warn(new Date().toISOString(), ...args);
console.error = (...args: unknown[]) => _error(new Date().toISOString(), ...args);

import { spawn } from "child_process";
import app from "./routes";
import { udpListener } from "./udp";
import { wsManager, type WSData } from "./ws";
import { loadSettings, saveSettings } from "./settings";

import { existsSync } from "fs";
import { resolve, dirname } from "path";

// In production, serve static assets from disk (dist/public/)
const _execDir = dirname(process.execPath);
const staticDir = existsSync(resolve(_execDir, "public", "index.html"))
  ? resolve(_execDir, "public")
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
import { sqlite } from "./db/index";
import { migrateTelemetryToCSV } from "./db/queries";
migrateTelemetryToCSV();

// Load persisted settings
const settings = loadSettings();

// Auto-activate the first profile if no activeProfileId is set yet
{
  const _settings = loadSettings();
  if (_settings.activeProfileId == null) {
    const firstProfile = (sqlite as any).query("SELECT id FROM profiles LIMIT 1").get() as { id: number } | null;
    if (firstProfile) {
      saveSettings({ ..._settings, activeProfileId: firstProfile.id });
    }
  }
}

console.log(`[Server] Starting Forza Telemetry Server...`);

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
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
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
console.log(`[Server] WebSocket endpoint: ws://localhost:${HTTP_PORT}/ws`);

// Start UDP listener — settings.udpPort takes priority, env var is the fallback
const udpPort = settings.udpPort ?? (Number(process.env.UDP_PORT) || 5300);
udpListener.start(udpPort);

console.log(`[Server] Forza Telemetry Server is ready!`);
console.log(`[Server] Listening for Forza UDP on port ${udpPort}`);
