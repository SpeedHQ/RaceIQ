import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { USER_VOICE_PACKS_DIR } from "@raceiq/shared/platform/runtime/data-paths";
import { createHttpAccess } from "../../src/runtime/http-access";
import { createLiveEngineerRoutes } from "../../src/routes/dev/live-engineer-routes";
import { startHttpServer } from "../../src/runtime/http-server";

const { createServer: createViteServer } = createRequire(new URL("../../../../client/package.json", import.meta.url))("vite");

test("development proxy serves authenticated installed voice assets without SPA fallback", async () => {
  if (process.env.RACEIQ_AUDIO_PROXY_TEST_CHILD !== "1") {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-audio-proxy-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, DATA_DIR: directory, RACEIQ_AUDIO_PROXY_TEST_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`Isolated audio proxy test failed:\n${stdout}\n${stderr}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    return;
  }
  const fixture = join(USER_VOICE_PACKS_DIR, "live-engineer", "qwen-v3");
  const source = join(process.env.DATA_DIR!, "generated-qwen-v3");
  mkdirSync(source, { recursive: true });
  mkdirSync(fixture, { recursive: true });
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const clipEntry = { segmentId: "fixture-segment", spokenText: "Fixture clip", path: "clip.flac", sha256, durationMs: 100 };
  const line = { lineId: "fixture-line", spokenText: "Fixture line", path: "line.flac", sha256, durationMs: 100 };
  const manifest = { catalogVersion: "fixture", model: "fixture-model", fullLines: [line], clips: [clipEntry] };
  writeFileSync(join(fixture, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(fixture, "clip.flac"), bytes);
  writeFileSync(join(fixture, "line.flac"), bytes);
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(source, "clip.flac"), bytes);
  writeFileSync(join(source, "line.flac"), bytes);
  symlinkSync(join(fixture, "clip.flac"), join(source, "outside.flac"));
  const password = "abcdefgh";
  const backend = startHttpServer({
    port: 0,
    staticDir: null,
    devPublicDir: null,
    access: await createHttpAccess({ NODE_ENV: "production", SERVER_PASSWORD: password }),
    app: { fetch: (request) => createLiveEngineerRoutes(source).fetch(request) },
  });
  const previousTarget = process.env.PROXY_TARGET;
  process.env.PROXY_TARGET = `http://127.0.0.1:${backend.port}`;
  let vite: { middlewares: RequestListener; close(): Promise<void> } | undefined;
  let http: Server | undefined;
  try {
    const viteServer: { middlewares: RequestListener; close(): Promise<void> } = await createViteServer({
      configFile: new URL("../../../../client/vite.config.ts", import.meta.url).pathname,
      root: new URL("../../../../client", import.meta.url).pathname,
      server: { middlewareMode: true, hmr: false },
    });
    vite = viteServer;
    http = createHttpServer(viteServer.middlewares);
    const listening = Promise.withResolvers<void>();
    http.once("error", listening.reject);
    http.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener address");
    const origin = `http://127.0.0.1:${address.port}`;
    const base = `${origin}/audio/live-engineer/${basename(fixture)}`;
    const headers = { authorization: `Basic ${Buffer.from(`raceiq:${password}`).toString("base64")}` };
    expect((await fetch(`${base}/manifest.json`)).status).toBe(401);
    const response = await fetch(`${base}/manifest.json`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(manifest);
    const catalogUrl = `${origin}/api/dev/live-engineer/catalog`;
    const checkUrl = `${origin}/api/dev/live-engineer/catalog-check`;
    expect((await fetch(catalogUrl)).status).toBe(401);
    expect((await fetch(checkUrl, { method: "POST" })).status).toBe(401);
    const catalogResponse = await fetch(catalogUrl, { headers });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json();
    expect(catalog.catalogVersion).toBe(manifest.catalogVersion);
    expect(catalog.model).toBe(manifest.model);
    expect(catalog.validation).toBe(true);
    expect(catalog.fullLines).toEqual([{ ...line, url: `/api/dev/live-engineer/audio/${line.path}` }]);
    expect(catalog.qwenClips).toEqual([{ ...clipEntry, url: `/api/dev/live-engineer/audio/${clipEntry.path}` }]);
    const check = await fetch(checkUrl, { method: "POST", headers });
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ passed: true, failures: [] });
    const clip = await fetch(`${base}/clip.flac`, { headers });
    expect(clip.status).toBe(200);
    expect(new Uint8Array(await clip.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const sourceBase = `${origin}/api/dev/live-engineer/audio`;
    expect((await fetch(`${sourceBase}/manifest.json`)).status).toBe(401);
    expect(await (await fetch(`${sourceBase}/manifest.json`, { headers })).json()).toEqual(manifest);
    expect(new Uint8Array(await (await fetch(`${sourceBase}/clip.flac`, { headers })).arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${sourceBase}/missing.flac`, { headers })).status).toBe(404);
    expect((await fetch(`${sourceBase}/outside.flac`, { headers })).status).toBe(404);
    expect((await fetch(`${sourceBase}/%2e%2e%2fclip.flac`, { headers })).status).toBe(404);
    const missing = await fetch(`${base}/missing.flac`, { headers });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
    writeFileSync(join(source, "clip.flac"), new Uint8Array([4]));
    const failedCheck = await fetch(checkUrl, { method: "POST", headers });
    expect(failedCheck.status).toBe(500);
    expect(await failedCheck.json()).toEqual({ passed: false, failures: ["Qwen clip hash mismatch: fixture-segment"] });
    rmSync(join(source, "manifest.json"));
    expect((await fetch(catalogUrl, { headers })).status).toBe(404);
    expect((await fetch(`${sourceBase}/manifest.json`, { headers })).status).toBe(404);
    expect((await fetch(checkUrl, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${base}/manifest.json`, { headers })).status).toBe(200);
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
