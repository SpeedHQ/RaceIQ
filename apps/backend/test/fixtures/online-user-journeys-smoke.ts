import assert from "node:assert/strict";
import { createRaceIqOnlineService, type OnlineAuthSession } from "@raceiq/online/server/service";
import { OnlineStateStorage } from "@raceiq/online/server/state-storage";
import type { OnlineCommandResult, OnlineState, UploadPage } from "@raceiq/online/contracts";
import { readLapUploadItems } from "@raceiq/backend-core/db/online-upload-queries";
import { closeBindingStorage } from "@raceiq/online/server/binding-storage";
import { initDb, closeDb } from "@raceiq/backend-core/db/index";
import { getOnlineLapUploadStatus } from "@raceiq/backend-core/db/online-upload-queries";
import { claimLocalAccountOwner,getLocalAccountOwner,getLocalGameBindingSnapshot,upsertLocalGameBinding } from "@raceiq/backend-core/db/local-account-queries";
import { buildLocalDriverSummary } from "@raceiq/backend-core/driver-summary/index";
import { validateNativeDriverBinding } from "@raceiq/backend-core/lap-detection/native-attribution";
import { closeDashboardReadDatabase } from "@raceiq/backend-core/db/dashboard-queries";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { createOnlineApplicationRoutes } from "@raceiq/online/server/routes";
import { createOnlineLocalPort } from "@raceiq/online/server/local";
import type { NativeBindingProof,OnlineWorkerPort } from "@raceiq/online/server/worker-protocol";

