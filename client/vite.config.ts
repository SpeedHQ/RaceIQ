import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";
import react from "@vitejs/plugin-react";
import path from "path";
import { createLogger, defineConfig } from "vite";

const configuredServerTarget = process.env.PROXY_TARGET;
const serverTarget = configuredServerTarget ?? `http://localhost:${process.env.SERVER_PORT ?? "3117"}`;
const serverUrl = new URL(serverTarget);
const devWebSocketTarget = {
  protocol: serverUrl.protocol === "https:" ? "wss:" : "ws:",
  // With the default local target, use the page hostname so LAN development
  // still reaches the machine serving RaceIQ. An explicit target owns its host.
  hostname: configuredServerTarget ? serverUrl.hostname : "",
  port: serverUrl.port,
};

// Deduplicate proxy error logs — show once, then suppress repeats
const logger = createLogger();
const origWarn = logger.warn.bind(logger);
let lastProxyError = "";
let proxyErrorCount = 0;
logger.warn = (msg, options) => {
  if (typeof msg === "string" && msg.includes("proxy error")) {
    const key = msg.slice(0, 60);
    if (key === lastProxyError) {
      proxyErrorCount++;
      return;
    }
    if (proxyErrorCount > 0) {
      origWarn(`  (repeated ${proxyErrorCount} more times)`, options);
    }
    lastProxyError = key;
    proxyErrorCount = 0;
  }
  origWarn(msg, options);
};

export default defineConfig({
  envDir: path.resolve(import.meta.dirname, ".."),
  envPrefix: ["VITE_", "RACEIQ_"],
  plugins: [
    react(),
    tailwindcss(),
    TanStackRouterVite(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      // Locale is driven by the server-persisted `language` setting; the client
      // bootstraps it via setLocale() on load (see __root.tsx). localStorage is
      // the runtime cache; baseLocale ("en") is the fallback.
      strategy: ["localStorage", "baseLocale"],
    }),
  ],
  customLogger: logger,
  define: {
    __RACEIQ_DEV_WS_TARGET__: JSON.stringify(devWebSocketTarget),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "../shared"),
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: parseInt(process.env.PORT || "5173", 10),
    host: true,
    proxy: {
      "/api": {
        target: serverTarget,
        changeOrigin: true,
      },
      // Dev-only Mastra Studio API (server/dev-studio.ts) — Studio reads it
      // through the portless hostname, so Vite must forward it to the server.
      "/studio-api": {
        target: serverTarget,
        changeOrigin: true,
      },
    },
  },
});
