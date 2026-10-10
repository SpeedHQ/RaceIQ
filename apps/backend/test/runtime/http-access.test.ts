import { describe, expect, test } from "bun:test";
import { createHttpAccess } from "../../src/runtime/http-access";

const password = "abcdefgh";
const basic = `Basic ${Buffer.from(`raceiq:${password}`).toString("base64")}`;
const local = createHttpAccess({ NODE_ENV: "production" });
const dev = createHttpAccess({ NODE_ENV: "development" });
const lan = createHttpAccess({ NODE_ENV: "production", SERVER_HOST: "0.0.0.0", SERVER_PASSWORD: password, SERVER_ALLOWED_ORIGINS: "http://192.168.1.10:3117" });
const request = (path: string, headers: HeadersInit = {}) => new Request(`http://localhost:3117${path}`, { headers });

describe("HTTP access policy", () => {
  test("defaults to loopback and fails closed on incomplete LAN configuration", () => {
    expect(local.hostname).toBe("127.0.0.1");
    expect(() => createHttpAccess({ SERVER_HOST: "0.0.0.0" })).toThrow("SERVER_PASSWORD");
    expect(() => createHttpAccess({ SERVER_HOST: "::", SERVER_PASSWORD: "short" })).toThrow("8");
    expect(() => createHttpAccess({ SERVER_HOST: "0.0.0.0", SERVER_PASSWORD: password })).toThrow("SERVER_ALLOWED_ORIGINS");
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "https://example.com/path" })).toThrow();
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "https://user:pass@example.com" })).toThrow();
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "*" })).toThrow();
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "https://dashboard.example" })).toThrow("SERVER_PASSWORD");
  });

  test("rejects passwords below the 8-character minimum", () => {
    for (const hostname of ["127.0.0.1", "0.0.0.0", "::"]) {
      expect(() => createHttpAccess({
        NODE_ENV: "production", SERVER_HOST: hostname,
        SERVER_PASSWORD: "a".repeat(7), SERVER_ALLOWED_ORIGINS: "http://192.168.1.10:3117",
      })).toThrow("SERVER_PASSWORD must contain at least 8 characters");
    }
  });

  test("allows local dashboard and non-browser clients", () => {
    expect(local.authorize(request("/api/status"))).toBeUndefined();
    expect(local.authorize(request("/api/settings", { origin: "http://localhost:3117" }))).toBeUndefined();
  });

  test("rejects foreign and null origins on reads, writes, preflight and websocket requests", () => {
    for (const method of ["GET", "PUT", "POST", "OPTIONS"]) {
      for (const origin of ["https://attacker.example", "null", "http://localhost.attacker.example:3117"]) {
        const req = new Request("http://localhost:3117/api/ai-key", { method, headers: { origin, "access-control-request-method": "PUT" } });
        expect(dev.authorize(req)?.status).toBe(403);
      }
    }
    expect(dev.authorize(request("/ws", { origin: "https://attacker.example" }))?.status).toBe(403);
    expect(local.authorize(request("/api/ai-models", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }))?.status).toBe(403);
    expect(local.authorize(request("/", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }))).toBeUndefined();
  });

  test("rejects rebinding hosts and ignores forged proxy headers", () => {
    expect(dev.authorize(new Request("http://attacker.example:3117/api/status"))?.status).toBe(403);
    expect(dev.authorize(request("/api/status", { host: "attacker.example:3117", "x-forwarded-host": "localhost:3117" }))?.status).toBe(403);
    expect(dev.authorize(request("/api/status", { origin: "https://attacker.example", "x-forwarded-for": "127.0.0.1" }))?.status).toBe(403);
  });

  test("allows loopback Vite, Portless worktrees and Studio only in development", () => {
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:4118", "http://feature.raceiq-123.localhost:1355", "http://studio.localhost:1355"]) {
      expect(dev.authorize(request("/studio-api", { origin }))).toBeUndefined();
      expect(local.authorize(request("/studio-api", { origin }))?.status).toBe(403);
    }
  });

  test("requires LAN credentials even when a client spoofs a loopback Host", () => {
    for (const path of ["/", "/api/settings", "/studio-api", "/ws"]) {
      expect(lan.authorize(request(path))?.status).toBe(401);
      expect(lan.authorize(request(path, { authorization: "Basic invalid" }))?.status).toBe(401);
      expect(lan.authorize(request(path, { authorization: basic }))).toBeUndefined();
    }
    const req = new Request("http://192.168.1.10:3117/api/settings", { headers: { authorization: basic, origin: "http://192.168.1.10:3117" } });
    expect(lan.authorize(req)).toBeUndefined();
    expect(lan.authorize(request("/api/settings", { authorization: basic, origin: "https://attacker.example" }))?.status).toBe(403);
  });

  test("permits trusted credentialless preflight but not the subsequent unauthenticated write", () => {
    const url = "http://192.168.1.10:3117/api/ai-key";
    const origin = "http://192.168.1.10:3117";
    const preflight = lan.authorize(new Request(url, { method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT" } }));
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight?.body).toBeNull();
    expect(lan.authorize(new Request(url, { method: "PUT", headers: { origin } }))?.status).toBe(401);
  });
});
