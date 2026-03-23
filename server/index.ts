import { spawn } from "child_process";
import app from "./routes";
import { udpListener } from "./udp";
import { wsManager, type WSData } from "./ws";
import { loadSettings, saveSettings } from "./settings";

// In production, static assets are embedded in the binary
let embeddedAssets: Map<string, { data: Uint8Array; type: string }> | null = null;
if (process.env.NODE_ENV === "production") {
  try {
    const { assets } = await import("./client-assets.generated");
    embeddedAssets = assets;
    console.log(`[Server] Loaded ${assets.size} embedded static assets`);
  } catch {
    console.warn("[Server] No embedded assets found — static serving disabled");
  }
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

    // In production, serve embedded static assets
    if (embeddedAssets) {
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const asset = embeddedAssets.get(pathname);
      if (asset) {
        return new Response(asset.data, {
          headers: { "Content-Type": asset.type },
        });
      }
      // SPA fallback
      const index = embeddedAssets.get("/index.html");
      if (index) {
        return new Response(index.data, {
          headers: { "Content-Type": index.type },
        });
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
console.log(`[Server] WebSocket endpoint: ws://localhost:${HTTP_PORT}/ws`);

// Start UDP listener — settings.udpPort takes priority, env var is the fallback
const udpPort = settings.udpPort ?? (Number(process.env.UDP_PORT) || 5300);
udpListener.start(udpPort);

console.log(`[Server] Forza Telemetry Server is ready!`);
console.log(`[Server] Listening for Forza UDP on port ${udpPort}`);
