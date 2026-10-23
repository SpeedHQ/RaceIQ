import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, writeFile, cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createServer } from "node:http";
import Database from "libsql";
import { decompressIfGzipSync, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";

const desktopRoot = join(import.meta.dir, "../../../..");
const cloudRoot = process.env.RACEIQ_CLOUD_ROOT;
const sourceData = process.env.RACEIQ_UPLOAD_SOURCE_DATA_DIR;
const certFile = process.env.RACEIQ_UPLOAD_TEST_CERT;
const keyFile = process.env.RACEIQ_UPLOAD_TEST_KEY;
const udpFixture = process.env.RACEIQ_UPLOAD_UDP_OVERLOAD_FIXTURE ?? "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz";
assert.ok(cloudRoot && sourceData && certFile && keyFile, "Cloud root, read-only native source, and disposable test TLS certificate/key are required");
const sourceReal = await realpath(sourceData);
assert.ok(sourceReal.startsWith(`${await realpath(tmpdir())}${sep}`), "Refuse native source data outside temporary storage");
const temporary = await mkdtemp(join(tmpdir(), "raceiq-upload-lifecycle-"));
const ownerDb = new Database(join(sourceReal, "app.db"), { readonly: true });
const owner = ownerDb.query<{ id: string | null }, []>("SELECT online_user_id AS id FROM local_account_owner WHERE id=1").get()?.id;
assert.ok(owner, "Native source must retain original account owner");
const sourceSessions = ownerDb.query<{ id: number; gameId: string; owner: string; activityId: string; sourceRevision: string; rawFile: string | null; manifest: string | null; archive: string | null }, []>(
  `SELECT id,game_id AS gameId,owner_user_id AS owner,original_activity_id AS activityId,original_source_revision AS sourceRevision,
    raw_file AS rawFile,capture_manifest_file AS manifest,capture_archive_file AS archive FROM sessions
   WHERE native_capture_origin=1 AND original_activity_id IS NOT NULL ORDER BY id`).all();
const sourceLaps = ownerDb.query<{ sessionId: number; lapId: number; guid: string; lapTime: number; valid: number; attribution: string | null }, []>(
  `SELECT l.session_id AS sessionId,l.id AS lapId,l.lap_guid AS guid,l.lap_time AS lapTime,l.is_valid AS valid,l.driver_attribution AS attribution
   FROM laps l JOIN sessions s ON s.id=l.session_id WHERE s.native_capture_origin=1 ORDER BY l.session_id,l.id`).all();
ownerDb.close();
const expectedBest = new Map<string, { lapId: number; guid: string; lapTime: number }>();
// The expected selections come from the immutable source snapshot, not fabricated candidate rows.
const sourceSnapshot = new Database(join(sourceReal, "app.db"), { readonly: true });
for (const lap of sourceLaps) {
  const session = sourceSessions.find(item => item.id === lap.sessionId);
  if (!session || session.gameId !== "f1-2025" || lap.valid !== 1 || lap.attribution !== "Self" || !lap.guid) continue;
  const board = sourceSnapshot.query<{ track: string; car: string }, [number]>("SELECT track_id AS track,car_id AS car FROM sessions WHERE id=?").get(lap.sessionId);
  if (!board?.track || !board.car) continue;
  const key = JSON.stringify([session.gameId, board.track, board.car]);
  const prior = expectedBest.get(key);
  if (!prior || lap.lapTime < prior.lapTime) expectedBest.set(key, { lapId: lap.lapId, guid: lap.guid, lapTime: lap.lapTime });
}
sourceSnapshot.close();
assert.ok(expectedBest.size > 0, "Native source must contain at least one original valid Self lap");

const children = new Set<Bun.Subprocess>();
const logs = new Map<Bun.Subprocess, string>();
function start(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR!, ...env }, stdout: "pipe", stderr: "pipe" });
  children.add(child); logs.set(child, "");
  void (async () => { for await (const line of child.stdout) logs.set(child, logs.get(child)! + new TextDecoder().decode(line)); })();
  void (async () => { for await (const line of child.stderr) logs.set(child, logs.get(child)! + new TextDecoder().decode(line)); })();
  return child;
}
async function stop(child?: Bun.Subprocess) { if (!child) return; if (child.exitCode === null) child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5_000); try { await child.exited; } finally { clearTimeout(timer); children.delete(child); } }
async function ready(url: string) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) { try { if ((await fetch(url)).status === 200) return; } catch {} await Bun.sleep(100); }
  throw new Error(`Timed out waiting for ${url}`);
}
async function freePort() {
  const probe = createServer(), listening = Promise.withResolvers<void>(); probe.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = probe.address(); assert.ok(address && typeof address === "object");
  const closed = Promise.withResolvers<void>(); probe.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise; return address.port;
}
const codes = new Map<string, { challenge: string; userId: string }>(), tokens = new Map<string, string>();
const betaOwner = "b2345678-1234-5678-9abc-def012345678";
let betaPort: number | undefined;
const refreshRequiredAtReservation = process.env.RACEIQ_UPLOAD_RESERVATION_RESTRICTION === "refresh_required";
let lastIssuedTokenExpiresAt = 0, refreshRejections = 0;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
let providerBase = "", authOrigin = "", apiBase = "", appBase = "";
const provider = async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname === "/auth/v1/authorize") {
    const callback = new URL(url.searchParams.get("redirect_to")!);
    if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.pathname !== "/api/online/auth/callback") return new Response(null, { status: 400 });
    const userId = callback.port === String(betaPort) ? betaOwner : owner;
    const code = randomUUID(); codes.set(code, { challenge: url.searchParams.get("code_challenge")!, userId }); callback.searchParams.set("code", code); return Response.redirect(callback.href, 302);
  }
  if (url.pathname === "/auth/v1/token") {
    const body = await request.json() as { auth_code?: string; code_verifier?: string; refresh_token?: string };
    let userId: string | undefined;
    if (url.searchParams.get("grant_type") === "pkce") {
      const authorization = codes.get(body.auth_code ?? ""); codes.delete(body.auth_code ?? "");
      if (!authorization || createHash("sha256").update(body.code_verifier ?? "").digest("base64url") !== authorization.challenge) return new Response(null, { status: 400 });
      userId = authorization.userId;
    } else {
      if (refreshRequiredAtReservation && heldReservation) {
        await Bun.sleep(Math.max(0, (lastIssuedTokenExpiresAt - 60) * 1000 - Date.now() + 100));
        refreshRejections++;
        return Response.json({ error: "invalid_grant", error_description: "Isolated refresh rejected" }, { status: 401 });
      }
      userId = body.refresh_token === `r03-local-refresh-${owner}` ? owner : body.refresh_token === `r03-local-refresh-${betaOwner}` ? betaOwner : undefined;
      if (!userId) return new Response(null, { status: 401 });
    }
    const lifetime = refreshRequiredAtReservation ? 66 : 3600;
    lastIssuedTokenExpiresAt = Math.floor(Date.now() / 1000) + lifetime;
    const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: `${providerBase}/auth/v1`, aud: "authenticated", role: "authenticated", sub: userId, exp: lastIssuedTokenExpiresAt, session_id: randomUUID() })}.isolated-signature`;
    tokens.set(accessToken, userId); return Response.json({ access_token: accessToken, refresh_token: `r03-local-refresh-${userId}`, token_type: "bearer", expires_in: lifetime, user: { id: userId, user_metadata: { name: userId === owner ? "R03 Alpha owner" : "R03 Beta owner" }, identities: [] } });
  }
  const userId = tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  return userId && url.pathname === "/auth/v1/user" ? Response.json({ id: userId, user_metadata: { name: userId === owner ? "R03 Alpha owner" : "R03 Beta owner" }, identities: [] }) : new Response(null, { status: 401 });
};
const cert = await readFile(certFile, "utf8"), key = await readFile(keyFile, "utf8");
const plainProvider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: provider }); providerBase = `http://127.0.0.1:${plainProvider.port}`;
const tlsProvider = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key }, fetch: provider }); authOrigin = `https://127.0.0.1:${tlsProvider.port}`;
const apiPort = await freePort(), appPort = await freePort(), udpPort = await freePort(), metricsPort = await freePort();
betaPort = await freePort();
apiBase = `http://127.0.0.1:${apiPort}`; appBase = `http://127.0.0.1:${appPort}`;
let reservationGuids: string[] = [], multipartBodies = 0, attachedSetups = 0;
const multipartLapGuids: string[] = [];
const multipartReservationCounts: number[] = [];
const sharingReservationBarrier = process.env.RACEIQ_UPLOAD_SHARING_RESERVATION_BARRIER === "1";
const reservationReached = Promise.withResolvers<void>();
const releaseReservation = Promise.withResolvers<void>();
let heldReservation = false;
let heldReservationSignal: AbortSignal | null = null;
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url); const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer();
  if (url.pathname.includes("reservations") && body) {
    try { const parsed = JSON.parse(new TextDecoder().decode(body)) as { lapGuid?: string }; if (parsed.lapGuid) reservationGuids.push(parsed.lapGuid); } catch {}
  }
  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data") && body) {
    const lapGuid = url.searchParams.get("lapGuid");
    assert.ok(lapGuid, "Native multipart request must identify its logical lap");
    multipartLapGuids.push(lapGuid);
    multipartReservationCounts.push(reservationGuids.filter(guid => guid === lapGuid).length);
    multipartBodies++; if (new TextDecoder().decode(body).includes('name="setup"')) attachedSetups++;
  }
  const headers = new Headers(request.headers);
  for (const name of ["host", "connection", "transfer-encoding"]) headers.delete(name);
  if (headers.get("origin") === proxyBase) headers.set("origin", apiBase);
  const response = await fetch(`${apiBase}${url.pathname}${url.search}`, { method: request.method, headers, ...(body ? { body } : {}), redirect: "error" });
  if (sharingReservationBarrier && !heldReservation && request.method === "POST" && url.pathname.includes("reservations") && response.status === 201) {
    heldReservation = true;
    heldReservationSignal = request.signal;
    reservationReached.resolve();
    await releaseReservation.promise;
  }
  return response;
} });
const proxyBase = `http://127.0.0.1:${proxy.port}`;
const policy = { RACEIQ_TERMS_VERSION: "r03-terms", RACEIQ_PRIVACY_VERSION: "r03-privacy", RACEIQ_TERMS_URL: "https://example.test/terms", RACEIQ_PRIVACY_URL: "https://example.test/privacy" };
let cloud: Bun.Subprocess | undefined, processor: Bun.Subprocess | undefined, desktop: Bun.Subprocess | undefined, betaDesktop: Bun.Subprocess | undefined, cloudDb: Database | undefined, passed = false, preserveEvidenceClone = false;
const caseOutcomes: Record<string, unknown> = {};
async function cloneSource() {
  const destination = join(temporary, "device"); await mkdir(destination, { recursive: true });
  const source = new Database(join(sourceReal, "app.db"), { readonly: true }); try { await writeFile(join(destination, "app.db"), source.serialize()); } finally { source.close(); }
  await cp(join(sourceReal, "sessions"), join(destination, "sessions"), { recursive: true });
  await cp(join(sourceReal, "settings.json"), join(destination, "settings.json"));
  const sourceBindings = join(sourceReal, "raceiq-online-bindings.db");
  if (existsSync(sourceBindings)) await cp(sourceBindings, join(destination, "raceiq-online-bindings.db"));
  const db = new Database(join(destination, "app.db"));
  try { for (const column of ["raw_file", "capture_manifest_file", "capture_archive_file"]) {
    for (const row of db.query<{ id: number; path: string }, []>(`SELECT id,${column} AS path FROM sessions WHERE ${column} IS NOT NULL`).all()) {
      const canonical = await realpath(row.path); assert.ok(canonical.startsWith(`${sourceReal}${sep}`), "Source capture path must remain within immutable native source");
      db.query(`UPDATE sessions SET ${column}=? WHERE id=?`).run(join(destination, relative(sourceReal, canonical)), row.id);
    }
  } } finally { db.close(); }
  const bindingsPath = join(destination, "raceiq-online-bindings.db");
  if (existsSync(bindingsPath)) {
    const bindings = new Database(bindingsPath);
    try { bindings.query("DELETE FROM registered_bindings").run(); } finally { bindings.close(); }
  }
  return destination;
}
type LocalClient = (path: string, method?: string, body?: unknown) => Promise<{ status: number; data: any; cookie: string }>;
function localClient(baseUrl = appBase): LocalClient {
  let cookie = "", csrf = "";
  return async (path: string, method = "GET", body?: unknown) => {
    const form = body instanceof FormData;
    const response = await fetch(baseUrl + path, { method, headers: { Origin: baseUrl, ...(!form ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-RaceIQ-CSRF": csrf } : {}) }, ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    csrf = response.headers.get("x-raceiq-csrf") ?? csrf; return { status: response.status, data: await response.json(), cookie };
  };
}
function onlineStateSummary(state: any) {
  return {
    revision: state.revision, accountEpoch: state.accountEpoch, service: state.service,
    connection: { status: state.connection.status, userId: state.connection.status === "connected" ? state.connection.account.userId : null },
    policy: state.policy, consent: state.consent, preferences: state.preferences,
    persistedPreferences: state.persistedPreferences, preferencePersistence: state.preferencePersistence,
    uploadAllowed: state.uploadAllowed, sync: state.sync,
  };
}
async function ensureOnline(local: LocalClient, expectedUserId = owner) {
  const before = (await local("/api/online/state")).data;
  let state = before;
  if (state.connection.status !== "connected" || state.sync.blockedBy === "signed_out" || state.sync.blockedBy === "account_unavailable") {
    const connect = await local("/api/online/connect", "POST", { expectedRevision: state.revision, accountEpoch: state.accountEpoch });
    assert.equal(connect.status, 202, JSON.stringify({ state: onlineStateSummary(state), connect: connect.data }));
    const authorization = new URL(connect.data.authorizationUrl);
    const redirect = await fetch(authorization, { redirect: "manual", tls: { ca: cert } });
    assert.equal(redirect.status, 302);
    assert.equal((await fetch(redirect.headers.get("location")!, { headers: { Cookie: connect.cookie }, redirect: "error" })).status, 200);
    state = (await local("/api/online/state")).data;
  }
  assert.equal(state.policy.status, "available", JSON.stringify(onlineStateSummary(state)));
  assert.equal(state.connection.status, "connected", JSON.stringify(onlineStateSummary(state)));
  assert.equal(state.connection.account.userId, expectedUserId);
  const policyVersions = state.policy.versions;
  if (state.consent.status !== "accepted" || state.consent.versions.termsVersion !== policyVersions.termsVersion ||
      state.consent.versions.privacyVersion !== policyVersions.privacyVersion) {
    const consent = await local("/api/online/consent", "PUT", { expectedRevision: state.revision, accountEpoch: state.accountEpoch, acceptedPolicyVersions: policyVersions });
    assert.equal(consent.status, 200, JSON.stringify({ state: onlineStateSummary(state), consent: consent.data }));
    state = (await local("/api/online/state")).data;
  }
  if (state.preferencePersistence !== "confirmed" || state.preferences?.visibility !== "public" || state.preferences?.setupUploads !== false) {
    const preferences = await local("/api/online/preferences", "PUT", { expectedRevision: state.revision, accountEpoch: state.accountEpoch, preferences: { visibility: "public", setupUploads: false } });
    assert.equal(preferences.status, 200, JSON.stringify({ state: onlineStateSummary(state), preferences: preferences.data }));
    state = (await local("/api/online/state")).data;
  }
  assert.equal(state.consent.status, "accepted", JSON.stringify(onlineStateSummary(state)));
  assert.deepEqual(state.consent.versions, policyVersions);
  assert.equal(state.preferencePersistence, "confirmed", JSON.stringify(onlineStateSummary(state)));
  assert.deepEqual(state.preferences, { visibility: "public", setupUploads: false });
  assert.equal(state.uploadAllowed, true, JSON.stringify(onlineStateSummary(state)));
  assert.equal(state.sync.blockedBy, null, JSON.stringify(onlineStateSummary(state)));
  return { before: onlineStateSummary(before), state, after: onlineStateSummary(state) };
}
async function cloneSnapshot(data: string) {
  const db = new Database(join(data, "app.db"), { readonly: true });
  try { return db.query(`SELECT s.id,s.game_id,s.car_id,s.track_id,s.owner_user_id,s.original_activity_id,s.original_source_revision,s.created_at,
    l.id AS lap_id,l.lap_guid,l.lap_time,l.recorded_at,l.is_valid,l.driver_attribution FROM sessions s JOIN laps l ON l.session_id=s.id
    WHERE s.native_capture_origin=1 ORDER BY s.id,l.id`).all(); } finally { db.close(); }
}
function readUploadLedger(data: string) {
  const db = new Database(join(data, "raceiq-online-outbox.db"), { readonly: true });
  try {
    const rows = db.query<{ rowId: number; identityJson: string | null; status: string; attempts: number; validation: string; publication: string; remoteJobId: string | null }, []>(
      `SELECT row_id AS rowId,identity_json AS identityJson,status,attempts,validation_status AS validation,
        publication_status AS publication,remote_job_id AS remoteJobId
       FROM raceiq_online_outbox ORDER BY row_id`).all();
    return rows.map(({ identityJson, ...row }) => {
      const identity: unknown = identityJson ? JSON.parse(identityJson) : null;
      const lapGuid = identity && typeof identity === "object" && "lapGuid" in identity && typeof identity.lapGuid === "string" ? identity.lapGuid : null;
      return { ...row, lapGuid };
    });
  } finally { db.close(); }
}
async function awaitCaptureSettlement(local: LocalClient, data: string, guid: string) {
  const deadline = Date.now() + 180_000;
  let stable = 0, previous = "", latest: any;
  while (Date.now() < deadline) {
    const state = (await local("/api/online/state")).data;
    const context = `accountEpoch=${encodeURIComponent(state.accountEpoch)}&expectedRevision=${state.revision}&limit=100`;
    const [queue, history] = await Promise.all([
      local(`/api/online/uploads?view=queue&${context}`),
      local(`/api/online/uploads?view=history&${context}`),
    ]);
    assert.equal(queue.status, 200, JSON.stringify(queue.data));
    assert.equal(history.status, 200, JSON.stringify(history.data));
    const captureQueue = queue.data.items.filter((item: { kind: string; lapGuid?: string | null }) => item.kind === "lap" && item.lapGuid === guid);
    const captureHistory = history.data.items.filter((item: { kind: string; lapGuid?: string | null }) => item.kind === "lap" && item.lapGuid === guid);
    const ledgerAll = readUploadLedger(data), captureLedger = ledgerAll.filter(row => row.lapGuid === guid);
    const capturePublic = cloudDb!.query<Record<string, unknown>, [string]>(
      "SELECT * FROM laps WHERE publication_status='public' AND lap_guid=?").all(guid);
    const reservations = reservationGuids.filter(item => item === guid).length;
    const activeLedger = ledgerAll.filter(row => ["pending", "dispatching", "ambiguous"].includes(row.status));
    latest = {
      state: onlineStateSummary(state), queue: captureQueue, history: captureHistory, ledger: captureLedger, ledgerAll,
      publicRows: capturePublic, publicCount: cloudDb!.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM laps WHERE publication_status='public'").get()!.count,
      reservations, reservationCount: reservationGuids.length, multipartBodies, attachedSetups,
    };
    const settled = state.sync.status === "idle" && state.sync.queued === 0 && state.sync.inFlight === 0 &&
      captureQueue.length === 0 && activeLedger.length === 0;
    const fingerprint = JSON.stringify(latest);
    stable = settled && fingerprint === previous ? stable + 1 : 0;
    if (stable >= 8) return latest;
    previous = fingerprint;
    await Bun.sleep(500);
  }
  throw new Error(`Capture upload did not settle: ${JSON.stringify(latest)}`);
}
async function verifyDeletedSourceReservationBarrier(local: LocalClient, data: string, original: unknown) {
  const targetGuid = reservationGuids.at(-1);
  const target = sourceLaps.find(lap => lap.guid === targetGuid);
  assert.ok(target && targetGuid, "Held reservation must belong to a genuine source lap");
  const deleted = await local(`/api/laps/${target.lapId}`, "DELETE");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.success, true);
  releaseReservation.resolve();
  const deadline = Date.now() + 30_000;
  let stable = 0, previous = "";
  while (Date.now() < deadline && stable < 4) {
    const state = (await local("/api/online/state")).data;
    const targetLedger = readUploadLedger(data).filter(row => row.lapGuid === targetGuid);
    const fingerprint = JSON.stringify({ inFlight: state.sync.inFlight, targetLedger, targetBodies: multipartLapGuids.filter(guid => guid === targetGuid).length });
    const settled = state.sync.inFlight === 0 && targetLedger.every(row => row.status !== "dispatching");
    stable = settled && fingerprint === previous ? stable + 1 : 0;
    previous = fingerprint;
    if (stable < 4) await Bun.sleep(250);
  }
  assert.equal(stable, 4, "Deleted-source work must reach a settled ledger state");
  assert.equal(multipartLapGuids.filter(guid => guid === targetGuid).length, 0, "Source removed after reservation must not start its binary upload");
  const publication = cloudDb!.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM laps WHERE lap_guid=? AND publication_status='public'").get(targetGuid)!;
  assert.equal(publication.count, 0);
  assert.ok(readUploadLedger(data).filter(row => row.lapGuid === targetGuid).every(row => row.remoteJobId === null));
  assert.ok(Array.isArray(original));
  assert.deepEqual(await cloneSnapshot(data), original.filter(row => row.lap_id !== target.lapId), "Only the explicitly deleted clone lap may disappear; remaining native facts must not change");
  console.log(JSON.stringify({
    scenario: "actual-app-source-deleted-after-reservation", passed: true,
    targetGuid, targetLapId: target.lapId, targetMultipartBodies: 0, targetPublications: 0,
    otherMultipartBodies: multipartLapGuids.filter(guid => guid !== targetGuid).length,
    remainingNativeIdentityUnchanged: true,
    scope: "actual owned-lap DELETE after real reservation; other eligible laps may still transfer",
  }));
}
async function verifyRefreshRequiredReservationBarrier(local: LocalClient, data: string, original: unknown) {
  assert.ok(lastIssuedTokenExpiresAt > 0);
  const freshnessBoundary = (lastIssuedTokenExpiresAt - 60) * 1000;
  await Bun.sleep(Math.max(0, freshnessBoundary - Date.now() + 100));
  const observedAt = Date.now();
  assert.ok(observedAt >= freshnessBoundary, "Credential must cross upload-freshness boundary before release");
  releaseReservation.resolve();
  const deadline = Date.now() + 30_000;
  let stable = 0, previous = "";
  while (Date.now() < deadline && stable < 4) {
    const state = (await local("/api/online/state")).data, ledger = readUploadLedger(data);
    const settled = !state.uploadAllowed && state.sync.blockedBy === "account_unavailable" &&
      state.sync.inFlight === 0 && ledger.every(row => row.status !== "dispatching");
    const fingerprint = JSON.stringify({ ledger, multipartBodies, blockedBy: state.sync.blockedBy });
    stable = settled && fingerprint === previous ? stable + 1 : 0;
    previous = fingerprint;
    if (stable < 4) await Bun.sleep(250);
  }
  assert.equal(stable, 4, "Failed credential renewal must settle without starting binary upload");
  assert.ok(refreshRejections > 0, "Actual provider refresh must reject renewal");
  assert.equal(multipartBodies, 0);
  assert.equal(attachedSetups, 0);
  assert.equal(cloudDb!.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM laps WHERE publication_status='public'").get()!.count, 0);
  assert.ok(readUploadLedger(data).every(row => row.remoteJobId === null));
  assert.deepEqual(await cloneSnapshot(data), original, "Renewal failure must preserve native identity and timestamps");
  console.log(JSON.stringify({
    scenario: "actual-app-refresh-required-after-reservation", passed: true,
    freshnessBoundary, observedAt, refreshRejections, multipartBodies, attachedSetups,
    publishedRows: 0, nativeIdentityUnchanged: true, finalBlockedBy: "account_unavailable",
    scope: "upload credential-renewal window and rejected refresh; not physical JWT expiry",
  }));
}

async function verifyRestoredReservationBarrier(local: LocalClient, data: string, original: unknown) {
  const targetGuid = reservationGuids.at(-1);
  assert.ok(targetGuid);
  const restricted = (await local("/api/online/state")).data;
  assert.equal(restricted.uploadAllowed, false);
  assert.equal(restricted.preferences.visibility, "private");
  const restored = await local("/api/online/preferences", "PUT", {
    expectedRevision: restricted.revision, accountEpoch: restricted.accountEpoch,
    preferences: { visibility: "public", setupUploads: false },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(multipartBodies, 0, "Old reservation must remain held through revoke and restore");
  releaseReservation.resolve();
  const expectedGuids = [...expectedBest.values()].map(row => row.guid).sort();
  const deadline = Date.now() + 180_000;
  let stable = 0, previous = "", publicGuids: string[] = [];
  while (Date.now() < deadline && stable < 4) {
    const state = (await local("/api/online/state")).data, ledger = readUploadLedger(data);
    publicGuids = cloudDb!.query<{ lap_guid: string }, []>("SELECT lap_guid FROM laps WHERE publication_status='public' ORDER BY lap_guid").all().map(row => row.lap_guid);
    const settled = state.uploadAllowed && state.sync.inFlight === 0 &&
      JSON.stringify(publicGuids) === JSON.stringify(expectedGuids) &&
      expectedGuids.every(guid => ledger.some(row => row.lapGuid === guid && row.status === "transmitted" && row.validation === "validated" && row.publication === "public" && row.remoteJobId));
    const fingerprint = JSON.stringify({ ledger, publicGuids, multipartBodies });
    stable = settled && fingerprint === previous ? stable + 1 : 0;
    previous = fingerprint;
    if (stable < 4) await Bun.sleep(250);
  }
  assert.equal(stable, 4, "Fresh authorized uploads must settle after sharing is restored");
  assert.deepEqual(publicGuids, expectedGuids);
  assert.equal(multipartBodies, expectedGuids.length, "Restoration must not duplicate binary uploads");
  const targetTransfers = multipartLapGuids.flatMap((guid, index) => guid === targetGuid ? [multipartReservationCounts[index]!] : []);
  assert.equal(targetTransfers.length, 1, "Restoration must transfer the selected target exactly once");
  assert.ok(targetTransfers[0]! >= 2, "Revoked prepared work cannot send; target needs a fresh reservation before its body");
  assert.equal(attachedSetups, 0);
  assert.deepEqual(await cloneSnapshot(data), original, "Revoke/restore must preserve native identity and timestamps");
  console.log(JSON.stringify({
    scenario: "actual-app-private-restore-before-reservation-release", passed: true,
    targetGuid, targetReservationsBeforeBody: targetTransfers, multipartBodies,
    publishedGuids: publicGuids, attachedSetups, nativeIdentityUnchanged: true,
    scope: "old reservation fenced; fresh authorized reservation publishes once after revoke/restore",
  }));
}

async function verifySharingReservationBarrier(local: LocalClient, data: string, original: unknown, changePolicy: () => Promise<void>) {
  const timer = setTimeout(() => reservationReached.reject(new Error("Real reservation did not reach response barrier")), 30_000);
  const mode = process.env.RACEIQ_UPLOAD_RESERVATION_RESTRICTION;
  const restriction = mode === "sign_out" ? "signed_out" : mode === "policy_changed" ? "consent_required" : "private";
  try {
    await reservationReached.promise;
    assert.equal(multipartBodies, 0, "Recording must not start before reservation response");
    if (process.env.RACEIQ_UPLOAD_RESERVATION_RESTRICTION === "delete_source") {
      await verifyDeletedSourceReservationBarrier(local, data, original);
      return;
    }
    if (refreshRequiredAtReservation) {
      await verifyRefreshRequiredReservationBarrier(local, data, original);
      return;
    }
    const before = (await local("/api/online/state")).data;
    assert.equal(before.uploadAllowed, true);
    let changed;
    if (restriction === "consent_required") {
      await changePolicy();
      changed = await local("/api/online/state");
      assert.equal(changed.data.sync.blockedBy, "consent_required");
      assert.notEqual(changed.data.consent.status, "accepted");
      assert.ok(heldReservationSignal && !heldReservationSignal.aborted, "Policy must be observed before the held reservation request aborts");
    } else {
      changed = restriction === "signed_out"
        ? await local("/api/online/sign-out", "POST", { expectedRevision: before.revision, accountEpoch: before.accountEpoch })
        : await local("/api/online/preferences", "PUT", {
          expectedRevision: before.revision, accountEpoch: before.accountEpoch,
          preferences: { visibility: "private", setupUploads: false },
        });
    }
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    if (process.env.RACEIQ_UPLOAD_RESERVATION_RESTRICTION === "private_restore") {
      await verifyRestoredReservationBarrier(local, data, original);
      return;
    }
    releaseReservation.resolve();
    const deadline = Date.now() + 30_000;
    let state = (await local("/api/online/state")).data, stable = 0, previous = "";
    while (Date.now() < deadline && stable < 4) {
      const ledger = readUploadLedger(data);
      const fingerprint = JSON.stringify({ blockedBy: state.sync.blockedBy, inFlight: state.sync.inFlight, ledger, multipartBodies, attachedSetups });
      const settled = state.sync.blockedBy === restriction && state.sync.inFlight === 0 && ledger.every(row => row.status !== "dispatching");
      stable = settled && fingerprint === previous ? stable + 1 : 0;
      previous = fingerprint;
      if (stable < 4) {
        await Bun.sleep(250);
        state = (await local("/api/online/state")).data;
      }
    }
    assert.equal(stable, 4, "Restricted worker and business ledger must settle before inspecting no-send result");
    if (restriction === "private") assert.equal(state.preferences.visibility, "private");
    else if (restriction === "signed_out") assert.equal(state.connection.status, "signed_out");
    else assert.notEqual(state.consent.status, "accepted");
    assert.equal(state.uploadAllowed, false);
    assert.equal(state.sync.blockedBy, restriction);
    assert.equal(state.sync.inFlight, 0, "Restricted upload must finish without starting body transport");
    assert.equal(multipartBodies, 0, "Revocation after real reservation must prevent binary upload");
    assert.equal(attachedSetups, 0);
    const published = cloudDb!.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM laps WHERE publication_status='public'").get()!.count;
    assert.equal(published, 0);
    const ledger = readUploadLedger(data);
    assert.ok(ledger.every(row => row.remoteJobId === null), "No recording acceptance receipt may be fabricated");
    assert.deepEqual(await cloneSnapshot(data), original, "Revocation must preserve native identity and timestamps");
    console.log(JSON.stringify({
      scenario: `actual-app-${restriction}-after-reservation`, passed: true,
      reservationGuids, multipartBodies, attachedSetups, publishedRows: published,
      nativeIdentityUnchanged: true, finalBlockedBy: state.sync.blockedBy,
      scope: "real app/SDK/API reservation then observed private/sign-out/policy restriction before body; other boundaries remain unproven",
    }));
  } finally {
    clearTimeout(timer);
    releaseReservation.resolve();
  }
}
async function runLifecycleScenario() {
assert.ok(certFile && owner);
try {
  const data = await cloneSource(); const before = await cloneSnapshot(data);
  const storage = { SQLITE_PATH: join(temporary, "cloud.sqlite"), UPLOAD_DIR: join(temporary, "uploads"), DISCORD_BOT_TOKEN: "", ...policy };
  const startCloudServices = async () => {
    cloud = start([join(cloudRoot!, "apps/raceiq/target/debug/raceiq-server")], cloudRoot!, { ...storage, HOST: "127.0.0.1", PORT: String(apiPort), HTTP_METRICS_HOST: "127.0.0.1", HTTP_METRICS_PORT: "0", PUBLIC_BASE_URL: apiBase, SUPABASE_URL: providerBase, SUPABASE_PUBLISHABLE_KEY: "r03-local-key", PUBLIC_API_RATE_LIMIT_PER_MINUTE: "60000", PUBLIC_API_RATE_LIMIT_BURST: "10000", PUBLIC_API_TRUSTED_PROXY_IPS: "" });
    await ready(`${apiBase}/healthz`);
    processor = start(["bun", "--no-env-file", "apps/lap-processor/src/main.ts"], cloudRoot!, { ...storage, LAP_PROCESSOR_METRICS_HOST: "127.0.0.1", LAP_PROCESSOR_METRICS_PORT: String(metricsPort), RETENTION_MODE: "enabled" });
  };
  await startCloudServices();
  cloudDb = new Database(storage.SQLITE_PATH, { readonly: true });
  desktop = start(["bun", "--no-env-file", "apps/backend/src/index.ts"], desktopRoot, { NODE_ENV: "test", DATA_DIR: data, SERVER_HOST: "127.0.0.1", SERVER_PORT: String(appPort), UDP_PORT: String(udpPort), RACEIQ_DEV_UDP_PORT: String(udpPort), RACEIQ_E2E: "1", RACEIQ_E2E_ONLINE_ORIGIN: proxyBase, RACEIQ_E2E_AUTH_ORIGIN: authOrigin, RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "r03-local-key", NODE_EXTRA_CA_CERTS: certFile, RACEIQ_DISABLE_TRAY: "1", RACEIQ_LAUNCHER_OPENS_BROWSER: "0" });
  await ready(`${appBase}/api/auth/status`); const local = localClient();
  if ((await local("/api/auth/status")).data.pending) assert.equal((await local("/api/auth/setup", "POST", { password: "RaceIQ-uploads-local-only-2026", exposureConfirmed: true })).status, 200);
  assert.equal((await local("/api/auth/login", "POST", { password: "RaceIQ-uploads-local-only-2026" })).status, 200);
  const initialOnline = await ensureOnline(local);
  let state = initialOnline.state;
  if (sharingReservationBarrier) {
    await verifySharingReservationBarrier(local, data, before, async () => {
      await Promise.all([stop(cloud), stop(processor)]);
      policy.RACEIQ_TERMS_VERSION = "r04-changed-terms";
      storage.RACEIQ_TERMS_VERSION = policy.RACEIQ_TERMS_VERSION;
      await startCloudServices();
    });
    passed = true;
    return;
  }
  const expectedGuids = [...expectedBest.values()].map(row => row.guid).sort();
  const timeout = Date.now() + 180_000; let publicRows: Record<string, unknown>[] = [], initialLedger = readUploadLedger(data);
  while (Date.now() < timeout) {
    publicRows = cloudDb.query<Record<string, unknown>, []>("SELECT * FROM laps WHERE publication_status='public' ORDER BY lap_id").all();
    initialLedger = readUploadLedger(data);
    const settledLedger = initialLedger.length === expectedGuids.length &&
      initialLedger.every(row => row.status === "transmitted" && row.validation === "validated" && row.publication === "public" && row.remoteJobId) &&
      initialLedger.map(row => row.lapGuid).sort().join(",") === expectedGuids.join(",");
    if (publicRows.length >= expectedBest.size && settledLedger) break;
    await Bun.sleep(250);
  }
  assert.equal(publicRows.length, expectedBest.size, "Actual app backfill must publish fastest eligible F1 World Self lap");
  const observedGuids = publicRows.map(row => String(row.lap_guid)).sort();
  assert.deepEqual(observedGuids, expectedGuids, "Cloud publication must contain only source-derived fastest Self GUIDs");
  state = (await local("/api/online/state")).data;
  assert.equal(state.sync.lastError?.code, "recording_not_ready", "Unready native LMU source must remain held without reservation");
  assert.equal(initialLedger.length, expectedGuids.length, "Business ledger must contain only selected lap uploads");
  assert.deepEqual(initialLedger.map(row => row.lapGuid).sort(), expectedGuids);
  assert.ok(initialLedger.every(row => row.status === "transmitted" && row.validation === "validated" && row.publication === "public" && row.remoteJobId),
    "Selected upload business-ledger rows must be transmitted, validated, and public");
  assert.deepEqual([...new Set(reservationGuids)].sort(), expectedGuids, "Reservation GUID set must equal fastest source-derived GUIDs");
  assert.equal(reservationGuids.length, expectedGuids.length, "Initial reservation count must equal selected lap count");
  assert.equal(multipartBodies, expectedGuids.length, "Initial multipart count must equal selected lap count");
  assert.equal(attachedSetups, 0, "No optional setup attachment is sent while setup sharing is disabled");
  const nativeF1 = sourceSessions.find(session => session.gameId === "f1-2025");
  assert.ok(nativeF1, "Immutable source must include owned native F1 session for reprocess verification");
  const reservationsBeforeReprocess = reservationGuids.length, multipartBeforeReprocess = multipartBodies;
  const result = await local(`/api/sessions/${nativeF1.id}/reprocess`, "POST");
  assert.equal(result.status, 200, "Real app reprocess route must complete for owned native source");
  assert.equal(result.data.sessionId, nativeF1.id);
  assert.ok(Number.isSafeInteger(result.data.lapsDetected) && result.data.lapsDetected > 0, "Reprocess response must report completed lap detection");
  assert.ok(["in-place", "replace"].includes(result.data.strategy), "Reprocess response must report completed strategy");
  assert.deepEqual(await cloneSnapshot(data), before, "Reprocess must preserve original owner, GUIDs, lap times and source revisions");
  publicRows = cloudDb.query<Record<string, unknown>, []>("SELECT * FROM laps WHERE publication_status='public' ORDER BY lap_id").all();
  assert.equal(publicRows.length, expectedBest.size, "Reprocess must not duplicate canonical cloud publication");
  state = (await local("/api/online/state")).data;
  const history = await local(`/api/online/uploads?view=history&accountEpoch=${encodeURIComponent(state.accountEpoch)}&expectedRevision=${state.revision}&limit=100`);
  assert.equal(history.status, 200);
  const lapHistory = history.data.items.filter((item: { kind: string }) => item.kind === "lap");
  assert.equal(lapHistory.length, expectedBest.size, "Actual upload-history readback must retain selected lap receipts; profile rows are separate");
  assert.deepEqual(lapHistory.map((item: { lapGuid: string | null }) => item.lapGuid).sort(), expectedGuids);
  assert.ok(lapHistory.every((item: { delivery: string; validation: string; publication: string }) =>
    item.delivery === "accepted" && item.validation === "validated" && item.publication === "public"), "Receipts must remain accepted, validated, and public after reprocess");
  const queue = await local(`/api/online/uploads?view=queue&accountEpoch=${encodeURIComponent(state.accountEpoch)}&expectedRevision=${state.revision}&limit=100`);
  assert.equal(queue.status, 200);
  const ledgerAfterReprocess = readUploadLedger(data);
  assert.deepEqual(ledgerAfterReprocess, initialLedger, "Reprocess must leave settled upload ledger unchanged");
  const reprocessSettled = state.sync.status === "idle" && queue.data.items.every((item: { kind: string }) => item.kind !== "lap") &&
    ledgerAfterReprocess.every(row => row.status === "transmitted" && row.validation === "validated" && row.publication === "public") &&
    lapHistory.every((item: { delivery: string; validation: string; publication: string }) =>
      item.delivery === "accepted" && item.validation === "validated" && item.publication === "public");
  assert.ok(reprocessSettled, "Reprocess completion requires idle worker state, empty lap queue, settled business ledger, and accepted/public receipt");
  assert.equal(reservationGuids.length, reservationsBeforeReprocess, "Settled reprocess must not issue another reservation");
  assert.equal(multipartBodies, multipartBeforeReprocess, "Settled reprocess must not send another multipart body");
  assert.deepEqual([...new Set(reservationGuids)].sort(), expectedGuids);
  assert.equal(reservationGuids.length, expectedGuids.length);
  const captureDb = new Database(join(data, "app.db"), { readonly: true });
  const priorSessionId = captureDb.query<{ id: number }, []>("SELECT COALESCE(MAX(id),0) AS id FROM sessions").get()!.id;
  const multipartBodiesBeforeCapture = multipartBodies;
  const frames = [...iterateSessionCaptureRecords(decompressIfGzipSync(await readFile(udpFixture)))].flatMap(record => record.kind === "frame" ? [record.frame] : []);
  assert.ok(frames.length > 1000, "Genuine F1 UDP fixture must contain more than 1,000 frames");
  const udp = createSocket("udp4"), send = (packet: Uint8Array) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    udp.send(packet, udpPort, "127.0.0.1", error => error ? reject(error) : resolve());
    return promise;
  };
  let captured: { sessionId: number; lapId: number; guid: string } | undefined;
  let bindingCandidateCount = 0;
  try {
    for (let index = 0; index < frames.length && index < 100_000; index++) {
      await send(frames[index]!);
      if ((index & 15) === 15) await Bun.sleep(20);
      if (index === 255) {
        const bindings = await local("/api/driver-bindings");
        bindingCandidateCount = Array.isArray(bindings.data.candidates) ? bindings.data.candidates.length : 0;
      }
      if ((index & 255) === 255) {
        captured = captureDb.query<{ sessionId: number; lapId: number; guid: string }, [number]>(
          `SELECT s.id AS sessionId,l.id AS lapId,l.lap_guid AS guid FROM sessions s JOIN laps l ON l.session_id=s.id
           WHERE s.id>? AND s.native_capture_origin=1 AND l.is_valid=1 AND l.driver_attribution='Self' AND l.lap_guid IS NOT NULL
           ORDER BY s.id,l.id LIMIT 1`).get(priorSessionId) ?? undefined;
        if (captured) break;
      }
    }
  } finally { udp.close(); }
  assert.ok(captured, "Actual UDP capture must save a complete valid Self lap");
  await stop(desktop); desktop = undefined;
  const savedCapture = captureDb.query<{
    owner: string | null; activityId: string | null; sourceRevision: string | null; lapGuid: string | null;
    gameId: string; trackId: string; carId: string; lapTime: number; totalTimeMs: number | null; valid: number; attribution: string | null;
    sessionCreatedAt: string | number; lapRecordedAt: string | number | null;
  }, [number, number]>(
    `SELECT s.owner_user_id AS owner,s.original_activity_id AS activityId,s.original_source_revision AS sourceRevision,l.lap_guid AS lapGuid,
      s.game_id AS gameId,s.track_id AS trackId,s.car_id AS carId,l.lap_time AS lapTime,l.total_time_ms AS totalTimeMs,
      l.is_valid AS valid,l.driver_attribution AS attribution,s.created_at AS sessionCreatedAt,l.recorded_at AS lapRecordedAt
     FROM sessions s JOIN laps l ON l.session_id=s.id WHERE s.id=? AND l.id=?`).get(captured.sessionId, captured.lapId);
  assert.ok(savedCapture?.activityId && savedCapture.sourceRevision && savedCapture.lapGuid === captured.guid);
  assert.equal(savedCapture.owner, owner, "Saved native capture must retain authenticated original owner");
  assert.ok(!expectedGuids.includes(captured.guid), "New capture must receive a fresh producer-generated lap GUID");
  const closure = captureDb.query<{ manifest: string }, [number]>("SELECT capture_manifest_file AS manifest FROM sessions WHERE id=?").get(captured.sessionId);
  assert.ok(closure?.manifest, "Saved capture must retain its supported manifest");
  assert.equal(JSON.parse(await readFile(closure.manifest, "utf8")).sourceClosed, true, "Actual save/shutdown must close the new capture before portable export");
  desktop = start(["bun", "--no-env-file", "apps/backend/src/index.ts"], desktopRoot, {
    NODE_ENV: "test", DATA_DIR: data, SERVER_HOST: "127.0.0.1", SERVER_PORT: String(appPort), UDP_PORT: String(udpPort), RACEIQ_DEV_UDP_PORT: String(udpPort),
    RACEIQ_E2E: "1", RACEIQ_E2E_ONLINE_ORIGIN: proxyBase, RACEIQ_E2E_AUTH_ORIGIN: authOrigin, RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "r03-local-key",
    NODE_EXTRA_CA_CERTS: certFile!, RACEIQ_DISABLE_TRAY: "1", RACEIQ_LAUNCHER_OPENS_BROWSER: "0",
  });
  await ready(`${appBase}/api/auth/status`);
  let resumed = localClient();
  assert.equal((await resumed("/api/auth/login", "POST", { password: "RaceIQ-uploads-local-only-2026" })).status, 200);
  const restartedOnline = await ensureOnline(resumed);
  const captureState = restartedOnline.state;
  const resumedBindings = await resumed("/api/driver-bindings");
  assert.equal(resumedBindings.status, 200);
  bindingCandidateCount = Array.isArray(resumedBindings.data.candidates) ? resumedBindings.data.candidates.length : 0;
  const captureLapTimeMs = savedCapture.totalTimeMs && savedCapture.totalTimeMs > 0
    ? savedCapture.totalTimeMs : Math.round(savedCapture.lapTime * 1000);
  const boardRows = captureDb.query<{
    lapId: number; lapGuid: string; lapTimeMs: number; ownerUserId: string | null; activityId: string | null; sourceRevision: string | null;
  }, [string, string, string, string]>(
    `SELECT l.id AS lapId,l.lap_guid AS lapGuid,COALESCE(l.total_time_ms,ROUND(l.lap_time*1000)) AS lapTimeMs,
      s.owner_user_id AS ownerUserId,s.original_activity_id AS activityId,s.original_source_revision AS sourceRevision
     FROM sessions s JOIN laps l ON l.session_id=s.id
     WHERE s.native_capture_origin=1 AND s.game_id=? AND s.track_id=? AND s.car_id=?
       AND s.owner_user_id=? AND l.is_valid=1 AND l.driver_attribution='Self' AND l.lap_guid IS NOT NULL
     ORDER BY lapTimeMs,l.id`).all(savedCapture.gameId, savedCapture.trackId, savedCapture.carId, owner);
  const expectedByBoard = boardRows.map(row => ({ ...row, lapTimeMs: Number(row.lapTimeMs) }));
  const expectedCapture = expectedByBoard.find(row => row.lapId === captured!.lapId);
  const bestExisting = expectedByBoard.find(row => row.lapId !== captured!.lapId) ?? null;
  assert.ok(expectedCapture, "New saved capture must be present in independently derived eligible board");
  const captureSelected = expectedByBoard[0]?.lapId === captured.lapId;
  const sourceEvidence = {
    source: { kind: "ready", lapId: captured.lapId, lapGuid: expectedCapture.lapGuid, ownerUserId: expectedCapture.ownerUserId,
      originalActivityId: expectedCapture.activityId, sourceRevision: expectedCapture.sourceRevision },
    candidate: expectedCapture, bestExisting, captureSelected, boardCandidates: expectedByBoard,
  };
  assert.equal(sourceEvidence.source.lapGuid, captured.guid);
  assert.equal(sourceEvidence.source.ownerUserId, owner);
  assert.equal(sourceEvidence.source.sourceRevision, savedCapture.sourceRevision);
  const captureSelectionReason = sourceEvidence.captureSelected ? sourceEvidence.bestExisting ? "faster_than_existing_best" : "first_eligible_board_candidate"
    : sourceEvidence.bestExisting?.lapTimeMs === sourceEvidence.candidate.lapTimeMs ? "equal_to_existing_best" : "slower_than_existing_best";
  const capturePreconditions = {
    currentOnline: restartedOnline.after,
    sourceReadiness: sourceEvidence.source,
    candidate: sourceEvidence.candidate,
    bestExisting: sourceEvidence.bestExisting,
    expectedFastestByIndependentOrdering: sourceEvidence.captureSelected,
    selectionReason: captureSelectionReason,
    boardCandidates: sourceEvidence.boardCandidates,
    lapTimeMsFromSavedRow: captureLapTimeMs,
    bindingCandidateCount,
  };
  const captureSettlement = await awaitCaptureSettlement(resumed, data, captured.guid);
  const captureReceipt = captureSettlement.ledger.find((row: { lapGuid: string | null }) => row.lapGuid === captured!.guid) ?? null;
  const capturePublic = captureSettlement.publicRows;
  const captureHistory = captureSettlement.history;
  const equalTimeCaptureExcluded = sourceEvidence.candidate !== null && sourceEvidence.bestExisting !== null &&
    sourceEvidence.bestExisting.lapTimeMs === sourceEvidence.candidate.lapTimeMs && !sourceEvidence.captureSelected;
  const eligibleFastestReady = captureState.uploadAllowed && sourceEvidence.source.kind === "ready" &&
    sourceEvidence.candidate !== null && sourceEvidence.captureSelected;
  const captureTransferred = Boolean(captureReceipt?.status === "transmitted" && captureReceipt.validation === "validated" &&
    captureReceipt.publication === "public" && captureReceipt.remoteJobId &&
    captureHistory.some((item: { delivery?: string; validation?: string; publication?: string }) =>
      item.delivery === "accepted" && item.validation === "validated" && item.publication === "public") &&
    capturePublic.length === 1);
  const eligibleCaptureBlocked = eligibleFastestReady && !captureTransferred;
  if (eligibleCaptureBlocked) preserveEvidenceClone = true;
  if (eligibleCaptureBlocked) assert.fail("Selected, source-ready fastest capture did not complete upload and public receipt");
  const beforeOwnedImport = await cloneSnapshot(data);
  const ledgerBeforeOwnedImport = captureSettlement.ledgerAll;
  const publishedCountBeforeOwnedImport = captureSettlement.publicCount;
  const reservationsBeforeOwnedImport = reservationGuids.length, bodiesBeforeOwnedImport = multipartBodies;
  const reservationCountForCapture = reservationGuids.filter(guid => guid === captured!.guid).length;
  assert.ok(equalTimeCaptureExcluded, "Fixture must exercise deterministic equal-time capture exclusion");
  assert.equal(reservationCountForCapture, 0, "Equal-time selection must retain existing lower-ID board lap");
  assert.equal(captureReceipt, null, "Equal-time excluded capture must have no upload receipt");
  assert.equal(capturePublic.length, 0, "Equal-time excluded capture must not add a public recording");
  assert.equal(captureHistory.length, 0, "Equal-time excluded capture must not appear in upload history");
  const exportResponse = await fetch(`${appBase}/api/laps/export-zip?sessionIds=${captured.sessionId}`, { headers: { Cookie: (await resumed("/api/auth/status")).cookie } });
  assert.equal(exportResponse.status, 200, "Real portable export route must export saved native capture");
  const portableArchive = new Uint8Array(await exportResponse.arrayBuffer());
  const archive = new FormData();
  archive.append("ownership", "mine");
  archive.append("file", new File([portableArchive], "owned-capture.zip", { type: "application/zip" }));
  const ownedImport = await resumed("/api/laps/import-zip", "POST", archive);
  assert.equal(ownedImport.status, 200, "Real owned-import route must accept own portable capture");
  assert.equal(ownedImport.data.skipped, 0);
  assert.deepEqual(ownedImport.data.errors, []);
  assert.ok(ownedImport.data.laps.some((lap: { lapId: number; sessionId: number }) => lap.lapId === captured!.lapId && lap.sessionId === captured!.sessionId),
    "Owned import must reuse same saved lap and session IDs");
  const afterOwnedImport = await awaitCaptureSettlement(resumed, data, captured.guid);
  assert.deepEqual(await cloneSnapshot(data), beforeOwnedImport, "Owned portable import must preserve owner, original activity, source revision, lap GUIDs, timing and validity");
  assert.equal(afterOwnedImport.publicCount, publishedCountBeforeOwnedImport, "Owned import must not duplicate settled canonical publication");
  assert.deepEqual(afterOwnedImport.ledgerAll, ledgerBeforeOwnedImport, "Owned import must not change settled business ledger or receipts");
  assert.equal(reservationGuids.length, reservationsBeforeOwnedImport, "Settled owned import must not create another reservation");
  const readCloudStats = async (userId: string) => {
    let token: string | undefined;
    for (const [candidate, account] of tokens) if (account === userId) token = candidate;
    assert.ok(token, `Fake OAuth provider must issue token for ${userId}`);
    const response = await fetch(`${apiBase}/api/v1/me/stats`, { headers: { Origin: apiBase, Authorization: `Bearer ${token}` } });
    const data = response.status === 200 ? await response.json() as {
      summary: { metrics: { laps: number }; games: { gameId: string; metrics: { laps: number } }[] } | null;
    } : null;
    return { status: response.status, data };
  };
  try {
    const betaData = join(temporary, "beta-device"); await mkdir(betaData, { recursive: true });
    const betaBase = `http://127.0.0.1:${betaPort}`;
    betaDesktop = start(["bun", "--no-env-file", "apps/backend/src/index.ts"], desktopRoot, {
      NODE_ENV: "test", DATA_DIR: betaData, SERVER_HOST: "127.0.0.1", SERVER_PORT: String(betaPort), UDP_PORT: String(await freePort()),
      RACEIQ_E2E: "1", RACEIQ_E2E_ONLINE_ORIGIN: proxyBase, RACEIQ_E2E_AUTH_ORIGIN: authOrigin, RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "r03-local-key",
      NODE_EXTRA_CA_CERTS: certFile!, RACEIQ_DISABLE_TRAY: "1", RACEIQ_LAUNCHER_OPENS_BROWSER: "0",
    });
    await ready(`${betaBase}/api/auth/status`);
    const betaLocal = localClient(betaBase);
    if ((await betaLocal("/api/auth/status")).data.pending) {
      assert.equal((await betaLocal("/api/auth/setup", "POST", { password: "RaceIQ-beta-local-only-2026", exposureConfirmed: true })).status, 200);
    }
    assert.equal((await betaLocal("/api/auth/login", "POST", { password: "RaceIQ-beta-local-only-2026" })).status, 200);
    const betaOnline = await ensureOnline(betaLocal, betaOwner);
    const betaPrivacy = await betaLocal("/api/online/preferences", "PUT", {
      expectedRevision: betaOnline.state.revision, accountEpoch: betaOnline.state.accountEpoch, preferences: { visibility: "private", setupUploads: false },
    });
    assert.equal(betaPrivacy.status, 200);
    const betaStatsBefore = await readCloudStats(betaOwner);
    const reservationsBeforeBeta = reservationGuids.length, multipartBeforeBeta = multipartBodies, setupsBeforeBeta = attachedSetups;
    const betaArchive = new FormData();
    betaArchive.append("ownership", "others");
    betaArchive.append("file", new File([portableArchive], "alpha-capture.zip", { type: "application/zip" }));
    const betaImport = await betaLocal("/api/laps/import-zip", "POST", betaArchive);
    assert.equal(betaImport.status, 200, JSON.stringify(betaImport.data));
    assert.equal(betaImport.data.skipped, 0);
    assert.deepEqual(betaImport.data.errors, []);
    const betaDb = new Database(join(betaData, "app.db"), { readonly: true });
    const betaOriginal = betaDb.query<{
      owner: string | null; author: string | null; activityId: string | null; sourceRevision: string | null; lapGuid: string; ownership: string;
    }, [string]>(
      `SELECT s.owner_user_id AS owner,s.source_author_user_id AS author,s.original_activity_id AS activityId,
        s.original_source_revision AS sourceRevision,l.lap_guid AS lapGuid,s.ownership AS ownership
       FROM sessions s JOIN laps l ON l.session_id=s.id WHERE l.lap_guid=?`
    ).get(captured.guid);
    betaDb.close();
    assert.ok(betaOriginal, "Beta actual ZIP import must retain Alpha original");
    assert.equal(betaOriginal.lapGuid, captured.guid);
    assert.equal(betaOriginal.activityId, savedCapture.activityId);
    assert.equal(betaOriginal.sourceRevision, savedCapture.sourceRevision);
    assert.ok(betaOriginal.owner === owner || betaOriginal.author === owner, "Original owner must remain Alpha, never Beta");
    assert.equal(betaOriginal.ownership, "others");
    let betaStatsAfter = await readCloudStats(betaOwner), betaStatsFingerprint = "", betaStatsStable = 0;
    const betaStatsDeadline = Date.now() + 30_000;
    while (Date.now() < betaStatsDeadline && betaStatsStable < 4) {
      const state = (await betaLocal("/api/online/state")).data;
      const fingerprint = JSON.stringify(betaStatsAfter);
      betaStatsStable = state.sync.status === "idle" && state.sync.queued === 0 && state.sync.inFlight === 0 && fingerprint === betaStatsFingerprint
        ? betaStatsStable + 1 : 0;
      betaStatsFingerprint = fingerprint;
      if (betaStatsStable < 4) {
        await Bun.sleep(500);
        betaStatsAfter = await readCloudStats(betaOwner);
      }
    }
    assert.ok(betaStatsAfter.status === 404 || betaStatsAfter.status === 200, "Beta stats API must remain readable or report no synced profile");
    assert.equal(betaStatsAfter.data?.summary?.metrics.laps ?? 0, betaStatsBefore.data?.summary?.metrics.laps ?? 0,
      "Beta stats API must show no borrowed Alpha lap credit");
    assert.equal(reservationGuids.length, reservationsBeforeBeta, "Beta borrowed import must not reserve Alpha recording");
    assert.equal(multipartBodies, multipartBeforeBeta, "Beta borrowed import must not transfer Alpha recording body");
    assert.equal(attachedSetups, setupsBeforeBeta, "Beta borrowed import must not transfer setup bytes");
    caseOutcomes.betaForeignImport = { passed: true, identity: betaOriginal, betaStatsBefore, betaStatsAfter, reservationDelta: 0, multipartDelta: 0, setupDelta: 0 };
  } catch (error) {
    caseOutcomes.betaForeignImport = { passed: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const alphaState = (await resumed("/api/online/state")).data;
    const privatePreferences = await resumed("/api/online/preferences", "PUT", {
      expectedRevision: alphaState.revision, accountEpoch: alphaState.accountEpoch, preferences: { visibility: "private", setupUploads: false },
    });
    assert.equal(privatePreferences.status, 200, JSON.stringify(privatePreferences.data));
    const privateState = (await resumed("/api/online/state")).data;
    assert.equal(privateState.preferences.visibility, "private");
    assert.equal(privateState.uploadAllowed, false);
    const reservationsBeforeForza = reservationGuids.length, multipartBeforeForza = multipartBodies, setupsBeforeForza = attachedSetups;
    const alphaStatsBeforeForza = await readCloudStats(owner);
    const forzaFixtures = process.env.RACEIQ_UPLOAD_FORZA_UDP_FIXTURE
      ? [process.env.RACEIQ_UPLOAD_FORZA_UDP_FIXTURE]
      : [
        "test/artifacts/sessions/fm-2023-with-pitting.bin.gz",
        "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz",
        "test/artifacts/sessions/fm-2023-2026-04-09T21-53-00-102Z.bin.gz",
      ];
    const forzaUdp = createSocket("udp4");
    const sendForza = (packet: Uint8Array) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      forzaUdp.send(packet, udpPort, "127.0.0.1", error => error ? reject(error) : resolve());
      return promise;
    };
    const confirmedForzaCandidates = new Set<string>();
    const forzaDeadline = Date.now() + 600_000;
    let forzaCapture: { sessionId: number; lapId: number; guid: string } | undefined, forzaFixtureUsed: string | null = null;
    try {
      for (const fixture of forzaFixtures) {
        const frames = [...iterateSessionCaptureRecords(decompressIfGzipSync(await readFile(fixture)))].flatMap(record => record.kind === "frame" ? [record.frame] : []);
        assert.ok(frames.length > 1_000, `Genuine Forza fixture must contain native packet frames: ${fixture}`);
        for (let index = 0; index < frames.length && index < 100_000; index++) {
          await sendForza(frames[index]!);
          if ((index & 15) === 15) await Bun.sleep(20);
          if ((index & 255) === 255) {
            const bindingState = await resumed("/api/driver-bindings");
            const candidate = (bindingState.data.candidates as { candidateId: string; gameId: string }[])
              .find(item => item.gameId === "fm-2023");
            if (candidate && !confirmedForzaCandidates.has(candidate.candidateId)) {
              const state = (await resumed("/api/online/state")).data;
              const confirmed = await resumed("/api/driver-bindings", "PUT", {
                accountEpoch: state.accountEpoch, expectedRevision: state.revision, candidateId: candidate.candidateId, confirmedByUser: true,
              });
              assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
              confirmedForzaCandidates.add(candidate.candidateId);
            }
            forzaCapture = captureDb.query<{ sessionId: number; lapId: number; guid: string }, [number]>(
              `SELECT s.id AS sessionId,l.id AS lapId,l.lap_guid AS guid FROM sessions s JOIN laps l ON l.session_id=s.id
               WHERE s.id>? AND s.game_id='fm-2023' AND s.native_capture_origin=1 AND l.is_valid=1
                 AND l.driver_attribution='Self' AND l.lap_guid IS NOT NULL ORDER BY s.id,l.id LIMIT 1`).get(priorSessionId) ?? undefined;
            if (forzaCapture) { forzaFixtureUsed = fixture; break; }
          }
          if (Date.now() > forzaDeadline) break;
        }
        if (forzaCapture || Date.now() > forzaDeadline) break;
      }
    } finally { forzaUdp.close(); }
    const observedForzaLaps = captureDb.query<{
      sessionId: number; lapId: number; lapGuid: string | null; ownerUserId: string | null; activityId: string | null;
      sourceRevision: string | null; valid: number; attribution: string | null;
    }, [number]>(
      `SELECT s.id AS sessionId,l.id AS lapId,l.lap_guid AS lapGuid,s.owner_user_id AS ownerUserId,
        s.original_activity_id AS activityId,s.original_source_revision AS sourceRevision,l.is_valid AS valid,l.driver_attribution AS attribution
       FROM sessions s JOIN laps l ON l.session_id=s.id WHERE s.id>? AND s.game_id='fm-2023' ORDER BY s.id,l.id`
    ).all(priorSessionId);
    assert.ok(observedForzaLaps.length > 0, "Actual app must capture genuine Forza UDP input under Alpha owner");
    assert.ok(observedForzaLaps.every(row => row.ownerUserId === owner && row.activityId && row.lapGuid),
      "Genuine Forza capture must retain Alpha owner, original activity ID, and lap GUID; report missing source revisions below");
    const forzaActivityIds = [...new Set(observedForzaLaps.map(row => row.activityId!))];
    let alphaStatsAfterForza = await readCloudStats(owner);
    let profileStable = 0, lastProfile = "", profileDeadline = Date.now() + 30_000;
    while (profileStable < 4 && Date.now() < profileDeadline) {
      const state = (await resumed("/api/online/state")).data;
      const current = JSON.stringify(alphaStatsAfterForza);
      profileStable = state.sync.status === "idle" && state.sync.queued === 0 && state.sync.inFlight === 0 && current === lastProfile
        ? profileStable + 1 : 0;
      lastProfile = current;
      if (profileStable < 4) {
        await Bun.sleep(500);
        alphaStatsAfterForza = await readCloudStats(owner);
      }
    }
    let alphaToken: string | undefined;
    for (const [candidate, account] of tokens) if (account === owner) alphaToken = candidate;
    assert.ok(alphaToken, "Alpha OAuth token must remain available for actual receipt readback");
    const forzaReceipts = await Promise.all(forzaActivityIds.map(async activityId => {
      const response = await fetch(`${apiBase}/api/v1/me/stats/activities/${encodeURIComponent(activityId)}`, {
        headers: { Origin: apiBase, Authorization: `Bearer ${alphaToken}` },
      });
      const data = response.status === 200 ? await response.json() as { contribution: { metrics: { laps: number }; lapGuids: string[] } } : null;
      return { activityId, status: response.status, laps: data?.contribution.metrics.laps ?? 0, lapGuids: data?.contribution.lapGuids ?? [] };
    }));
    const metricLaps = (stats: typeof alphaStatsBeforeForza) =>
      stats.data?.summary?.games.find(game => game.gameId === "fm-2023")?.metrics.laps ?? 0;
    const selfForzaLaps = observedForzaLaps.filter(row => row.valid === 1 && row.attribution === "Self");
    const selfForzaGuids = new Set(selfForzaLaps.map(row => row.lapGuid));
    const receiptGuidsBelongToSelf = forzaReceipts.every(receipt => receipt.lapGuids.every(guid => selfForzaGuids.has(guid)));
    const positiveForzaContribution = selfForzaLaps.length > 0 && receiptGuidsBelongToSelf &&
      metricLaps(alphaStatsAfterForza) > metricLaps(alphaStatsBeforeForza) &&
      forzaReceipts.some(receipt => receipt.status === 200 && receipt.laps > 0);
    const noUnknownForzaCredit = selfForzaLaps.length === 0 && metricLaps(alphaStatsAfterForza) === metricLaps(alphaStatsBeforeForza) &&
      forzaReceipts.every(receipt => receipt.status !== 200 || receipt.laps === 0 && receipt.lapGuids.length === 0);
    assert.ok(positiveForzaContribution || noUnknownForzaCredit,
      "Actual Forza stats API must credit only eligible Self captures; unknown captures remain uncredited");
    assert.equal(reservationGuids.length, reservationsBeforeForza, "Private Forza capture must not reserve recording");
    assert.equal(multipartBodies, multipartBeforeForza, "Private Forza capture must not transfer recording body");
    assert.equal(attachedSetups, setupsBeforeForza, "Private Forza capture must not transfer setup bytes");
    caseOutcomes.forzaPrivateAggregate = {
      passed: true, status: positiveForzaContribution ? "verified_positive" : "positive_blocked_no_self_attribution",
      positiveContribution: positiveForzaContribution, replayedFixtures: forzaFixtures, fixtureWithSelfLap: forzaFixtureUsed,
      capturedLaps: observedForzaLaps, alphaStatsBefore: alphaStatsBeforeForza, alphaStatsAfter: alphaStatsAfterForza,
      activityReceipts: forzaReceipts, profileStable, reservationDelta: 0, multipartDelta: 0, setupDelta: 0,
    };
  } catch (error) {
    caseOutcomes.forzaPrivateAggregate = { passed: false, error: error instanceof Error ? error.message : String(error) };
  }
  assert.equal(multipartBodies, bodiesBeforeOwnedImport, "Settled owned import must not transfer another multipart body");
  assert.ok(Object.values(caseOutcomes).every(value => (value as { passed?: boolean }).passed), JSON.stringify(caseOutcomes));
  captureDb.close();
  console.log(JSON.stringify({ scenario: "actual-app-native-f1-upload-lifecycle", passed: true, result: {
    selectedBoards: expectedBest.size, selectedGuids: expectedGuids, publishedRows: publicRows.length, reservationGuids, multipartBodies, attachedSetups,
    reprocessPreservedIdentity: true, duplicatePublicationAfterReprocess: false, reprocessSettled,
    initialOnline: { before: initialOnline.before, after: onlineStateSummary(initialOnline.state) },
    restartedOnline: { before: restartedOnline.before, after: restartedOnline.after },
    newCapture: {
      sessionId: captured.sessionId, lapId: captured.lapId, guid: captured.guid,
      gameId: savedCapture.gameId, trackId: savedCapture.trackId, carId: savedCapture.carId,
      validity: savedCapture.valid, attribution: savedCapture.attribution, lapTime: savedCapture.lapTime, lapTimeMs: captureLapTimeMs,
      originalActivityId: savedCapture.activityId, sourceRevision: savedCapture.sourceRevision, ownerPreserved: savedCapture.owner === owner, sourceClosed: true,
      sessionCreatedAt: savedCapture.sessionCreatedAt, lapRecordedAt: savedCapture.lapRecordedAt,
      preconditions: capturePreconditions, eligibility: { reason: captureSelectionReason, eligibleFastestReady, bindingCandidateCount },
      settledUpload: {
        state: captureSettlement.state, queue: captureSettlement.queue, history: captureSettlement.history,
        ledger: captureSettlement.ledger, publicRows: captureSettlement.publicRows, publicCount: captureSettlement.publicCount,
        reservationCount: captureSettlement.reservationCount, reservations: captureSettlement.reservations, multipartBodies: captureSettlement.multipartBodies,
      },
      newReservations: reservationCountForCapture, newMultipartBodies: captureSettlement.multipartBodies - multipartBodiesBeforeCapture,
    },
    ownedImport: {
      route: "/api/laps/export-zip -> /api/laps/import-zip", sameLapAndSession: true, ownerGuidRevisionPreserved: true,
      settledBefore: true, settledAfter: { syncStatus: afterOwnedImport.state.sync.status, ledgerStable: true, receipts: afterOwnedImport.history },
      duplicatePublication: false, duplicateReservation: false, duplicateBody: false,
    },
    heldNativeLMU: state.sync.lastError?.code,
    caseOutcomes,
    unverified: "Comparative slower/faster replacement and different-car histories remain unverified",
  } }));
  passed = true;
} catch (error) {
  for (const child of children) await writeFile(join(temporary, `child-${child.pid}.log`), logs.get(child) ?? "");
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error), caseOutcomes, evidenceDirectory: temporary, reservationGuids: [...reservationGuids], multipartBodies, attachedSetups })); throw error;
} finally {
  releaseReservation.resolve();
  await stop(desktop); await stop(betaDesktop); await stop(processor); await stop(cloud); cloudDb?.close(); proxy.stop(true); tlsProvider.stop(true); plainProvider.stop(true);
}
}
await runLifecycleScenario();
