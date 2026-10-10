import { describe, expect, test } from "bun:test";
import { createHttpAccess } from "../../src/runtime/http-access";

const password = "abcdefgh";
const basic = `Basic ${Buffer.from(`raceiq:${password}`).toString("base64")}`;
const local = createHttpAccess({ NODE_ENV: "production" });
const dev = createHttpAccess({ NODE_ENV: "development" });
const lan = createHttpAccess({ NODE_ENV: "production", SERVER_HOST: "0.0.0.0", SERVER_PASSWORD: password, SERVER_ALLOWED_ORIGINS: "http://192.168.1.10:3117" });
const request = (path: string, headers: HeadersInit = {}) => new Request(`http://localhost:3117${path}`, { headers });

describe("HTTP access policy", () => {
  test("preserves remote listeners without requiring authentication or trusted origins", () => {
    expect(local.hostname).toBe("0.0.0.0");
    for (const hostname of ["0.0.0.0", "::", "127.0.0.1", "192.168.1.10"]) {
      expect(createHttpAccess({ SERVER_HOST: hostname }).hostname).toBe(hostname);
    }
    expect(() => createHttpAccess({ SERVER_HOST: "::", SERVER_PASSWORD: "short" })).toThrow("8");
    expect(createHttpAccess({ SERVER_PASSWORD: password }).authorize(request("/"))?.status).toBe(401);
  });

  test("rejects invalid origins but permits an allowlist without a password", () => {
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "https://example.com/path" })).toThrow();
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "https://user:pass@example.com" })).toThrow();
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "*" })).toThrow();
    expect(() => createHttpAccess({ SERVER_ALLOWED_ORIGINS: "https://*.example.com" })).toThrow();
    expect(createHttpAccess({ SERVER_ALLOWED_ORIGINS: "https://dashboard.example" }).authorize(
      request("/api/status", { origin: "https://dashboard.example" }),
    )).toBeUndefined();
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

  test("rejects inconsistent hosts and does not grant trust from client IP headers", () => {
    expect(dev.authorize(request("/api/status", { host: "attacker.example:3117", "x-forwarded-host": "localhost:3117" }))?.status).toBe(403);
    expect(dev.authorize(request("/api/status", { origin: "https://attacker.example", "x-forwarded-for": "127.0.0.1" }))?.status).toBe(403);
  });

  test("preserves same-origin LAN, Tailnet, Docker and HTTPS proxy access without configuration", () => {
    for (const origin of ["http://localhost:3117", "http://192.168.1.10:3117", "http://100.101.102.103:3117", "http://raceiq-host.example-tailnet.ts.net:3117", "http://docker-host:8080", "https://raceiq.example.com"]) {
      for (const path of ["/", "/api/status", "/ws"]) {
        expect(local.authorize(new Request(`${origin}${path}`, { headers: { origin } }))).toBeUndefined();
        expect(local.authorize(new Request(`${origin}${path}`))).toBeUndefined();
      }
    }
    expect(local.authorize(new Request("http://raceiq.example.com/api/status", {
      headers: { origin: "https://raceiq.example.com" },
    }))).toBeUndefined();
    expect(local.authorize(request("/ws", {
      origin: "https://raceiq.example.com", "sec-fetch-site": "same-origin",
    }))).toBeUndefined();
    expect(local.authorize(request("/ws", {
      origin: "https://raceiq.example.com", "sec-fetch-site": "same-site",
    }))?.status).toBe(403);
    expect(local.authorize(request("/ws", {
      origin: "https://raceiq.example.com", "x-forwarded-host": "raceiq.example.com", "x-forwarded-proto": "https",
    }))).toBeUndefined();
    for (const forwardedHost of ["raceiq.example.com, attacker.example", "user@raceiq.example.com", "raceiq.example.com/path"]) {
      expect(local.authorize(request("/ws", {
        origin: "https://raceiq.example.com", "x-forwarded-host": forwardedHost, "x-forwarded-proto": "https",
      }))?.status).toBe(403);
    }
    // Cross-origin scripts cannot include their custom header values in the
    // preflight. Without a trusted origin they cannot send the actual request.
    expect(local.authorize(new Request("http://localhost:3117/api/settings", {
      method: "OPTIONS", headers: {
        origin: "https://attacker.example", "access-control-request-method": "PUT",
        "access-control-request-headers": "x-forwarded-host,x-forwarded-proto",
      },
    }))?.status).toBe(403);
  });

  test("explicit origins replace compatibility rules and match scheme, host and port exactly", () => {
    const origins = ["http://192.168.1.10:3117", "http://100.101.102.103:3117", "http://raceiq-host.example-tailnet.ts.net:3117", "https://raceiq.example.com"];
    for (const configuredPassword of ["", password]) {
      const policy = createHttpAccess({ SERVER_ALLOWED_ORIGINS: ` ${origins.join(", ")}, `, SERVER_PASSWORD: configuredPassword });
      for (const origin of origins) {
        expect(policy.authorize(request("/ws", { origin, authorization: basic }))).toBeUndefined();
        const preflight = policy.authorize(new Request("http://localhost:3117/api/ai-key", {
          method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT" },
        }));
        expect(preflight?.status).toBe(204);
        expect(preflight?.headers.get("access-control-allow-origin")).toBe(origin);
      }
      for (const origin of ["https://100.101.102.103:3117", "http://100.101.102.103:3118", "https://raceiq.example.com:444", "https://raceiq.example.com.attacker.example", "http://unrelated.localhost:1355", "http://localhost:3117", "null"]) {
        expect(policy.authorize(request("/ws", { origin, authorization: basic, "sec-fetch-site": "same-origin", "x-forwarded-host": "raceiq.example.com.attacker.example", "x-forwarded-proto": "https" }))?.status).toBe(403);
      }
    }
  });

  test("allows loopback Vite, Portless worktrees and Studio only in development", () => {
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:4118", "http://feature.raceiq-123.localhost:1355", "http://studio.localhost:1355"]) {
      expect(dev.authorize(request("/studio-api", { origin }))).toBeUndefined();
      expect(local.authorize(request("/studio-api", { origin }))?.status).toBe(403);
    }
    const remoteVite = new Request("http://192.168.1.10:3117/ws", { headers: { origin: "http://192.168.1.10:5173" } });
    expect(dev.authorize(remoteVite)).toBeUndefined();
    expect(local.authorize(remoteVite)?.status).toBe(403);
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
