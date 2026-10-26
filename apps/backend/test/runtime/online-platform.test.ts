import { expect, test } from "bun:test";
import { resolveOnlinePlatform, OnlinePlatformConfigurationError } from "../../src/integrations/online-platform";

const localEnv = {
  NODE_ENV: "development",
  RACEIQ_DEV_ONLINE_ORIGIN: "http://127.0.0.1:12345",
  RACEIQ_DEV_AUTH_ORIGIN: "https://localhost:12346",
  RACEIQ_DEV_AUTH_PUBLISHABLE_KEY: "local-public-fixture-key",
};

test("ordinary development defaults to disabled and accepts complete loopback config", () => {
  expect(resolveOnlinePlatform({ NODE_ENV: "development" })).toEqual({ kind: "disabled" });
  const platform = resolveOnlinePlatform(localEnv);
  expect(platform.kind).toBe("local");
  if (platform.kind !== "local") throw new Error("Expected local platform");
  expect(platform.baseUrl).toBe(localEnv.RACEIQ_DEV_ONLINE_ORIGIN);
  expect(platform.authConfig).toEqual({ supabaseUrl: localEnv.RACEIQ_DEV_AUTH_ORIGIN, publishableKey: localEnv.RACEIQ_DEV_AUTH_PUBLISHABLE_KEY });
});

test("approved development tunnel accepts explicit API origin with hosted auth", () => {
  const tunnel = {
    ...localEnv,
    RACEIQ_DEV_ONLINE_ORIGIN: "https://raceiq-dev.snazzie.space",
    RACEIQ_DEV_AUTH_ORIGIN: "https://auth.example.com",
  };
  const platform = resolveOnlinePlatform(tunnel);
  expect(platform.kind).toBe("local");
  if (platform.kind !== "local") throw new Error("Expected local platform");
  expect(platform.baseUrl).toBe(tunnel.RACEIQ_DEV_ONLINE_ORIGIN);
  expect(platform.authConfig).toEqual({ supabaseUrl: tunnel.RACEIQ_DEV_AUTH_ORIGIN, publishableKey: tunnel.RACEIQ_DEV_AUTH_PUBLISHABLE_KEY });
  for (const value of [
    "https://raceiq.snazzie.space",
    "https://raceiq-dev.snazzie.space.evil",
    "https://evilraceiq-dev.snazzie.space",
    "http://raceiq-dev.snazzie.space",
    "https://raceiq-dev.snazzie.space/path",
    "https://raceiq-dev.snazzie.space?query",
    "https://user@raceiq-dev.snazzie.space",
  ]) {
    expect(() => resolveOnlinePlatform({ ...tunnel, RACEIQ_DEV_ONLINE_ORIGIN: value })).toThrow(OnlinePlatformConfigurationError);
  }
});

test("partial and unsafe development configuration fails closed", () => {
  for (const key of ["RACEIQ_DEV_ONLINE_ORIGIN", "RACEIQ_DEV_AUTH_ORIGIN", "RACEIQ_DEV_AUTH_PUBLISHABLE_KEY"]) {
    const partial = { ...localEnv };
    delete partial[key as keyof typeof partial];
    expect(() => resolveOnlinePlatform(partial)).toThrow(OnlinePlatformConfigurationError);
  }
  for (const [key, values] of [
    ["RACEIQ_DEV_ONLINE_ORIGIN", ["https://example.com", "http://localhost.evil", "http://user@localhost:1234", "http://localhost:1234/path", "http://localhost:1234?query", "http://localhost:1234#fragment", "http://127.0.0.1.evil:1234", "http://localhost.:1234", "file://localhost/tmp"]],
    ["RACEIQ_DEV_AUTH_ORIGIN", ["http://127.0.0.1:1234", "http://example.com", "https://user@localhost:1234", "https://localhost:1234/path", "https://localhost:1234?query", "https://localhost:1234#fragment"]],
  ] as const) {
    for (const value of values) {
      expect(() => resolveOnlinePlatform({ ...localEnv, [key]: value })).toThrow(OnlinePlatformConfigurationError);
    }
  }
  expect(() => resolveOnlinePlatform({ ...localEnv, RACEIQ_DEV_AUTH_PUBLISHABLE_KEY: " " })).toThrow(OnlinePlatformConfigurationError);
});

