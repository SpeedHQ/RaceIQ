import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOnlineRoutes, type OnlineRoutes } from "../../src/routes/online-routes";
import { createRaceIqOnlineService } from "@raceiq/backend-core/integrations/raceiq-online/service";
import { OnlineStateStorage } from "@raceiq/backend-core/db/online-state-storage";
import { OnlineAdapterError } from "@raceiq/backend-core/integrations/raceiq-online/adapter";
import type { OnlineState, OnlineCommandResult } from "@raceiq/shared/integrations/raceiq-online";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-online-routes-"));
  directories.push(directory);
  const service = createRaceIqOnlineService({ storage: new OnlineStateStorage(directory), adapter: {
    async getPolicy() { throw new Error("test offline"); },
    async getLeaderboard() { throw new Error("test offline"); },
  } });
  return { directory, service, routes: createOnlineRoutes(service) };
}

async function command(routes: OnlineRoutes, path: string, body: unknown, headers: Record<string, string> = {}) {
  return routes.request(`http://localhost${path}`, { method: path.includes("preferences") || path.includes("consent") ? "PUT" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
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
    const restarted = createRaceIqOnlineService({ storage: new OnlineStateStorage(directory), adapter: {
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
  test("policy version mismatch never creates connection or accepts consent", async () => {
    const { directory } = setup();
    const service = createRaceIqOnlineService({ storage: new OnlineStateStorage(directory), adapter: {
      async getPolicy() { return { available: true, termsVersion: "current", privacyVersion: "current", termsUrl: "https://example.test/terms", privacyUrl: "https://example.test/privacy" }; },
      async getLeaderboard() { throw new Error("test offline"); },
    } });
    const state = await service.getState();
    const result = await service.connect({
      expectedRevision: state.revision, accountEpoch: state.accountEpoch,
      acceptedPolicyVersions: { termsVersion: "obsolete", privacyVersion: "obsolete" },
      preferences: { visibility: "public", setupUploads: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_changed");
    expect(result.state.accountEpoch).toBe(state.accountEpoch);
    expect(result.state.consent.status).toBe("not_accepted");
    expect(result.state.uploadAllowed).toBe(false);
    expect(result.state.connection.status).toBe("signed_out");
  });

  test("public-board failure preserves cached rows, original fetch time and isolation", async () => {
    const { directory } = setup();
    let unavailable = false;
    const fetchedAt = "2026-10-12T00:00:00.000Z";
    const service = createRaceIqOnlineService({ storage: new OnlineStateStorage(directory), adapter: {
      async getPolicy() { throw new Error("test offline"); },
      async getLeaderboard() {
        if (unavailable) throw new Error("test unavailable");
        return { status: "ready", rows: [{ rank: 1, lapId: "public-lap", driver: { userId: "public-driver", displayName: "Driver", avatarUrl: null }, lapTimeMs: 90_123 }], fetchedAt, stale: false };
      },
    } });
    const key = { gameId: "f1-2025", trackId: "track-a", carId: "car-a" };
    const first = await service.getLeaderboard(key);
    first.rows[0]!.driver.displayName = "mutated caller";
    unavailable = true;
    const cached = await service.getLeaderboard(key);
    expect(cached.rows[0]!.driver.displayName).toBe("Driver");
    expect(cached.fetchedAt).toBe(fetchedAt);
    expect(cached.stale).toBe(true);
    expect(cached.status).toBe("ready");
    expect(cached.error?.code).toBe("service_unavailable");
    const otherCar = await service.getLeaderboard({ ...key, carId: "car-b" });
    expect(otherCar.status).toBe("unavailable");
    expect(otherCar.rows).toEqual([]);
    expect((await service.getState()).uploadAllowed).toBe(false);
  });
  test("healthy service with unavailable policies remains healthy and blocks consent-dependent actions", async () => {
    const { directory } = setup();
    const service = createRaceIqOnlineService({ storage: new OnlineStateStorage(directory), adapter: {
      async getPolicy() { throw new OnlineAdapterError("policy_unavailable", false); },
      async getLeaderboard() { throw new Error("unused"); },
    } });
    const routes = createOnlineRoutes(service);
    const response = await routes.request("http://localhost/api/online/state");
    const state = await response.json() as OnlineState;
    expect(response.status).toBe(200);
    expect(state.service).toBe("available");
    expect(state.policy).toEqual({ status: "unavailable", error: { code: "policy_unavailable", retryable: false, retryAfter: null } });
    expect(state.uploadAllowed).toBe(false);
    const connectResponse = await command(routes, "/api/online/connect", {
      expectedRevision: state.revision, accountEpoch: state.accountEpoch,
      acceptedPolicyVersions: { termsVersion: "unconfigured", privacyVersion: "unconfigured" },
      preferences: { visibility: "public", setupUploads: false },
    });
    expect(connectResponse.status).toBe(503);
    const connect = await connectResponse.json() as OnlineCommandResult;
    expect(connect.ok).toBe(false);
    if (!connect.ok) expect(connect.error.code).toBe("policy_unavailable");
    expect(connect.state.connection.status).toBe("signed_out");
    expect(connect.state.uploadAllowed).toBe(false);
  });
  test("loopback OAuth callback rejects unexpected hosts and never reflects callback data", async () => {
    const { routes } = setup();
    const callback = "http://127.0.0.1:3117/api/online/auth/callback?code=secret-code&raceiq_auth_nonce=secret-nonce";
    const rejectedHost = await routes.request(callback, {
      headers: { Host: "attacker.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(rejectedHost.status).toBe(400);
    expect(await rejectedHost.text()).not.toContain("secret-code");

    const noPendingFlow = await routes.request(callback, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(noPendingFlow.status).toBe(400);
    const response = await noPendingFlow.text();
    expect(response).not.toContain("secret-code");
    expect(response).not.toContain("secret-nonce");
  });
});
