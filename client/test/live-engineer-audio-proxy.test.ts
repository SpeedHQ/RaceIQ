import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { basename, join } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { USER_VOICE_PACKS_DIR } from "@raceiq/shared/platform/runtime/data-paths";
import { createHttpAccess } from "../../apps/backend/src/runtime/http-access";
import { startHttpServer } from "../../apps/backend/src/runtime/http-server";

test("development proxy serves authenticated installed voice assets without SPA fallback", async () => {
  const root = join(USER_VOICE_PACKS_DIR, "live-engineer");
  mkdirSync(root, { recursive: true });
  const fixture = mkdtempSync(join(root, "proxy-test-"));
  const manifest = { catalogVersion: "fixture", clips: [{ path: "clip.flac" }] };
  writeFileSync(join(fixture, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(fixture, "clip.flac"), new Uint8Array([1, 2, 3]));
  const password = "abcdefgh";
  const backend = startHttpServer({
    port: 0,
    staticDir: null,
    devPublicDir: null,
    access: await createHttpAccess({ NODE_ENV: "production", SERVER_PASSWORD: password }),
    app: { fetch: () => new Response("unexpected API request", { status: 500 }) },
  });
  const previousTarget = process.env.PROXY_TARGET;
  process.env.PROXY_TARGET = `http://127.0.0.1:${backend.port}`;
  let vite: ViteDevServer | undefined;
  let http: Server | undefined;
  try {
    vite = await createViteServer({
      configFile: new URL("../vite.config.ts", import.meta.url).pathname,
      root: new URL("..", import.meta.url).pathname,
      server: { middlewareMode: true },
    });
    http = createHttpServer(vite.middlewares);
    const listening = Promise.withResolvers<void>();
    http.once("error", listening.reject);
    http.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener address");
    const base = `http://127.0.0.1:${address.port}/audio/live-engineer/${basename(fixture)}`;
    const headers = { authorization: `Basic ${Buffer.from(`raceiq:${password}`).toString("base64")}` };
    expect((await fetch(`${base}/manifest.json`)).status).toBe(401);
    const response = await fetch(`${base}/manifest.json`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(manifest);
    const clip = await fetch(`${base}/clip.flac`, { headers });
    expect(clip.status).toBe(200);
    expect(new Uint8Array(await clip.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const missing = await fetch(`${base}/missing.flac`, { headers });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
  } finally {
    if (http) {
      const closed = Promise.withResolvers<void>();
      http.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
    await vite?.close();
    backend.stop(true);
    if (previousTarget === undefined) delete process.env.PROXY_TARGET;
    else process.env.PROXY_TARGET = previousTarget;
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
