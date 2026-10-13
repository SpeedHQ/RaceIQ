import { gameImagesPlugin } from "./game-images.ts";
import { developmentDashboardHosts, startDashboardListeners } from "../scripts/dev/dashboard-listeners.ts";
import { spawn } from "node:child_process";
import type { ClientRequest, IncomingMessage } from "node:http";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, type Plugin, type ProxyOptions, type ViteDevServer } from "vite";

const configuredServerTarget = process.env.PROXY_TARGET;
const serverTarget = configuredServerTarget ?? `http://localhost:${process.env.SERVER_PORT ?? "3117"}`;

const forwardDashboardOrigin: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  const forward = (outgoing: ClientRequest, incoming: IncomingMessage) => {
    // changeOrigin rewrites Host to the backend. Preserve the browser-facing
    // authority for both HTTP and WebSocket requests, overwriting caller values.
    // Keep Origin intact so unrelated browser origins still fail validation.
    outgoing.setHeader("x-forwarded-host", incoming.headers.host ?? "");
    outgoing.setHeader("x-forwarded-proto", "http");
  };
  proxy.on("proxyReq", forward);
  proxy.on("proxyReqWs", forward);
};

const paraglideBuildScript = path.resolve(import.meta.dirname, "../scripts/dev/paraglide-build.ts");
const paraglideOutdir = path.resolve(import.meta.dirname, "src/paraglide");

function dashboardPortPlugin(): Plugin {
  let server: ViteDevServer | undefined;
  let stopListeners: (() => Promise<void>) | undefined;
  let listeners: Promise<void> | undefined;
  return {
    name: "raceiq-dashboard-port",
    apply: "serve",
    configResolved(config) {
      developmentDashboardHosts(process.env.RACEIQ_DEV_HTTP_HOSTS);
      // CLI overrides must not widen the listener to every interface.
      config.server.host = "127.0.0.1";
    },
    configureServer(instance) {
      server = instance;
      instance.httpServer?.once("listening", () => {
        const address = instance.httpServer?.address();
        if (!address || typeof address === "string") return;
        listeners = startDashboardListeners(address.port, developmentDashboardHosts(process.env.RACEIQ_DEV_HTTP_HOSTS))
          .then((stop) => { stopListeners = stop; })
          .catch((error) => {
            instance.config.logger.error(String(error));
            // Refuse partial configuration instead of falling back to wildcard.
            process.exit(1);
          });
      });
      instance.httpServer?.once("close", () => { void listeners?.then(() => stopListeners?.()); });
    },
    async transformIndexHtml() {
      await listeners;
      const address = server?.httpServer?.address();
      if (!address || typeof address === "string") return [];
      // Portless has its own loopback-only port. Share Vite's actual listener,
      // including a CLI port override or a fallback chosen after a collision.
      return [{ tag: "meta", attrs: { name: "raceiq-dashboard-port", content: String(address.port) }, injectTo: "head" }];
    },
  };
}

function paraglideBuildPlugin(): Plugin {
  return {
    name: "raceiq-paraglide-build",
    apply: "build",
    async buildStart() {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("bun", [paraglideBuildScript, "--client-root", import.meta.dirname], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`Paraglide build failed${signal ? ` (${signal})` : ` (${code})`}`));
        });
      });
    },
  };
}

function paraglideFullReloadPlugin(): Plugin {
  let reloadTimer: NodeJS.Timeout | undefined;
  return {
    name: "raceiq-paraglide-full-reload",
    apply: "serve",
    handleHotUpdate({ file, server }) {
      const relativePath = path.relative(paraglideOutdir, file);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        server.ws.send({ type: "full-reload", path: "*" });
      }, 50);
      return [];
    },
  };
}

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

export default defineConfig(({ command }) => {
  const isBuild = command === "build";

  return {
    envDir: path.resolve(import.meta.dirname, ".."),
    envPrefix: ["VITE_", "RACEIQ_"],
    plugins: [
      dashboardPortPlugin(),
      paraglideFullReloadPlugin(),
      devtools(),
      react(),
      tailwindcss(),
      TanStackRouterVite(),
      gameImagesPlugin(),
      ...(isBuild ? [paraglideBuildPlugin()] : []),
    ],
    customLogger: logger,
    define: {
      // Use the page origin so API and WebSocket share the same session cookie.
      __RACEIQ_DEV_WS_TARGET__: "undefined",
    },
    resolve: {
      // Keep React and renderer on one module instance in Bun workspaces. Without
      // dedupe, Vite can resolve peer dependencies through different .bun paths,
      // leaving React hooks bound to a dispatcher the renderer does not set.
      dedupe: [
        "react",
        "react-dom",
        "@assistant-ui/core",
        "@assistant-ui/store",
        "@assistant-ui/tap",
        "assistant-stream",
      ],
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
      },
    },
    build: {
      chunkSizeWarningLimit: 2000,
    },
    server: {
      open: false,
      port: parseInt(process.env.PORT || "5173", 10),
      host: "127.0.0.1",
      proxy: {
        "/ws": { target: serverTarget, changeOrigin: true, ws: true, configure: forwardDashboardOrigin },
        "/api": {
          target: serverTarget,
          changeOrigin: true,
          configure: forwardDashboardOrigin,
        },
        // Dev-only Mastra Studio API (server/runtime/dev-studio.ts) — Studio reads it
        // through the portless hostname, so Vite must forward it to the server.
        "/studio-api": {
          target: serverTarget,
          changeOrigin: true,
          configure: forwardDashboardOrigin,
        },
      },
    },
  };
});
