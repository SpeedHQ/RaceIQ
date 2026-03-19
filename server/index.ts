import { spawn } from "child_process";
import app from "./routes";
import { udpListener } from "./udp";
import { wsManager, type WSData } from "./ws";
import { loadSettings } from "./settings";

// Prevent macOS sleep while the server is running (non-fatal if caffeinate unavailable)
try {
  const caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: true });
  caffeinate.unref();
  process.on("exit", () => { try { caffeinate.kill(); } catch {} });
  console.log("[Server] caffeinate started — macOS will not sleep while server is running");
} catch {
  console.log("[Server] caffeinate not available — sleep prevention disabled");
}

const HTTP_PORT = 3117;

// Import DB to ensure schema is created on startup
import "./db/index";

// Load persisted settings
const settings = loadSettings();

console.log(`[Server] Starting Forza Telemetry Server...`);

// Start the HTTP/WebSocket server
const server = Bun.serve<WSData>({
  port: HTTP_PORT,
  idleTimeout: 120, // seconds — AI analysis via Claude CLI can take up to 90s
  fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { createdAt: Date.now() },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Handle HTTP via Hono
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

// Start UDP listener with saved settings
udpListener.start(settings.udpPort);

console.log(`[Server] Forza Telemetry Server is ready!`);
console.log(`[Server] Listening for Forza UDP on port ${settings.udpPort}`);