test("hosted auth is allowed only with complete explicit development configuration", () => {
  const hosted = { ...localEnv, RACEIQ_DEV_AUTH_ORIGIN: "https://auth.example.com" };
  const platform = resolveOnlinePlatform(hosted);
  expect(platform.kind).toBe("local");
  if (platform.kind !== "local") throw new Error("Expected local platform");
  expect(platform.authConfig.supabaseUrl).toBe("https://auth.example.com");
  expect(() => resolveOnlinePlatform({ NODE_ENV: "development", RACEIQ_DEV_AUTH_ORIGIN: hosted.RACEIQ_DEV_AUTH_ORIGIN })).toThrow(OnlinePlatformConfigurationError);
  expect(() => resolveOnlinePlatform({ ...hosted, RACEIQ_DEV_ONLINE_ORIGIN: "https://api.raceiq.com" })).toThrow(OnlinePlatformConfigurationError);
  for (const value of ["http://auth.example.com", "https://user:pass@auth.example.com", "https://auth.example.com/path", "https://auth.example.com?query", "https://auth.example.com#fragment"]) {
    expect(() => resolveOnlinePlatform({ ...hosted, RACEIQ_DEV_AUTH_ORIGIN: value })).toThrow(OnlinePlatformConfigurationError);
  }
});

test("production keeps caller-owned platform and E2E reuses strict test platform", () => {
  expect(resolveOnlinePlatform({ NODE_ENV: "production", RACEIQ_DEV_ONLINE_ORIGIN: "https://production.example" })).toEqual({ kind: "production" });
  expect(() => resolveOnlinePlatform({ NODE_ENV: "production", RACEIQ_E2E: "1" })).toThrow();
  const e2e = resolveOnlinePlatform({
    NODE_ENV: "test", RACEIQ_E2E: "1", RACEIQ_E2E_ONLINE_ORIGIN: "http://127.0.0.1:22345",
    RACEIQ_E2E_AUTH_ORIGIN: "https://localhost:22346", RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "e2e-public-key",
  });
  expect(e2e.kind).toBe("local");
  if (e2e.kind !== "local") throw new Error("Expected E2E local platform");
  expect(e2e.baseUrl).toBe("http://127.0.0.1:22345");
});

test("local transport rejects nonconfigured origins and redirects; keystores are isolated", async () => {
  let foreignRequests = 0;
  const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { foreignRequests++; return new Response(null, { status: 204 }); } });
  const trusted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname === "/redirect" ? Response.redirect(`http://127.0.0.1:${foreign.port}/capture`) : new Response(null, { status: 204 });
  } });
  try {
    const platform = resolveOnlinePlatform({ ...localEnv, RACEIQ_DEV_ONLINE_ORIGIN: `http://127.0.0.1:${trusted.port}`, RACEIQ_DEV_AUTH_ORIGIN: `https://localhost:${trusted.port}` });
    if (platform.kind !== "local") throw new Error("Expected local platform");
    expect(platform.authConfig.supabaseUrl).toBe(`https://localhost:${trusted.port}`);
    expect((await platform.fetch(`http://127.0.0.1:${trusted.port}/allowed`)).status).toBe(204);
    await expect(platform.fetch(`http://127.0.0.1:${foreign.port}/capture`)).rejects.toThrow();
    await expect(platform.fetch(`http://127.0.0.1:${trusted.port}/redirect`)).rejects.toThrow();
    expect(foreignRequests).toBe(0);
    await expect(platform.fetch("https://api.raceiq.com/capture")).rejects.toThrow();
    expect(() => platform.fetch.preconnect?.("https://api.raceiq.com/capture")).toThrow();
    const first = platform.keystore;
    const second = resolveOnlinePlatform(localEnv);
    if (second.kind !== "local") throw new Error("Expected local platform");
    await first.setSecret("online", "local-token");
    expect(() => platform.fetch.preconnect?.(`http://127.0.0.1:${foreign.port}/capture`)).toThrow();
  } finally {
    trusted.stop(true);
    foreign.stop(true);
  }
});
