import app from "./routes";
import { udpListener } from "./udp";
import { wsManager, type WSData } from "./ws";

const HTTP_PORT = 3001;
const UDP_PORT = parseInt(process.env.UDP_PORT ?? "5300", 10);

// Import DB to ensure schema is created on startup
import "./db/index";

console.log(`[Server] Starting Forza Telemetry Server...`);

// Start the HTTP/WebSocket server
const server = Bun.serve<WSData>({
  port: HTTP_PORT,
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

// Start UDP listener
udpListener.start(UDP_PORT);

console.log(`[Server] Forza Telemetry Server is ready!`);
console.log(`[Server] Configure Forza: Settings > Gameplay > Data Out > IP: 127.0.0.1, Port: ${UDP_PORT}`);