// Parent supplies DATA_DIR before module initialization. Never open a user's DB.
assert.ok(process.env.DATA_DIR && process.env.RACEIQ_TEST_MODE === "1");
await initDb();
const owner = "journey-owner";
const versions = { termsVersion: "journey-terms", privacyVersion: "journey-privacy" };
const session: OnlineAuthSession = { userId: owner, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() / 1000 + 3600, discordAccountName: "Journey Driver" };
let resolveSignIn: ((value: OnlineAuthSession) => void) | undefined;
let secret = "", accepted = false;
let preferences = { visibility: "private" as "private" | "public", setupUploads: false };
let displayName = "Journey Driver";
const service = createRaceIqOnlineService({
  storage: new OnlineStateStorage(process.env.DATA_DIR),
  keystore: { getSecret: async () => secret, setSecret: async (_key, value) => { secret = value; } },
  auth: {
    beginSignIn: async () => ({ authorizationUrl: "https://identity.example/authorize", expiresAt: Date.now() + 60_000, cancel() {}, complete: async () => new Promise<OnlineAuthSession>(resolve => { resolveSignIn = resolve; }) }),
    refreshSession: async () => session,
  },
  onAccountConnected: async (id, isCurrent) => { await claimLocalAccountOwner(id, { isCurrent }); },
  getUploadStatus:async accountId=>({...await getOnlineLapUploadStatus(accountId),inFlight:0,lastError:null}),
  recordingProducer: async () => { throw new Error("HTTP read fixture must not prepare native recordings"); },
  adapter: {
    getPolicy: async () => ({ available: true, ...versions, termsUrl: "https://example.test/terms", privacyUrl: "https://example.test/privacy" }),
    getMe: async () => ({ userId: owner, displayName, avatarUrl: null }),
    getConsent: async () => ({ accepted, currentAcceptance: accepted ? { ...versions, acceptedAt: "2026-01-01T00:00:00Z" } : null, policy: { available: true, ...versions, termsUrl: "https://example.test/terms", privacyUrl: "https://example.test/privacy" } }),
    acceptConsent: async () => { accepted = true; return { acceptedAt: "2026-01-01T00:00:00Z" }; },
    getPreferences: async () => preferences,
    setPreferences: async input => { preferences = { ...input }; return {}; },
    setDisplayName: async name => { displayName = name; return { userId: owner, displayName, avatarUrl: null }; },
    getLeaderboard: async () => ({ status: "ready", rows: [{ rank: 1, lapId: "cloud-lap", lapGuid: "019b0000-0000-7000-8000-000000000001", driver: { userId: "other-driver", displayName: "Other Driver", avatarUrl: null }, lapTimeMs: 90000, importAvailable: true }], fetchedAt: "2026-01-01T00:00:00Z", stale: false }),
  },
});
let candidateConsumed = false;
const proof: NativeBindingProof = { candidateId: "native-candidate", gameId: "lmu", sourceKind: "lmu-shared-memory-player-scoring", nativeIdentity: JSON.stringify({ schemaVersion: 1, actorId: "lmu-control:0", bindingScope: "installation" }), expiresAt: new Date(Date.now() + 60_000).toISOString(), bindingRevision: 0, sourceRevision: 1 };
const local = createOnlineLocalPort(service, {
  listCandidates: async () => ({ sourceRevision: 1, candidates: [] }),
  resolveCandidate: async id => id === proof.candidateId && !candidateConsumed ? proof : null,
  isCurrent: () => !candidateConsumed,
  consumeCandidate: async () => { candidateConsumed = true; },
}, {
  readLapUploadItems,
  getLocalAccountOwner,
  getLocalGameBindingSnapshot,
  upsertLocalGameBinding,
  validateNativeDriverBinding,
});
const unused = async (): Promise<never> => { throw new Error("Unused fixture operation"); };
const port: OnlineWorkerPort = { ...service, ...local, getLocalSummary: buildLocalDriverSummary, importRequest: unused, dispatchCloudLapImport: unused, wake: unused, stop: unused };
const routes = createOnlineApplicationRoutes(service,port);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch });
const base = `http://127.0.0.1:${server.port}`;
const state = async () => (await fetch(base + "/api/online/state")).json() as Promise<OnlineState>;
const context = async () => { const current = await state(); return { accountEpoch: current.accountEpoch, expectedRevision: current.revision }; };
const mutate = async (path: string, body: object = {}, method = "PUT") => fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...await context(), ...body }) });
const query = async (path: string, extra: Record<string, string> = {}) => fetch(`${base}${path}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(await context()).map(([key, value]) => [key, String(value)])), ...extra })}`);
let passed = 0;
async function journey(id: string, kind: "happy" | "fail", run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${id} ${kind}`); }
try {
  await journey("D01", "fail", async () => {
    const connected = await mutate("/api/online/connect", {}, "POST"); assert.equal(connected.status, 202);
    const flow = await connected.json() as { flowId: string };
    assert.equal((await mutate("/api/online/connect/cancel", { flowId: flow.flowId }, "POST")).status, 200);
    assert.equal((await state()).connection.status, "signed_out");
  });
  await journey("D01", "happy", async () => {
    assert.equal((await mutate("/api/online/connect", {}, "POST")).status, 202);
    const callback = service.handleAuthCallback("http://127.0.0.1:3117/api/online/auth/callback?code=fixture");
    assert.ok(resolveSignIn); resolveSignIn(session); await callback;
    const connected = await state(); assert.equal(connected.connection.status, "connected");
    assert.ok(connected.connection.status === "connected"); assert.equal(connected.connection.account.userId, owner); assert.equal(connected.uploadAllowed, false);
  });
  await journey("D02", "happy", async () => {
    assert.equal((await mutate("/api/online/consent", { acceptedPolicyVersions: versions })).status, 200);
    assert.equal((await state()).consent.status, "accepted");
  });
  await journey("D02", "fail", async () => {
    const response = await mutate("/api/online/consent", { acceptedPolicyVersions: { ...versions, termsVersion: "stale" } });
    assert.equal(response.status, 409); assert.equal((await response.json() as OnlineCommandResult).ok, false);
  });
  await journey("D03", "happy", async () => {
    assert.equal((await mutate("/api/online/preferences", { preferences: { visibility: "public", setupUploads: false } })).status, 200);
    assert.equal((await state()).uploadAllowed, true);
  });
  await journey("D03", "fail", async () => {
    const response = await mutate("/api/online/preferences", { accountEpoch: "previous-account", preferences: { visibility: "private", setupUploads: false } });
    assert.equal(response.status, 409); assert.equal((await state()).preferences?.visibility, "public");
  });
  await journey("D04", "happy", async () => {
    assert.equal((await mutate("/api/online/profile", { displayName: "Updated Driver" })).status, 200);
    const current = await state(); assert.ok(current.connection.status === "connected"); assert.equal(current.connection.account.displayName, "Updated Driver");
  });
  await journey("D04", "fail", async () => {
    assert.equal((await mutate("/api/online/profile", { displayName: " " })).status, 400);
    const current = await state(); assert.ok(current.connection.status === "connected"); assert.equal(current.connection.account.displayName, "Updated Driver");
  });
  await journey("D05", "happy", async () => {
    const result = await mutate("/api/driver-bindings", { candidateId: proof.candidateId, confirmedByUser: true });
    assert.equal(result.status, 200);
    const snapshot = await (await fetch(base + "/api/driver-bindings")).json() as { bindings: Array<{ gameId: string; nativeIdentity: string }> };
    assert.deepEqual(snapshot.bindings.map(binding => [binding.gameId, binding.nativeIdentity]), [[proof.gameId, proof.nativeIdentity]]);
  });
  await journey("D05", "fail", async () => {
    const response = await mutate("/api/driver-bindings", { candidateId: proof.candidateId, confirmedByUser: true });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "driver_identity_required");
  });
  await journey("D06", "happy", async () => {
    const queue = await (await query("/api/online/uploads", { view: "queue" })).json() as UploadPage;
    const history = await (await query("/api/online/uploads", { view: "history" })).json() as UploadPage;
    assert.deepEqual(queue.items, []); assert.deepEqual(history.items, []);
  });
  await journey("D06", "fail", async () => {
    const response = await query("/api/online/uploads", { view: "history", accountEpoch: "previous-account" });
    assert.equal(response.status, 409);
  });
  const boardUrl = base + "/api/online/leaderboard?trackId=track&carId=car";
  await journey("D08", "happy", async () => {
    const response = await fetch(boardUrl, { headers: { "X-Game-Id": "lmu" } }); assert.equal(response.status, 200);
    assert.equal((await response.json() as { rows: Array<{ lapId: string }> }).rows[0]?.lapId, "cloud-lap");
  });
  await journey("D08", "fail", async () => {
    assert.equal((await mutate("/api/online/preferences", { preferences: { visibility: "private", setupUploads: false } })).status, 200);
    const response = await fetch(boardUrl, { headers: { "X-Game-Id": "lmu" } });
    const board = await response.json() as { rows: unknown[]; error: { code: string } };
    assert.deepEqual(board.rows, []); assert.equal(board.error.code, "sharing_required");
  });
  await journey("D09", "fail", async () => { assert.equal((await mutate("/api/online/sign-out", { accountEpoch: "previous-account" }, "POST")).status, 409); assert.equal((await state()).connection.status, "connected"); });
  await journey("D09", "happy", async () => {
    assert.equal((await mutate("/api/online/sign-out", {}, "POST")).status, 200);
    assert.equal((await state()).connection.status, "signed_out"); assert.equal(secret, "");
  });
  assert.equal(passed, 16);
} finally {
  service.stopAdmission();
  await server.stop(true);
  stopMaintenanceTasks();
  closeDashboardReadDatabase();
  await closeBindingStorage();
  closeDb();
}
// Match the existing auth smoke: application sign-in expiry timers live for ten minutes.
// All assertions and owned I/O cleanup above must finish before ending this child process.
process.exit(0);
