import { createRaceIqOnlineAdapter } from "@raceiq/online/adapter";
import { createNativeBoardIdentifierResolver } from "@raceiq/online/identifiers";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRaceIqOnlineService } from "@raceiq/online/service";
import { OnlineStateStorage } from "@raceiq/online/state-storage";
import type { OnlineState } from "@raceiq/online/contracts";
import { createOnlineRoutes } from "../../src/routes/online-routes";
import { readOnlineTestPlatform, createOnlineTestFetch, createOnlineTestKeystore } from "../../src/integrations/online-test-platform";

const environment = {
  NODE_ENV: "test", RACEIQ_E2E: "1", RACEIQ_E2E_ONLINE_ORIGIN: "http://127.0.0.1:12345",
  RACEIQ_E2E_AUTH_ORIGIN: "https://localhost:12346", RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "isolated-public-fixture-key",
};

test("E2E cannot select live credentials or hosted origins through missing or unsafe configuration", () => {
  expect(readOnlineTestPlatform({ NODE_ENV: "production" })).toBeNull();
  for (const override of [
    { NODE_ENV: "production" }, { RACEIQ_E2E_ONLINE_ORIGIN: undefined }, { RACEIQ_E2E_AUTH_ORIGIN: undefined },
    { RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: undefined }, { RACEIQ_E2E_ONLINE_ORIGIN: "https://not-loopback.invalid" },
    { RACEIQ_E2E_AUTH_ORIGIN: "https://not-loopback.invalid" }, { RACEIQ_E2E_AUTH_ORIGIN: "http://127.0.0.1:12346" },
    { RACEIQ_E2E_ONLINE_ORIGIN: "http://user:password@127.0.0.1:12345" },
    { RACEIQ_E2E_ONLINE_ORIGIN: "http://127.0.0.1:12345/hidden?target=elsewhere" },
  ]) expect(() => readOnlineTestPlatform({ ...environment, ...override })).toThrow();
});

test("isolated application credential stores never carry a previous launch's refresh session", async () => {
  const first = createOnlineTestKeystore();
  const restarted = createOnlineTestKeystore();
  await first.setSecret("raceiq-online-refresh", "fixture-refresh-session");
  expect(await restarted.getSecret("raceiq-online-refresh")).toBe("");
  expect(await first.getSecret("raceiq-online-refresh")).toBe("fixture-refresh-session");
  await first.setSecret("raceiq-online-refresh", "");
  expect(await first.getSecret("raceiq-online-refresh")).toBe("");
});

test("SDK transport rejects unconfigured origins and redirects before credentials can reach another local provider", async () => {
  let foreignRequests = 0;
  const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { foreignRequests++; return new Response(null, { status: 204 }); } });
  const foreignOrigin = `http://127.0.0.1:${foreign.port}`;
  const trusted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname === "/redirect" ? Response.redirect(`${foreignOrigin}/capture`) : new Response(null, { status: 204 });
  } });
  try {
    const platform = readOnlineTestPlatform({ ...environment, RACEIQ_E2E_ONLINE_ORIGIN: `http://127.0.0.1:${trusted.port}` })!;
    const transport = createOnlineTestFetch(platform);
    expect((await transport(`${platform.baseUrl}/allowed`, { headers: { Authorization: "Bearer fixture-session" } })).status).toBe(204);
    await expect(transport(`${foreignOrigin}/capture`, { headers: { Authorization: "Bearer fixture-session" } }))
      .rejects.toMatchObject({ reason: "e2e_online_transport_blocked" });
    expect(() => transport.preconnect(foreignOrigin)).toThrow();
    await expect(transport(`${platform.baseUrl}/redirect`, { headers: { Authorization: "Bearer fixture-session" } })).rejects.toThrow();
    expect(foreignRequests).toBe(0);
  } finally {
    await trusted.stop(true);
    await foreign.stop(true);
  }
});

