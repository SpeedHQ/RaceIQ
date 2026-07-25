import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import path from "path";

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
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../shared"),
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
        target: process.env.PROXY_TARGET ?? "http://localhost:3117",
        changeOrigin: true,
      },
      // Dev-only Mastra Studio API (server/dev-studio.ts) — Studio reads it
      // through the portless hostname, so Vite must forward it to the server.
      "/studio-api": {
        target: process.env.PROXY_TARGET ?? "http://localhost:3117",
        changeOrigin: true,
      },
      "/ws": {
        target: (process.env.PROXY_TARGET ?? "http://localhost:3117").replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
});
