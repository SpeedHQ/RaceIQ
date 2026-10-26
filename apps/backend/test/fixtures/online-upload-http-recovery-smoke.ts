import assert from "node:assert/strict";
import Database from "libsql";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createSocket } from "node:dgram";
import { decompressIfGzipSync, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";

// Cross-repository E2E: requires an existing isolated native-capture fixture, not user data.
const desktopRoot = resolve(import.meta.dir, "../../../..");
const cloudRoot = process.env.RACEIQ_CLOUD_ROOT;
const sourceData = process.env.RACEIQ_UPLOAD_SOURCE_DATA_DIR;
const certFile = process.env.RACEIQ_UPLOAD_TEST_CERT;
const keyFile = process.env.RACEIQ_UPLOAD_TEST_KEY;
assert.ok(cloudRoot && sourceData && certFile && keyFile, "Cloud root, isolated source data and test TLS certificate/key are required");
const reservationFaults = (process.env.RACEIQ_UPLOAD_RESERVATION_FAULTS ?? "").split(",").filter(Boolean);
const transferFaults = (process.env.RACEIQ_UPLOAD_TRANSFER_FAULTS ?? "").split(",").filter(Boolean);
assert.ok(transferFaults.length <= 3 && transferFaults.every((fault) => ["503", "disconnect"].includes(fault)), "Only bounded 503,disconnect multipart-transfer faults are supported");
assert.ok(reservationFaults.length <= 3 && reservationFaults.every((fault) => ["429", "503", "disconnect"].includes(fault)), "Only bounded 429,503,disconnect reservation faults are supported");
const injectedTransferFaults: Array<{ fault: string; key: string; bytes: number }> = [];
const transferRecordingHashes = new Map<string, Set<string>>();
const bodyRequestKeys: string[] = [];
const outboundProfileWrites: string[] = [];
const injectedReservationFaults: Array<{ fault: string; key: string; at: number }> = [];
const reservationRetryNotBefore = new Map<string, number>();
let retryViolation: string | null = null;
const offlineCapture = process.env.RACEIQ_UPLOAD_DURABLE_RECOVERY === "1";
let offlineUntil = 0, offlineBodyStarts = 0;
const sourceReal = await realpath(sourceData);
assert.ok(sourceReal.startsWith((await realpath(tmpdir())) + sep), "Refuse non-temporary source data");
const temporary = await mkdtemp(join(tmpdir(), "raceiq-upload-http-recovery-"));
const owner = "a2345678-1234-5678-9abc-def012345678", otherOwner = "b2345678-1234-5678-9abc-def012345678";
const dashboardPassword = "RaceIQ-uploads-local-only-2026";
const children = new Set<Bun.Subprocess>();
const childLogs = new Map<Bun.Subprocess, { text: string; done: Promise<void> }>();
let desktop: Bun.Subprocess | undefined, cloud: Bun.Subprocess | undefined, processor: Bun.Subprocess | undefined;
let cloudDb: Database | undefined;
let shuttingDown = false, restartRequired = false;
const dropped = Promise.withResolvers<void>();
const bodyIdempotencyKeys = new Set<string>();
type CapturedIdentityRow = Record<string, string | number | null>;
const identitySql = "SELECT s.id,s.owner_user_id,s.original_activity_id,s.created_at,l.id AS lap_id,l.lap_guid,l.lap_time,l.recorded_at FROM sessions s JOIN laps l ON l.session_id=s.id WHERE l.lap_guid IS NOT NULL ORDER BY s.id,l.id";
const copiedIdentities = new Map<string, CapturedIdentityRow[]>();
let bodyTransfers = 0, droppedResponses = 0, acceptedJobId: string | undefined;
let acceptedRequestKey: string | undefined;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const cert = await readFile(certFile, "utf8");
const tokens = new Map<string, string>();
const codes = new Map<string, { challenge: string; userId: string }>();
const user = (userId: string) => ({ id: userId, user_metadata: { name: userId === owner ? "Recovery Owner" : "Other Owner" }, identities: [] });
const provider = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/auth/v1/authorize") {
    const callback = new URL(url.searchParams.get("redirect_to")!);
    if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.pathname !== "/api/online/auth/callback") return new Response(null, { status: 400 });
    const code = randomUUID();
    codes.set(code, { challenge: url.searchParams.get("code_challenge")!, userId: url.searchParams.get("login_hint") === "other" ? otherOwner : owner });
    callback.searchParams.set("code", code);
    return Response.redirect(callback.href, 302);
  }
  if (url.pathname === "/auth/v1/token") {
    const body = await request.json();
    let userId: string;
    if (url.searchParams.get("grant_type") === "pkce") {
      const attempt = codes.get(body.auth_code); codes.delete(body.auth_code);
      if (!attempt || createHash("sha256").update(body.code_verifier).digest("base64url") !== attempt.challenge) return new Response(null, { status: 400 });
      userId = attempt.userId;
    } else {
      if (body.refresh_token !== "recovery-owner" && body.refresh_token !== "recovery-other") return new Response(null, { status: 401 });
      userId = body.refresh_token === "recovery-owner" ? owner : otherOwner;
    }
    const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: `${providerBase}/auth/v1`, aud: "authenticated", role: "authenticated", sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, session_id: randomUUID() })}.isolated-signature`;
    tokens.set(accessToken, userId);
    return Response.json({ access_token: accessToken, refresh_token: userId === owner ? "recovery-owner" : "recovery-other", token_type: "bearer", expires_in: 3600, user: user(userId) });
  }
  const userId = tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  return userId && url.pathname === "/auth/v1/user" ? Response.json(user(userId)) : new Response(null, { status: 401 });
};
const plainProvider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: provider });
const providerBase = `http://127.0.0.1:${plainProvider.port}`;
const tlsProvider = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key: await readFile(keyFile) }, fetch: provider });
const authOrigin = `https://127.0.0.1:${tlsProvider.port}`;
async function freePort(): Promise<number> {
  const probe = createServer(), gate = Promise.withResolvers<void>(); probe.listen(0, "127.0.0.1", gate.resolve); await gate.promise;
  const address = probe.address(); assert.ok(address && typeof address === "object");
  const closed = Promise.withResolvers<void>(); probe.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise; return address.port;
}
const apiPort = await freePort(), desktopPort = await freePort(), udpPort = await freePort(), metricsPort = await freePort();
const apiBase = `http://127.0.0.1:${apiPort}`, desktopBase = `http://127.0.0.1:${desktopPort}`;
const faultProxy = createServer(async (request, response) => {
  try {
    const uploading = request.method === "POST" && request.url?.split("?")[0] === "/api/v1/laps";
    const path = new URL(request.url ?? "/", proxyBase).pathname;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") && path.startsWith("/api/v1/me/stats")) {
      outboundProfileWrites.push(`${request.method} ${path}`);
    }
    if (Date.now() < offlineUntil) {
      if (uploading) offlineBodyStarts++;
      response.destroy();
      return;
    }
    const buffers: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024 * 1024) throw new Error("Fault proxy request exceeds fixture budget"); buffers.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(buffers);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !["host", "connection", "transfer-encoding"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    // Only the configured proxy origin is normalized; attacker-supplied origins remain rejected by Rust.
    if (headers.get("origin") === proxyBase) headers.set("origin", apiBase);
    if (request.method === "POST" && request.url?.split("?")[0] === "/api/v1/laps/reservations") {
      const now = Date.now();
      const key = headers.get("idempotency-key") ?? "";
      const retryNotBefore = reservationRetryNotBefore.get(key) ?? 0;
      if (now < retryNotBefore) retryViolation = `Reservation started ${retryNotBefore - now}ms before Retry-After`;
      const fault = reservationFaults[injectedReservationFaults.length];
      if (fault) {
        assertTransientLapResultNull(headers.get("idempotency-key") ?? "");
        injectedReservationFaults.push({ fault, key: headers.get("idempotency-key") ?? "", at: now });
        if (fault === "disconnect") { response.destroy(); return; }
        response.statusCode = Number(fault);
        response.setHeader("Content-Type", "application/json");
        if (fault === "429") {
          reservationRetryNotBefore.set(key, now + 2_000);
          response.setHeader("Retry-After", "2");
        }
        response.end(JSON.stringify({ error: { code: fault === "429" ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE", message: "Isolated reservation fault" } }));
        return;
      }
    }
      if (uploading) {
      bodyTransfers++;
      const key = headers.get("idempotency-key") ?? "";
      bodyRequestKeys.push(key);
      bodyIdempotencyKeys.add(key);
        if (transferFaults.length) {
          const multipart = await new Response(bytes, { headers: { "content-type": headers.get("content-type") ?? "" } }).formData();
          const recording = multipart.get("recording");
          assert.ok(recording instanceof File, "Retry fault must consume the actual recording multipart field");
          const hashes = transferRecordingHashes.get(key) ?? new Set<string>();
          hashes.add(createHash("sha256").update(new Uint8Array(await recording.arrayBuffer())).digest("hex"));
          transferRecordingHashes.set(key, hashes);
        }
        const fault = transferFaults[injectedTransferFaults.length];
        if (fault) {
          assertTransientLapResultNull(key);
          injectedTransferFaults.push({ fault, key, bytes: bytes.length });
          if (fault === "disconnect") { response.destroy(); return; }
          response.statusCode = 503;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "Isolated multipart transfer fault" } }));
          return;
        }
      }
      const upstream = await fetch(apiBase + request.url, { method: request.method, headers, ...(bytes.length ? { body: bytes } : {}), redirect: "error" });
    const payload = new Uint8Array(await upstream.arrayBuffer());
    if (uploading && upstream.status === 202 && droppedResponses === 0) {
      acceptedJobId = JSON.parse(Buffer.from(payload).toString()).id;
      acceptedRequestKey = headers.get("idempotency-key") ?? undefined;
      droppedResponses++; restartRequired = true;
      response.destroy(); desktop?.kill("SIGKILL"); dropped.resolve(); return;
    }
    response.statusCode = upstream.status;
    for (const name of ["content-type", "cache-control", "retry-after"]) { const value = upstream.headers.get(name); if (value) response.setHeader(name, value); }
    response.end(payload);
  } catch { if (!response.destroyed) { response.statusCode = 502; response.end(); } }
});
const proxyReady = Promise.withResolvers<void>(); faultProxy.listen(0, "127.0.0.1", proxyReady.resolve); await proxyReady.promise;
const proxyAddress = faultProxy.address(); assert.ok(proxyAddress && typeof proxyAddress === "object"); const proxyBase = `http://127.0.0.1:${proxyAddress.port}`;
const baseEnv = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR! };
function start(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd, env: { ...baseEnv, ...env }, stdout: "pipe", stderr: "pipe" }); children.add(child);
  const log = { text: "", done: Promise.resolve() };
  const collect = async (stream: ReadableStream<Uint8Array>) => { const reader = stream.getReader(); const decoder = new TextDecoder(); while (true) { const next = await reader.read(); if (next.done) break; log.text += decoder.decode(next.value, { stream: true }); } };
  log.done = Promise.all([collect(child.stdout), collect(child.stderr)]).then(() => undefined); childLogs.set(child, log); return child;
}
async function stop(child: Bun.Subprocess | undefined, crash = false) {
  if (!child) return; if (child.exitCode === null) child.kill(crash ? "SIGKILL" : "SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000); try { await child.exited; await childLogs.get(child)?.done; } finally { clearTimeout(timer); children.delete(child); }
}
async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeout = 90_000, interval = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; if (shuttingDown) throw new Error("Smoke interrupted"); await Bun.sleep(interval); }
  throw new Error(`Timed out: ${label}`);
}
async function ready(base: string, path: string) { await waitUntil(async () => { try { return (await fetch(base + path)).status === 200; } catch { return false; } }, `${path} readiness`); }
async function cloneDesktop(name: string, sameInstallation = true) {
  const destination = join(temporary, name); await mkdir(destination, { recursive: true });
  if (sameInstallation) await cp(join(sourceReal, "recording-installation-id"), join(destination, "recording-installation-id"));
  const original = new Database(join(sourceReal, "app.db"), { readonly: true });
  let localBindingCount = 0;
  try {
    assert.equal(original.prepare<{ online_user_id: string | null }>("SELECT online_user_id FROM local_account_owner WHERE id=1").get()?.online_user_id, owner);
    localBindingCount = original.prepare("SELECT COUNT(*) AS n FROM local_game_bindings").get()!.n;
    assert.ok(localBindingCount > 0, "Native source must preserve local game binding confirmations");
    copiedIdentities.set(destination, original.prepare<CapturedIdentityRow>(identitySql).all());
    original.prepare("VACUUM INTO ?").run(join(destination, "app.db"));
  } finally { original.close(); }
  await cp(join(sourceReal, "sessions"), join(destination, "sessions"), { recursive: true, mode: constants.COPYFILE_FICLONE });
  const local = new Database(join(destination, "app.db"));
  try {
    const cols = ["raw_file", "capture_manifest_file", "capture_archive_file"];
    for (const column of cols) {
      const records = local.prepare(`SELECT id,${column} AS path FROM sessions WHERE ${column} IS NOT NULL`).all() as Array<{ id: number; path: string }>;
      for (const record of records) { const canonical = await realpath(record.path); assert.ok(canonical.startsWith(sourceReal + sep)); local.prepare(`UPDATE sessions SET ${column}=? WHERE id=?`).run(join(destination, relative(sourceReal, canonical)), record.id); }
    }
    assert.equal(local.prepare("SELECT COUNT(*) AS n FROM local_game_bindings").get()!.n, localBindingCount);
  } finally { local.close(); }
  return destination;
}
function localClient() {
  let cookie = "", csrf = "";
  return async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(desktopBase + path, { method, headers: { Origin: desktopBase, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-RaceIQ-CSRF": csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    csrf = response.headers.get("x-raceiq-csrf") ?? csrf;
    return { status: response.status, data: await response.json(), cookie };
  };
}
const context = (state: { revision: number; accountEpoch: string }) => ({ expectedRevision: state.revision, accountEpoch: state.accountEpoch });
async function authenticate(local: ReturnType<typeof localClient>, other = false) {
  const access = await local("/api/auth/status");
  assert.equal(access.status, 200, `Dashboard auth status failed: ${JSON.stringify(access.data)}`);
  if (access.data.pending) {
    const setup = await local("/api/auth/setup", "POST", { password: dashboardPassword, exposureConfirmed: true });
    assert.equal(setup.status, 200, `Dashboard auth setup failed: ${JSON.stringify(setup.data)}`);
  }
  const login = await local("/api/auth/login", "POST", { password: dashboardPassword });
  assert.equal(login.status, 200, `Dashboard login failed: ${JSON.stringify(login.data)}`);
  const state = (await local("/api/online/state")).data;
  const connect = await local("/api/online/connect", "POST", context(state)); assert.equal(connect.status, 202);
  const authorization = new URL(connect.data.authorizationUrl); if (other) authorization.searchParams.set("login_hint", "other");
  const redirect = await fetch(authorization, { redirect: "manual", tls: { ca: cert } }); assert.equal(redirect.status, 302);
  return fetch(redirect.headers.get("location")!, { headers: { Cookie: connect.cookie }, redirect: "error" });
}
let desktopData: string;
function startDesktop() {
  desktop = start(["bun", "--no-env-file", "apps/backend/src/index.ts"], desktopRoot, { NODE_ENV: "test", DATA_DIR: desktopData, SERVER_HOST: "127.0.0.1", SERVER_PORT: String(desktopPort), UDP_PORT: String(udpPort), RACEIQ_DEV_UDP_PORT: String(udpPort), RACEIQ_E2E: "1", RACEIQ_E2E_ONLINE_ORIGIN: proxyBase, RACEIQ_E2E_AUTH_ORIGIN: authOrigin, RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "recovery-smoke-key", NODE_EXTRA_CA_CERTS: certFile!, RACEIQ_DISABLE_TRAY: "1", RACEIQ_LAUNCHER_OPENS_BROWSER: "0" });
}
function assertCopiedNativeIdentity(lapGuid: string | null) {
  const expected = copiedIdentities.get(desktopData)!;
  assert.ok(expected.some(row => row.lap_guid === lapGuid), "Accepted original must exist in the genuine pre-boot identity snapshot");
  const database = new Database(join(desktopData, "app.db"), { readonly: true });
  try {
    const actual = new Map<string, CapturedIdentityRow>();
    for (const row of database.prepare(identitySql).all()) actual.set(`${row.id}:${row.lap_id}`, row);
    for (const original of expected) {
      const current = actual.get(`${original.id}:${original.lap_id}`);
      assert.ok(current, "A previously captured original cannot disappear during boot or restore");
      for (const [field, value] of Object.entries(original)) {
        if (value !== null) assert.equal(current[field], value, `Known captured ${field} must remain immutable`);
      }
    }
  } finally { database.close(); }
}
function acceptedLapOutcome(): { lapId: number; lapGuid: string; result: string } | undefined {
  const database = new Database(join(desktopData, "app.db"), { readonly: true });
  try {
    return database.prepare(`SELECT id AS lapId,lap_guid AS lapGuid,online_upload_result AS result FROM laps
      WHERE online_remote_job_id=? AND online_upload_result='success'`).get(acceptedJobId) as
      { lapId: number; lapGuid: string; result: string } | undefined;
  } finally { database.close(); }
}
function assertTransientLapResultNull(key: string) {
  const database = new Database(join(desktopData, "app.db"), { readonly: true });
  try {
    const result = database.prepare("SELECT online_upload_result FROM laps WHERE online_idempotency_key=?").get(key);
    assert.ok(result, "Transient request must belong to a retained lap");
    assert.equal(result.online_upload_result, null, "Retryable transport failure must not become terminal outcome");
  } finally { database.close(); }
}
async function verifyUdpOverload(local: ReturnType<typeof localClient>, fixture: string, offlineCapture = false) {
  assert.equal((await authenticate(local)).status, 200);
  const state = (await local("/api/online/state")).data;
  assert.equal(state.connection.status, "connected");
  assert.equal(state.consent.status, "accepted");
  assert.equal(state.preferences.visibility, "public", "An unrelated privacy gate must not explain held capture");
  const database = new Database(join(desktopData, "app.db"), { readonly: true });
  const before = database.prepare("SELECT COALESCE(MAX(id),0) AS id FROM sessions").get()!.id;
  const committed = () => database.prepare("SELECT s.id,s.owner_user_id,s.original_activity_id,l.id AS lap_id,l.lap_guid,l.lap_time FROM sessions s LEFT JOIN laps l ON l.session_id=s.id WHERE s.id<=? ORDER BY s.id,l.id").all(before);
  const original = committed();
  const transfersBeforeOverload = bodyTransfers;
  const packets: Uint8Array[] = [];
  for (const record of iterateSessionCaptureRecords(decompressIfGzipSync(await readFile(fixture)))) {
    if (record.kind === "frame") packets.push(record.frame);
  }
  assert.ok(packets.length > 1000, "Genuine F1 UDP fixture is required");
  const notifications: Array<{ type: string; sessionId?: number; error?: string }> = [];
  const cookie = (await local("/api/auth/status")).cookie;
  // This fixture runs in Bun; DOM typings omit its supported headers overload.
  const ClientWebSocket = WebSocket as typeof WebSocket & (new (url: string, options: { headers: Record<string, string> }) => WebSocket);
  const socket = new ClientWebSocket(desktopBase.replace("http:", "ws:") + "/ws", { headers: { Cookie: cookie, Origin: desktopBase } });
  const connected = Promise.withResolvers<void>();
  socket.addEventListener("open", () => connected.resolve(), { once: true });
  socket.addEventListener("error", () => connected.reject(new Error("Authenticated overload observation socket failed")), { once: true });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    if (message.type === "recording-failed") notifications.push(message);
  });
  const udp = createSocket("udp4");
  const send = (packet: Uint8Array) => new Promise<void>((resolve, reject) => udp.send(packet, udpPort, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  try {
    await connected.promise;
    // Real SQLite writer contention holds native session creation while genuine
    // distinct datagrams arrive. Repeating one F1 frame can be parser-deduped.
    const writer = new Database(join(desktopData, "app.db"));
    writer.exec("BEGIN IMMEDIATE");
    try {
      await Promise.all(packets.slice(0, 8192).map(send));
      await Bun.sleep(200);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    await waitUntil(() => notifications.some((event) => event.error === "Recording detector queue capacity exhausted"), "actual UDP detector overload notification", 30_000);
    assert.equal(desktop?.exitCode, null, "UDP saturation must not terminate the application");
    assert.equal((await local("/api/auth/status")).status, 200);
    assert.equal(bodyTransfers, transfersBeforeOverload, "Overloaded input must not start a recording upload");
    assert.deepEqual(committed(), original, "Previously committed identity and timing must survive overload");
    if (offlineCapture) {
      const current = (await local("/api/online/state")).data;
      const signedOut = await local("/api/online/sign-out", "POST", context(current));
      assert.equal(signedOut.status, 200);
      assert.equal(signedOut.data.state.connection.status, "signed_out");
      offlineUntil = Date.now() + 180_000;
    }
    const affected = notifications.find((event) => event.error === "Recording detector queue capacity exhausted")!.sessionId;
    assert.ok(affected && affected > before);

    // Pace the same genuine recording normally; no test hook changes capacity.
    const healthyAfter = database.prepare("SELECT MAX(id) AS id FROM sessions").get()!.id;
    let healthyLap: { id: number; session_id: number } | null = null;
    for (let index = 0; index < packets.length && index < 100_000; index++) {
      await send(packets[index]!);
      if ((index & 15) === 15) await Bun.sleep(20);
      if ((index & 255) === 255) {
        healthyLap = database.prepare("SELECT l.id,l.session_id FROM laps l JOIN sessions s ON s.id=l.session_id WHERE s.id>? AND l.is_valid=1 AND l.driver_attribution='Self' ORDER BY l.id LIMIT 1").get(healthyAfter);
        if (healthyLap) break;
        assert.equal((await local("/api/auth/status")).status, 200);
      }
    }
    assert.ok(healthyLap, "Subsequent healthy native capture must produce a complete valid Self lap without restarting");
    if (offlineCapture) {
      assert.equal(bodyTransfers, transfersBeforeOverload, "Signed-out offline capture must not start a recording body");
      assert.equal(offlineBodyStarts, 0, "Signed-out native capture must not attempt hosted transport");
    }
    await stop(desktop); desktop = undefined;
    assert.deepEqual(committed(), original);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM laps WHERE session_id=? AND is_valid=1").get(affected)!.n, 0);
    results.udpOverload = { affectedSessionId: affected, healthyLapId: healthyLap.id, committedIdentityPreserved: true, maximumBurstDatagrams: 8192 };
    if (offlineCapture) results.offlineCapture = { signedOut: true, completeLocalSelfLap: true, hostedBodyStarts: offlineBodyStarts };
  } finally {
    socket.close(); udp.close(); database.close(); offlineUntil = 0;
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { shuttingDown = true; for (const child of children) child.kill("SIGTERM"); });
const results: Record<string, unknown> = {};
let succeeded = false;
try {
  desktopData = await cloneDesktop("device-one");
  const sameInstallationId = await readFile(join(desktopData, "recording-installation-id"));
  const policy = { RACEIQ_TERMS_VERSION: "recovery-terms", RACEIQ_PRIVACY_VERSION: "recovery-privacy", RACEIQ_TERMS_URL: "https://example.test/terms", RACEIQ_PRIVACY_URL: "https://example.test/privacy" };
  const storage = { SQLITE_PATH: join(temporary, "cloud.sqlite"), UPLOAD_DIR: join(temporary, "uploads"), DISCORD_BOT_TOKEN: "", ...policy };
  cloud = start([join(cloudRoot!, "apps/raceiq/target/debug/raceiq-server")], cloudRoot!, { ...storage, HOST: "127.0.0.1", PORT: String(apiPort), HTTP_METRICS_HOST: "127.0.0.1", HTTP_METRICS_PORT: "0", PUBLIC_BASE_URL: apiBase, SUPABASE_URL: providerBase, SUPABASE_PUBLISHABLE_KEY: "recovery-smoke-key", PUBLIC_API_RATE_LIMIT_PER_MINUTE: "60000", PUBLIC_API_RATE_LIMIT_BURST: "10000", PUBLIC_API_TRUSTED_PROXY_IPS: "" });
  await ready(apiBase, "/healthz");
  processor = start(["bun", "--no-env-file", "apps/lap-processor/src/main.ts"], cloudRoot!, { ...storage, LAP_PROCESSOR_METRICS_HOST: "127.0.0.1", LAP_PROCESSOR_METRICS_PORT: String(metricsPort), RETENTION_MODE: "enabled" });
  cloudDb = new Database(storage.SQLITE_PATH, { readonly: true });
  startDesktop(); await ready(desktopBase, "/api/auth/status");
  let local = localClient(); assert.equal((await authenticate(local)).status, 200);
  let state = (await local("/api/online/state")).data;
  assert.equal((await local("/api/online/consent", "PUT", { ...context(state), acceptedPolicyVersions: state.policy.versions })).status, 200);
  state = (await local("/api/online/state")).data;
  assert.equal((await local("/api/online/preferences", "PUT", { ...context(state), preferences: { visibility: "public", setupUploads: false } })).status, 200);
  // The proxy drops first accepted response; restart must resolve it with lap-owned request identity.
  await waitUntil(() => restartRequired, "service accepted response dropped and desktop crashed", 90_000 * (transferFaults.length + 1)); await dropped.promise;
  await stop(desktop, true); desktop = undefined;
  assert.equal(bodyTransfers, transferFaults.length + 1); assert.equal(droppedResponses, 1); assert.ok(acceptedJobId);
  assert.ok(acceptedRequestKey);
  const requestKey = acceptedRequestKey;
  const acceptedBodyAttempts = bodyRequestKeys.filter(key => key === requestKey).length;
  assert.match(requestKey, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Lap request key must be UUIDv7");
  const lapDb = new Database(join(desktopData, "app.db"), { readonly: true });
  const requestBeforeRestart = lapDb.prepare(`SELECT online_account_id,online_idempotency_key,online_identity_json,online_payload_fingerprint,
    online_reservation_token,online_upload_result,online_remote_job_id,online_uploaded_at,online_result_at FROM laps WHERE online_idempotency_key=?`).get(requestKey) as
    { online_account_id: string; online_idempotency_key: string; online_identity_json: string; online_payload_fingerprint: string;
      online_reservation_token: string | null; online_upload_result: string | null; online_remote_job_id: string | null;
      online_uploaded_at: string | null; online_result_at: string | null } | undefined;
  assert.ok(requestBeforeRestart);
  assert.equal(requestBeforeRestart.online_account_id, owner);
  assert.equal(requestBeforeRestart.online_idempotency_key, requestKey);
  assert.ok(requestBeforeRestart.online_identity_json && requestBeforeRestart.online_payload_fingerprint);
  assert.ok(requestBeforeRestart.online_reservation_token, "Accepted request must retain its reservation token");
  assert.equal(requestBeforeRestart.online_upload_result, null, "Lost response must not create a terminal outcome before restart");
  assert.equal(requestBeforeRestart.online_uploaded_at, null);
  assert.equal(requestBeforeRestart.online_result_at, null);
  assert.equal(requestBeforeRestart.online_remote_job_id, null);
  lapDb.close();
  results.acceptanceResponseLost = { bodyTransfers, droppedResponses, remoteJobId: acceptedJobId, requestKey };
  startDesktop(); await ready(desktopBase, "/api/auth/status"); local = localClient(); assert.equal((await authenticate(local)).status, 200);
  assert.deepEqual(await readFile(join(desktopData, "recording-installation-id")), sameInstallationId, "Restart must preserve installation identity");
  let accepted: { lapId: number; lapGuid: string; result: string } | undefined;
  await waitUntil(() => { accepted = acceptedLapOutcome(); return !!accepted; }, "restarted app records lap success outcome", 180_000);
  assert.ok(accepted);
  assert.ok(bodyRequestKeys.includes(requestKey), "Restarted app must retain original request key");
  assert.equal(bodyRequestKeys.filter(key => key === requestKey).length, acceptedBodyAttempts,
    "Lost response must not cause another body transfer, even under a fresh key");
  const afterDb = new Database(join(desktopData, "app.db"), { readonly: true });
  const requestAfterRestart = afterDb.prepare(`SELECT online_account_id,online_idempotency_key,online_identity_json,online_payload_fingerprint,
    online_reservation_token,online_upload_result,online_remote_job_id,online_uploaded_at,online_result_at FROM laps WHERE id=?`).get(accepted.lapId) as typeof requestBeforeRestart;
  assert.ok(requestAfterRestart);
  assert.deepEqual(
    [requestAfterRestart.online_account_id, requestAfterRestart.online_idempotency_key, requestAfterRestart.online_identity_json,
      requestAfterRestart.online_payload_fingerprint, requestAfterRestart.online_reservation_token],
    [requestBeforeRestart.online_account_id, requestBeforeRestart.online_idempotency_key, requestBeforeRestart.online_identity_json,
      requestBeforeRestart.online_payload_fingerprint, requestBeforeRestart.online_reservation_token],
  );
  assert.equal(requestAfterRestart.online_upload_result, "success");
  assert.equal(requestAfterRestart.online_remote_job_id, acceptedJobId);
  assert.ok(requestAfterRestart.online_uploaded_at && requestAfterRestart.online_result_at);
  assert.ok(afterDb.prepare("SELECT 1 FROM online_fastest_combo_laps WHERE lap_id=?").get(accepted.lapId), "Recovered lap must still be a current winner");
  assertCopiedNativeIdentity(accepted.lapGuid);
  const lmuOutcome = afterDb.prepare(`SELECT l.online_upload_result FROM online_fastest_combo_laps w JOIN laps l ON l.id=w.lap_id
    WHERE w.game_id='lmu'`).get()?.online_upload_result;
  assert.notEqual(lmuOutcome, undefined, "Native fixture must contain an unrelated LMU winner");
  await waitUntil(() => afterDb.prepare(`SELECT l.online_upload_result FROM online_fastest_combo_laps w JOIN laps l ON l.id=w.lap_id
    WHERE w.game_id='lmu'`).get()?.online_upload_result === "success", "unrelated LMU winner receives successful upload", 180_000);
  await waitUntil(() => cloudDb!.prepare("SELECT status FROM lap_uploads WHERE id=?").get(acceptedJobId!)?.status === "completed", "native processing completion");
  const expectedWinnerCount = afterDb.prepare("SELECT COUNT(*) AS n FROM online_fastest_combo_laps").get()!.n;
  assert.equal(expectedWinnerCount, 2, "Native source must contain exactly F1 and LMU current winners");
  const acceptedWinnerJobs = cloudDb.prepare("SELECT COUNT(*) AS n FROM lap_uploads").get()!.n;
  assert.equal(acceptedWinnerJobs, expectedWinnerCount, "Each current winner must produce one hosted acceptance, without duplicates");
  assert.equal(bodyIdempotencyKeys.size, expectedWinnerCount, "Restart must not introduce a fresh request identity for an accepted lap");
  results.restartLapOutcome = { sameKeyBodyAttempts: acceptedBodyAttempts, result: accepted.result, lapGuid: accepted.lapGuid };
  if (process.env.RACEIQ_OVERLOAD_FIXTURE) await verifyUdpOverload(local, process.env.RACEIQ_OVERLOAD_FIXTURE, offlineCapture);
  else { await stop(desktop); desktop = undefined; }
  const jobsBeforeForeignCopy = cloudDb.prepare("SELECT COUNT(*) AS n FROM lap_uploads").get()!.n;
  const bodyTransfersBeforeForeignCopy = bodyRequestKeys.length;
  afterDb.close();
  desktopData = await cloneDesktop("foreign-installation", false);
  await assert.rejects(readFile(join(desktopData, "recording-installation-id")), error => (error as NodeJS.ErrnoException).code === "ENOENT");
  startDesktop(); await ready(desktopBase, "/api/auth/status"); local = localClient(); assert.equal((await authenticate(local)).status, 200);
  state = (await local("/api/online/state")).data;
  assert.equal((await local("/api/online/preferences", "PUT", { ...context(state), preferences: { visibility: "public", setupUploads: false } })).status, 200);
  await Bun.sleep(65_000);
  assert.equal(bodyRequestKeys.length, bodyTransfersBeforeForeignCopy, "Foreign installation must not add a body transfer");
  assert.equal(cloudDb.prepare("SELECT COUNT(*) AS n FROM lap_uploads").get()?.n, jobsBeforeForeignCopy);
  assertCopiedNativeIdentity(accepted.lapGuid);
  results.foreignInstallationRejected = { additionalBodyTransfers: 0, cloudJobs: jobsBeforeForeignCopy, originalGuidPreserved: true };
  const rejectedAccount = await authenticate(local, true); assert.equal(rejectedAccount.status, 400, "Another Online account cannot claim this installation's originals");
  assert.equal(bodyRequestKeys.length, bodyTransfersBeforeForeignCopy, "Wrong-account authentication must not trigger uploads");
  assert.equal(cloudDb.prepare("SELECT COUNT(*) AS n FROM laps WHERE user_id=?").get(otherOwner)?.n, 0);
  results.otherAccountRejected = true;
  if (transferFaults.length) {
    assert.equal(injectedTransferFaults.length, transferFaults.length);
    for (const { key } of injectedTransferFaults) {
      assert.ok(bodyRequestKeys.filter(attempt => attempt === key).length >= 2, "Each failed lap body must retry with its original request key");
    }
    assert.ok([...transferRecordingHashes.values()].every(hashes => hashes.size === 1), "Each lap's retry bodies must preserve exact recording bytes");
    results.multipartTransferFailures = { injected: injectedTransferFaults, stableRequestKey: true, cloudJobs: jobsBeforeForeignCopy };
  }
  if (reservationFaults.length) {
    assert.equal(injectedReservationFaults.length, reservationFaults.length);
    assert.equal(retryViolation, null, "Observed reservation request times must honor Retry-After");
    for (const { key } of injectedReservationFaults) {
      assert.ok(bodyIdempotencyKeys.has(key), "Each failed reservation must retain its request key through body acceptance");
    }
    results.reservationFailures = { injected: reservationFaults, retryAfterHonored: true, stableRequestKey: true };
  }
  assert.deepEqual(outboundProfileWrites, [], "No profile synchronization writes are permitted");
  console.log(JSON.stringify({ scenario: "actual-desktop-upload-http-recovery", passed: true, results }));
  succeeded = true;
} catch (error) {
  results.transport = { bodyTransfers, bodyRequestKeys, droppedResponses, injectedTransferFaults, injectedReservationFaults, reservationRetryViolation: retryViolation };
  for (const [child, log] of childLogs) { await writeFile(join(temporary, `child-${child.pid}.log`), log.text); }
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : "smoke failure", results, evidenceDirectory: temporary })); throw error;
} finally {
  shuttingDown = true; await stop(desktop); await stop(processor); await stop(cloud); cloudDb?.close();
  faultProxy.closeAllConnections(); faultProxy.close(); tlsProvider.stop(true); plainProvider.stop(true);
  if (succeeded) await rm(temporary, { recursive: true, force: true });
}