test("real Hono and SDK return anonymous local availability and truthful offline state without a hosted auth route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-online-platform-"));
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.has("authorization") || new URL(request.url).pathname !== "/api/v1/consent") return new Response(null, { status: 401 });
    return Response.json({ available: true, termsVersion: "terms-fixture", privacyVersion: "privacy-fixture",
      termsUrl: "https://localhost/terms", privacyUrl: "https://localhost/privacy" });
  } });
  const platform = readOnlineTestPlatform({ ...environment, RACEIQ_E2E_ONLINE_ORIGIN: `http://127.0.0.1:${provider.port}` })!;
  const create = (name: string) => createRaceIqOnlineService({ ...platform, fetch: createOnlineTestFetch(platform),
    storage: new OnlineStateStorage(join(directory, name)), keystore: createOnlineTestKeystore(),
    recordingProducer: async () => { throw new Error("Anonymous platform fixture must not prepare a recording"); },
  });
  try {
    const service = create("available");
    const response = await createOnlineRoutes(service).request("http://localhost/api/online/state");
    expect(response.status).toBe(200);
    const state = await response.json() as OnlineState;
    expect(state).toMatchObject({ service: "available", connection: { status: "signed_out" }, uploadAllowed: false,
      policy: { status: "available" }, sync: { blockedBy: "signed_out" } });
    const connected = await service.connect({ accountEpoch: state.accountEpoch, expectedRevision: state.revision });
    expect(connected.ok).toBe(true);
    if (!connected.ok) throw new Error(connected.error.code);
    expect(new URL(connected.authorizationUrl).origin).toBe(platform.authConfig.supabaseUrl);
    const active = await service.getState();
    if (active.connection.status !== "signing_in") throw new Error("SDK sign-in attempt was not admitted");
    await service.cancelSignIn({ accountEpoch: active.accountEpoch, expectedRevision: active.revision, flowId: active.connection.flowId });
    await provider.stop(true);
    const offlineResponse = await createOnlineRoutes(create("offline")).request("http://localhost/api/online/state");
    expect(offlineResponse.status).toBe(200);
    expect(await offlineResponse.json()).toMatchObject({ service: "offline", connection: { status: "signed_out" }, uploadAllowed: false,
      policy: { status: "unavailable" } });
  } finally {
    await provider.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("real SDK bootstrap profile verification never waits on the credentials being established", async () => {
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname !== "/api/v1/me" || request.headers.get("authorization") !== "Bearer fixture-bootstrap-token") {
      return new Response(null, { status: 401 });
    }
    return Response.json({ userId: "bootstrap-owner", displayName: "Chosen name", avatarUrl: null });
  } });
  try {
    const platform = readOnlineTestPlatform({ ...environment, RACEIQ_E2E_ONLINE_ORIGIN: `http://127.0.0.1:${provider.port}` })!;
    const adapter = createRaceIqOnlineAdapter({ baseUrl: platform.baseUrl, fetch: createOnlineTestFetch(platform),
      identifiers: createNativeBoardIdentifierResolver(),
      credentials: async () => { throw new Error("Bootstrap must not re-enter unresolved credential restoration"); },
    });
    expect(await adapter.getMe("fixture-bootstrap-token", "Discord identity")).toEqual({
      userId: "bootstrap-owner", displayName: "Chosen name", avatarUrl: null, discordUsername: "Discord identity",
    });
  } finally {
    await provider.stop(true);
  }
});

test("restored session crosses the real SDK profile boundary before owner admission without self-awaiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-online-restored-sdk-"));
  const ownerClaims: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/consent") return Response.json({ available: true, termsVersion: "terms-fixture", privacyVersion: "privacy-fixture",
      termsUrl: "https://localhost/terms", privacyUrl: "https://localhost/privacy" });
    if (path === "/api/v1/me" && request.headers.get("authorization") === "Bearer fixture-restored-token") {
      return Response.json({ userId: "restored-owner", displayName: "Restored driver", avatarUrl: null });
    }
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  } });
  try {
    const platform = readOnlineTestPlatform({ ...environment, RACEIQ_E2E_ONLINE_ORIGIN: `http://127.0.0.1:${provider.port}` })!;
    const keystore = createOnlineTestKeystore();
    await keystore.setSecret("raceiq-online-refresh", "fixture-initial-refresh");
    const service = createRaceIqOnlineService({ ...platform, keystore, fetch: createOnlineTestFetch(platform),
      storage: new OnlineStateStorage(directory),
      recordingProducer: async () => { throw new Error("Restoration fixture must not prepare a recording"); },
      auth: {
        async refreshSession() { return { accessToken: "fixture-restored-token", refreshToken: "fixture-rotated-refresh",
          userId: "restored-owner", discordAccountName: "Restored Discord identity", expiresAt: Math.floor(Date.now() / 1000) + 3600 }; },
        async beginSignIn() { throw new Error("Restoration must not start a new provider flow"); },
      },
      async onAccountConnected(userId, isCurrent) {
        expect(isCurrent()).toBe(true);
        ownerClaims.push(userId);
      },
    });
    const response = await createOnlineRoutes(service).request("http://localhost/api/online/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: { status: "connected",
      account: { userId: "restored-owner", discordUsername: "Restored Discord identity" } }, uploadAllowed: false });
    expect(ownerClaims).toEqual(["restored-owner"]);
    expect(await keystore.getSecret("raceiq-online-refresh")).toBe("fixture-rotated-refresh");
  } finally {
    await provider.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
