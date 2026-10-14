import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOnlineRoutes, type OnlineRoutes } from "../../src/routes/online-routes";
import { createRaceIqOnlineService } from "@raceiq/online/service";
import { OnlineStateStorage } from "@raceiq/online/state-storage";
import { OnlineAdapterError } from "@raceiq/online/adapter";
import type { OnlineState, OnlineCommandResult } from "@raceiq/online/contracts";
import { createRaceIqOnlineAdapter } from "@raceiq/online/adapter";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function isolatedKeystore() {
  const secrets = new Map<string, string>();
  return {
    async getSecret(key: string) { return secrets.get(key) ?? ""; },
    async setSecret(key: string, value: string) { secrets.set(key, value); },
  };
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-online-routes-"));
  directories.push(directory);
  const service = createRaceIqOnlineService({ storage: new OnlineStateStorage(directory), keystore: isolatedKeystore(), adapter: {
    async getPolicy() { throw new OnlineAdapterError("policy_unavailable", false); },
    async getLeaderboard() { throw new Error("test offline"); },
  } });
  return { directory, service, routes: createOnlineRoutes(service) };
}

async function command(routes: OnlineRoutes, path: string, body: unknown, headers: Record<string, string> = {}) {
  return routes.request(`http://localhost${path}`, { method: path.includes("preferences") || path.includes("consent") || path.includes("profile") ? "PUT" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("Online account route safety", () => {
  test("wrong epoch cannot sign out or restrict current epoch", async () => {
    const { service, routes } = setup();
    const before = await service.getState();
    for (const path of ["/api/online/sign-out", "/api/online/preferences"]) {
      const response = await command(routes, path, { expectedRevision: before.revision, accountEpoch: "another-account", ...(path.endsWith("preferences") ? { preferences: { visibility: "private", setupUploads: false } } : {}) });
      expect(response.status).toBe(409);
      const result = await response.json() as OnlineCommandResult;
      expect(result.ok).toBe(false);
      expect(result.state.accountEpoch).toBe(before.accountEpoch);
      expect(result.state.revision).toBe(before.revision);
      expect(result.state.uploadAllowed).toBe(false);
    }
  });

  test("same-epoch sign-out remains restrictive with stale revision and invalidates late commands", async () => {
    const { service, routes } = setup();
    const before = await service.getState();
    const response = await command(routes, "/api/online/sign-out", { expectedRevision: before.revision + 100, accountEpoch: before.accountEpoch });
    expect(response.status).toBe(200);
    const result = await response.json() as OnlineCommandResult;
    expect(result.ok).toBe(true);
    expect(result.state.connection.status).toBe("signed_out");
    expect(result.state.accountEpoch).not.toBe(before.accountEpoch);
    expect(result.state.preferences).toBeNull();
    expect(result.state.persistedPreferences).toBeNull();
    const late = await command(routes, "/api/online/preferences", { expectedRevision: before.revision, accountEpoch: before.accountEpoch, preferences: { visibility: "public", setupUploads: true } });
    expect(late.status).toBe(409);
    expect((await late.json() as OnlineCommandResult).state.uploadAllowed).toBe(false);
  });

  test("rejects malformed JSON and cross-origin mutations with sanitized failures", async () => {
    const { service, routes } = setup();
    const state = await service.getState();
    const context = { expectedRevision: state.revision, accountEpoch: state.accountEpoch };
    const cross = await command(routes, "/api/online/sign-out", context, { Origin: "https://attacker.example" });
    expect(cross.status).toBe(400);
    expect((await cross.json() as OnlineCommandResult).ok).toBe(false);
    const invalid = await routes.request("http://localhost/api/online/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
    expect(invalid.status).toBe(400);
    const body = await invalid.json() as OnlineCommandResult;
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error).toEqual({ code: "invalid_request", retryable: false, retryAfter: null });
    expect((await service.getState()).accountEpoch).toBe(state.accountEpoch);
  });
  test("profile route rejects malformed display-name payloads", async () => {
    const { service, routes } = setup();
    const state = await service.getState();
    for (const displayName of ["", "x".repeat(513), "na\nme"]) {
      const response = await command(routes, "/api/online/profile", { ...{ expectedRevision: state.revision, accountEpoch: state.accountEpoch }, displayName });
      expect(response.status).toBe(400);
      expect((await response.json() as OnlineCommandResult).ok).toBe(false);
    }
  });

  test("rejects profile responses missing the chosen display name", async () => {
    const malformed = createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: async () => ({ accessToken: "token", consentAccepted: true }),
      identifiers: { resolve: () => ({ status: "unknown_track" as const }) },
      fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json({ userId: "user-1", avatarUrl: null }), { preconnect: fetch.preconnect }),
    });
    await expect(malformed.setDisplayName("Updated")).rejects.toMatchObject({ code: "invalid_response" });
  });
  test("missing game or board identifiers never selects default leaderboard", async () => {
    const { routes } = setup();
    for (const path of ["/api/online/leaderboard?trackId=1&carId=2", "/api/online/leaderboard?trackId=1"]) {
      const response = await routes.request(`http://localhost${path}`);
      expect(response.status).toBe(400);
      const result = await response.json() as { status: string; rows: unknown[]; error: { code: string } };
      expect(result.status).toBe("unavailable");
      expect(result.rows).toEqual([]);
      expect(result.error.code).toBe("invalid_request");
    }
  });

  test("restart rotates epoch and preserves fail-closed state", async () => {
    const { directory, service } = setup();
    const before = await service.getState();
    await service.signOut({ expectedRevision: before.revision, accountEpoch: before.accountEpoch });
    const previous = await service.getState();
    const restarted = createRaceIqOnlineService({ storage: new OnlineStateStorage(directory), keystore: isolatedKeystore(), adapter: {
      async getPolicy() { throw new Error("test offline"); },
      async getLeaderboard() { throw new Error("test offline"); },
    } });
    const state: OnlineState = await restarted.getState();
    expect(state.accountEpoch).not.toBe(previous.accountEpoch);
    expect(state.uploadAllowed).toBe(false);
    expect(state.preferences).toBeNull();
    const rejected = await restarted.signOut({ expectedRevision: previous.revision, accountEpoch: previous.accountEpoch });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("stale_state");
  });
  test("connect accepts auth context only and rejects consent or preference payloads", async () => {
    const { service } = setup();
    const state = await service.getState();
    const port = {
      ...service,
      async connect() {
        return { ok: true as const, state, authorizationUrl: "https://auth.example.test", flowId: "flow" };
      },
    };
    const routes = createOnlineRoutes(port);
    const body = { expectedRevision: state.revision, accountEpoch: state.accountEpoch };
    const accepted = await command(routes, "/api/online/connect", body);
    expect(accepted.status).toBe(202);
    const invalid = await command(routes, "/api/online/connect", {
      ...body,
      acceptedPolicyVersions: { termsVersion: "current", privacyVersion: "current" },
      preferences: { visibility: "public", setupUploads: true },
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as OnlineCommandResult).ok).toBe(false);
  });

  test("unavailable policy keeps uploads blocked until explicit consent and confirmed preferences", async () => {
    const { service, routes } = setup();
    const response = await routes.request("http://localhost/api/online/state");
    const state = await response.json() as OnlineState;
    expect(response.status).toBe(200);
    expect(state.policy.status).toBe("unavailable");
    expect(state.uploadAllowed).toBe(false);
    expect(state.preferences).toBeNull();
    expect(state.consent.status).toBe("not_accepted");
    expect((await service.getState()).uploadAllowed).toBe(false);
  });
  test("loopback OAuth callback rejects unexpected hosts and never reflects callback data", async () => {
    const { routes } = setup();
    const callback = "http://127.0.0.1:3117/api/online/auth/callback?code=secret-code&raceiq_auth_nonce=secret-nonce";
    const rejectedHost = await routes.request(callback, {
      headers: { Host: "attacker.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(rejectedHost.status).toBe(400);
    expect(await rejectedHost.text()).not.toContain("secret-code");

    const noPendingFlow = await routes.request(callback, { headers: { Host: "127.0.0.1:3117", "Sec-Fetch-Site": "cross-site" } });
    expect(noPendingFlow.status).toBe(400);
    const response = await noPendingFlow.text();
    expect(response).not.toContain("secret-code");
    expect(response).not.toContain("secret-nonce");
    expect(noPendingFlow.headers.get("Cache-Control")).toBe("no-store");
    expect(noPendingFlow.headers.get("Referrer-Policy")).toBe("no-referrer");
    const policy = noPendingFlow.headers.get("Content-Security-Policy")!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    const nonce = policy.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(response).toContain(`<script nonce="${nonce}">`);
  });
});
