import { spawn } from "node:child_process";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, type Plugin } from "vite";

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

const paraglideBuildScript = path.resolve(import.meta.dirname, "@raceiq/tooling/dev/paraglide-build");
const paraglideOutdir = path.resolve(import.meta.dirname, "src/paraglide");

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
      paraglideFullReloadPlugin(),
      devtools(),
      react(),
      tailwindcss(),
      TanStackRouterVite(),
      ...(isBuild ? [paraglideBuildPlugin()] : []),
    ],
    customLogger: logger,
    define: {
      __RACEIQ_DEV_WS_TARGET__: JSON.stringify(devWebSocketTarget),
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
      host: true,
      proxy: {
        "/api": {
          target: serverTarget,
          changeOrigin: true,
        },
        // Dev-only Mastra Studio API (server/runtime/dev-studio.ts) — Studio reads it
        // through the portless hostname, so Vite must forward it to the server.
        "/studio-api": {
          target: serverTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
