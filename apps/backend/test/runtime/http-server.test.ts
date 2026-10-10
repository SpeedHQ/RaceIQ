import { describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
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
    const password = "test-only-listener-password-24-characters";
    const server = startHttpServer({
      port: 0, staticDir: null, devPublicDir: null,
      access: createHttpAccess({ NODE_ENV: "production", SERVER_PASSWORD: password }),
      app: { fetch: () => { calls++; return new Response("allowed"); } },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(server.hostname).toBe("127.0.0.1");
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
