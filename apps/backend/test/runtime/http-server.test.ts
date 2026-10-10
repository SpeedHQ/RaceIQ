import { describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, staticAssetHeaders } from "../../src/runtime/http-server";
import { createHttpAccess } from "../../src/runtime/http-access";

describe("static asset headers", () => {
  test("marks gzip JSON assets for transparent browser decompression", () => {
    expect(staticAssetHeaders("/dist/public/demo-lap.json.gz")).toEqual({
      "content-encoding": "gzip",
      "content-type": "application/json",
    });
  });

  test("leaves ordinary assets on Bun's default content type", () => {
    expect(staticAssetHeaders("/dist/public/index.html")).toBeUndefined();
  });
});

describe("HTTP listener access controls", () => {
  test("blocks requests before reaching APIs, Studio, or the WebSocket upgrade", async () => {
    let calls = 0;
    const password = "abcdefgh";
    const server = startHttpServer({
      port: 0, staticDir: null, devPublicDir: null,
      access: createHttpAccess({ NODE_ENV: "production", SERVER_PASSWORD: password }),
      app: { fetch: () => { calls++; return new Response("allowed"); } },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(server.hostname).toBe("0.0.0.0");
      for (const path of ["/", "/api/settings", "/studio-api", "/ws"]) {
        expect((await fetch(`${base}${path}`)).status).toBe(401);
        expect((await fetch(`${base}${path}`, { headers: { origin: "https://attacker.example" } })).status).toBe(403);
      }
      expect(calls).toBe(0);
      const headers = { authorization: `Basic ${Buffer.from(`raceiq:${password}`).toString("base64")}` };
      expect((await fetch(`${base}/api/status`, { headers })).status).toBe(200);
      expect(calls).toBe(1);
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(`${base}/ws`, { headers: {
          ...headers, Connection: "Upgrade", Upgrade: "websocket",
          "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        } });
        req.setTimeout(3000, () => req.destroy(new Error("WebSocket did not open")));
        req.on("upgrade", (response, socket) => {
          socket.destroy();
          if (response.statusCode === 101) resolve();
          else reject(new Error("WebSocket rejected valid credentials"));
        });
        req.on("response", (response) => { response.resume(); reject(new Error(`Expected upgrade, got ${response.statusCode}`)); });
        req.on("error", reject);
        req.end();
      });
    } finally {
      server.stop(true);
    }
  });
});

function upgrade(base: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/ws`, { headers: {
      ...headers, Connection: "Upgrade", Upgrade: "websocket",
      "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    } });
    req.setTimeout(3000, () => req.destroy(new Error("WebSocket handshake timed out")));
    req.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
    req.on("response", (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
}

test("existing unprotected deployments serve dashboard, API and WebSockets at remote authorities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-access-dashboard-"));
  writeFileSync(join(directory, "index.html"), "<h1>RaceIQ dashboard fixture</h1>");
  const server = startHttpServer({
    port: 0, staticDir: directory, devPublicDir: null,
    access: createHttpAccess({ NODE_ENV: "production" }),
    app: { fetch: () => Response.json({ ok: true }) },
  });
  try {
    expect(server.hostname).toBe("0.0.0.0");
    const base = `http://127.0.0.1:${server.port}`;
    // Real HTTP/upgrade requests with deployment Host/Origin headers. These
    // exercise proxy boundaries, not external Tailnet or Cloudflare routing.
    const cases: Record<string, string>[] = [
      { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` },
      { host: "192.168.1.10:3117", origin: "http://192.168.1.10:3117" },
      { host: "100.101.102.103:3117", origin: "http://100.101.102.103:3117" },
      { host: "raceiq-host.example-tailnet.ts.net:3117", origin: "http://raceiq-host.example-tailnet.ts.net:3117" },
      { host: "docker-host:8080", origin: "http://docker-host:8080" },
      { host: "raceiq.example.com", origin: "https://raceiq.example.com" },
      { host: `127.0.0.1:${server.port}`, origin: "https://raceiq.example.com", "x-forwarded-host": "raceiq.example.com", "x-forwarded-proto": "https" },
      { host: `127.0.0.1:${server.port}`, origin: "https://raceiq.example.com", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of cases) {
      const dashboard = await fetch(`${base}/`, { headers });
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain("RaceIQ dashboard fixture");
      expect((await fetch(`${base}/api/status`, { headers })).status).toBe(200);
      expect(await upgrade(base, headers)).toBe(101);
      const hostile = { ...headers, origin: "https://attacker.example", "sec-fetch-site": "cross-site" };
      expect((await fetch(`${base}/api/status`, { headers: hostile })).status).toBe(403);
      expect(await upgrade(base, hostile)).toBe(403);
    }
  } finally {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker healthcheck works with and without an opt-in password", async () => {
  const dockerfile = readFileSync(new URL("../../../../Dockerfile", import.meta.url), "utf8");
  const healthcheck = dockerfile.split("\n").find((line) => line.startsWith("HEALTHCHECK "))!;
  const [, ...args] = JSON.parse(healthcheck.slice(healthcheck.indexOf("CMD ") + 4)) as string[];
  for (const password of ["", "abcdefgh"]) {
    const server = startHttpServer({
      port: 0, staticDir: null, devPublicDir: null,
      access: createHttpAccess({ NODE_ENV: "production", SERVER_PASSWORD: password }),
      app: { fetch: () => new Response("ok") },
    });
    try {
      const check = (suppliedPassword: string) => Bun.spawn([process.execPath, ...args], {
        env: { ...process.env, SERVER_PORT: String(server.port), SERVER_PASSWORD: suppliedPassword },
        stdout: "pipe", stderr: "pipe",
      }).exited;
      expect(await check(password)).toBe(0);
      if (password) expect(await check("wrong-password")).toBe(1);
    } finally {
      server.stop(true);
    }
  }
});
