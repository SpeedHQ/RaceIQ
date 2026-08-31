import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { wsManager, type WSData } from "./websocket-manager";
import type { AppType } from "../routes/index";
import { MAX_IBT_BYTES } from "../games/iracing/import-ibt";
import { IS_WINDOWS } from "./platform/shell";

type HttpApp = Pick<AppType, "fetch">;

export function staticAssetHeaders(filePath: string): HeadersInit | undefined {
  if (!filePath.endsWith(".gz")) return undefined;
  const contentPath = filePath.slice(0, -".gz".length);
  return {
    "content-encoding": "gzip",
    "content-type": contentPath.endsWith(".json") ? "application/json" : "application/octet-stream",
  };
}


export interface HttpServerOptions {
  app: HttpApp;
  port: number;
  staticDir: string | null;
  devPublicDir: string | null;
}

export function clearHttpPort(port: number): void {
  try {
    if (IS_WINDOWS) {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -EA 0 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA 0 }"`,
        { stdio: "ignore", windowsHide: true },
      );
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: "ignore" });
    }
  } catch {
    // Nothing was listening — that's fine.
  }
}

export function startHttpServer({
  app,
  port,
  staticDir,
  devPublicDir,
}: HttpServerOptions): Bun.Server<WSData> {
  return Bun.serve<WSData>({
    port,
    idleTimeout: 255,
    // Bun otherwise terminates uploads above its 128 MiB default before Hono
    // can stream them to disk or return the route's structured size error.
    maxRequestBodySize: MAX_IBT_BYTES,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { createdAt: Date.now(), devTelemetrySubscribed: false },
        });
        if (upgraded) return undefined as unknown as Response;
      }

      if (url.pathname.startsWith("/api") || url.pathname.startsWith("/studio-api")) {
        return app.fetch(req);
      }

      if (process.env.NODE_ENV !== "production" && url.pathname === "/") {
        const origin = req.headers.get("origin") ?? "*";
        return new Response("ok", {
          status: 200,
          headers: {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
          },
        });
      }

      if (staticDir) {
        const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
        const filePath = resolve(staticDir, pathname.slice(1));
        if (filePath.startsWith(staticDir)) {
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file, { headers: staticAssetHeaders(filePath) });
          }
        }
        return new Response(Bun.file(resolve(staticDir, "index.html")));
      }

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

      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        wsManager.addClient(ws);
      },
      close(ws) {
        wsManager.removeClient(ws);
      },
      message(ws, msg) {
        wsManager.handleMessage(ws, typeof msg === "string" ? msg : Buffer.from(msg));
      },
    },
  });
}
