import Database from "libsql";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { constants, createReadStream } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { UploadItem } from "@raceiq/online/contracts";
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
const durableRecovery = process.env.RACEIQ_UPLOAD_DURABLE_RECOVERY === "1";
assert.ok(!durableRecovery || (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0), "Storage-denial verification requires a non-root POSIX host");
const offlineDuration = durableRecovery ? 180_000 : 0;
let offlineUntil = 0, offlineRequestCount = 0, offlineBodyStarts = 0;
let outageArmed = false;
const recoveryAuthenticated = Promise.withResolvers<void>();
const offlineRoutes = new Map<string, number>();
let offlineHealthChecks = 0;
const injectedTransferFaults: Array<{ fault: string; key: string; bytes: number }> = [];
const transferRecordingHashes = new Set<string>();
const injectedReservationFaults: Array<{ fault: string; key: string; at: number }> = [];
let reservationRetryNotBefore = 0, retryViolation: string | null = null;
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
const acceptedKeys = new Set<string>();
type CapturedIdentityRow = Record<string, string | number | null>;
const identitySql = "SELECT s.id,s.owner_user_id,s.original_activity_id,s.created_at,l.id AS lap_id,l.lap_guid,l.lap_time,l.recorded_at FROM sessions s JOIN laps l ON l.session_id=s.id WHERE l.lap_guid IS NOT NULL ORDER BY s.id,l.id";
const copiedIdentities = new Map<string, CapturedIdentityRow[]>();
let bodyTransfers = 0, droppedResponses = 0, acceptedJobId: string | undefined;
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
    if (durableRecovery && restartRequired && !outageArmed &&
        request.method === "POST" && request.url?.split("?")[0] === "/api/v1/laps/reservations") {
      outageArmed = true;
      await recoveryAuthenticated.promise;
      offlineUntil = Date.now() + offlineDuration;
    }
    if (Date.now() < offlineUntil) {
      offlineRequestCount++;
      const route = `${request.method} ${new URL(request.url!, apiBase).pathname}`;
      offlineRoutes.set(route, (offlineRoutes.get(route) ?? 0) + 1);
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
      if (now < reservationRetryNotBefore) retryViolation = `Reservation started ${reservationRetryNotBefore - now}ms before Retry-After`;
      const fault = reservationFaults[injectedReservationFaults.length];
      if (fault) {
        injectedReservationFaults.push({ fault, key: headers.get("idempotency-key") ?? "", at: now });
        if (fault === "disconnect") { response.destroy(); return; }
        response.statusCode = Number(fault);
        response.setHeader("Content-Type", "application/json");
        if (fault === "429") {
          reservationRetryNotBefore = now + 2_000;
          response.setHeader("Retry-After", "2");
        }
        response.end(JSON.stringify({ error: { code: fault === "429" ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE", message: "Isolated reservation fault" } }));
        return;
      }
    }
      if (uploading) {
        bodyTransfers++;
        const key = headers.get("idempotency-key") ?? "";
        acceptedKeys.add(key);
        if (transferFaults.length) {
          const multipart = await new Response(bytes, { headers: { "content-type": headers.get("content-type") ?? "" } }).formData();
          const recording = multipart.get("recording");
          assert.ok(recording instanceof File, "Retry fault must consume the actual recording multipart field");
          transferRecordingHashes.add(createHash("sha256").update(new Uint8Array(await recording.arrayBuffer())).digest("hex"));
        }
        const fault = transferFaults[injectedTransferFaults.length];
        if (fault) {
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
async function cloneDesktop(name: string) {
  const destination = join(temporary, name); await mkdir(destination, { recursive: true });
  const original = new Database(join(sourceReal, "app.db"), { readonly: true });
  try {
    assert.equal(original.query<{ online_user_id: string | null }, []>("SELECT online_user_id FROM local_account_owner WHERE id=1").get()?.online_user_id, owner);
    copiedIdentities.set(destination, original.query<CapturedIdentityRow, []>(identitySql).all());
    await writeFile(join(destination, "app.db"), original.serialize());
  } finally { original.close(); }
  await cp(join(sourceReal, "sessions"), join(destination, "sessions"), { recursive: true, mode: constants.COPYFILE_FICLONE });
  const local = new Database(join(destination, "app.db"));
  try {
    const cols = ["raw_file", "capture_manifest_file", "capture_archive_file"];
    for (const column of cols) {
      const records = local.query(`SELECT id,${column} AS path FROM sessions WHERE ${column} IS NOT NULL`).all() as Array<{ id: number; path: string }>;
      for (const record of records) { const canonical = await realpath(record.path); assert.ok(canonical.startsWith(sourceReal + sep)); local.query(`UPDATE sessions SET ${column}=? WHERE id=?`).run(join(destination, relative(sourceReal, canonical)), record.id); }
    }
  } finally { local.close(); }
  const bindingsSource = new Database(join(sourceReal, "raceiq-online-bindings.db"), { readonly: true });
  try { await writeFile(join(destination, "raceiq-online-bindings.db"), bindingsSource.serialize()); } finally { bindingsSource.close(); }
  // A new deployment must register its remote IDs anew; captured local confirmations stay intact.
  const bindings = new Database(join(destination, "raceiq-online-bindings.db")); try { bindings.exec("DELETE FROM registered_bindings"); } finally { bindings.close(); }
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
  assert.equal((await local("/api/auth/login", "POST", { password: dashboardPassword })).status, 200);
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
async function dataDigests(directory: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        files.push([relative(directory, path), hash.digest("hex")]);
      }
    }
  };
  await visit(directory);
  return files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}
function assertCopiedNativeIdentity(lapGuid: string | null) {
  const expected = copiedIdentities.get(desktopData)!;
  assert.ok(expected.some(row => row.lap_guid === lapGuid), "Accepted original must exist in the genuine pre-boot identity snapshot");
  const database = new Database(join(desktopData, "app.db"), { readonly: true });
  try {
    const actual = new Map<string, CapturedIdentityRow>();
    for (const row of database.query<CapturedIdentityRow, []>(identitySql).all()) actual.set(`${row.id}:${row.lap_id}`, row);
    for (const original of expected) {
      const current = actual.get(`${original.id}:${original.lap_id}`);
      assert.ok(current, "A previously captured original cannot disappear during boot or restore");
      for (const [field, value] of Object.entries(original)) {
        if (value !== null) assert.equal(current[field], value, `Known captured ${field} must remain immutable`);
      }
    }
  } finally { database.close(); }
}
async function acceptedReceipt(local: ReturnType<typeof localClient>): Promise<UploadItem | undefined> {
  const current = (await local("/api/online/state")).data;
  const history = (await local("/api/online/uploads?" + new URLSearchParams({
    accountEpoch: current.accountEpoch, expectedRevision: String(current.revision), view: "history", limit: "50",
  }))).data as { items?: UploadItem[] };
  return history.items?.find(item => item.remoteJobId === acceptedJobId && item.delivery === "accepted");
}
async function verifyDeniedStorageStartup() {
  const mode = (await stat(desktopData)).mode & 0o7777;
  try {
    await chmod(desktopData, 0);
    await assert.rejects(access(join(desktopData, "app.db"), constants.R_OK), error =>
      ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""));
    startDesktop();
    const denied = desktop!;
    await waitUntil(() => denied.exitCode !== null, "unreadable app storage rejects startup", 30_000);
    await childLogs.get(denied)!.done;
    assert.notEqual(denied.exitCode, 0, "Inaccessible storage must not be reported as a healthy startup");
    const error = childLogs.get(denied)!.text.split(/\r?\n/).find(line =>
      /EACCES|permission denied|SQLITE_CANTOPEN|(?:cannot|unable|failed).*open.*database/i.test(line));
    assert.ok(error, "Failed startup must identify the actual storage error");
    return { startupRejected: true, exitCode: denied.exitCode, error };
  } finally {
    await stop(desktop, true);
    desktop = undefined;
    await chmod(desktopData, mode);
  }
}
async function verifyUdpOverload(local: ReturnType<typeof localClient>, fixture: string, offlineCapture = false) {
  assert.equal((await authenticate(local)).status, 200);
  const state = (await local("/api/online/state")).data;
  assert.equal(state.connection.status, "connected");
  assert.equal(state.consent.status, "accepted");
  assert.equal(state.preferences.visibility, "public", "An unrelated privacy gate must not explain held capture");
  const database = new Database(join(desktopData, "app.db"), { readonly: true });
  const before = database.query<{ id: number }, []>("SELECT COALESCE(MAX(id),0) AS id FROM sessions").get()!.id;
  const committed = () => database.query("SELECT s.id,s.owner_user_id,s.original_activity_id,l.id AS lap_id,l.lap_guid,l.lap_time FROM sessions s LEFT JOIN laps l ON l.session_id=s.id WHERE s.id<=? ORDER BY s.id,l.id").all(before);
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
      offlineUntil = Date.now() + 120_000;
    }
    const affected = notifications.find((event) => event.error === "Recording detector queue capacity exhausted")!.sessionId;
    assert.ok(affected && affected > before);

    // Pace the same genuine recording normally; no test hook changes capacity.
    const healthyAfter = database.query<{ id: number }, []>("SELECT MAX(id) AS id FROM sessions").get()!.id;
    let healthyLap: { id: number; session_id: number } | null = null;
    for (let index = 0; index < packets.length && index < 100_000; index++) {
      await send(packets[index]!);
      if ((index & 15) === 15) await Bun.sleep(20);
      if ((index & 255) === 255) {
        healthyLap = database.query<{ id: number; session_id: number }, [number]>("SELECT l.id,l.session_id FROM laps l JOIN sessions s ON s.id=l.session_id WHERE s.id>? AND l.is_valid=1 AND l.driver_attribution='Self' ORDER BY l.id LIMIT 1").get(healthyAfter);
        if (healthyLap) break;
        assert.equal((await local("/api/auth/status")).status, 200);
      }
    }
    assert.ok(healthyLap, "Subsequent healthy native capture must produce a complete valid Self lap without restarting");
    await stop(desktop); desktop = undefined;
    assert.deepEqual(committed(), original);
    const affectedSession = database.query<{ original_activity_id: string; capture_manifest_file: string }, [number]>("SELECT original_activity_id,capture_manifest_file FROM sessions WHERE id=?").get(affected)!;
    assert.equal(database.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM original_activity_sources WHERE original_activity_id=?").get(affectedSession.original_activity_id)!.n, 0, "Overloaded source must not receive complete-original proof");
    assert.equal(JSON.parse(await readFile(affectedSession.capture_manifest_file, "utf8")).sourceClosed, false);
    assert.equal(database.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM laps WHERE session_id=? AND is_valid=1").get(affected)!.n, 0);
    const heldLapIds = database.query<{ id: number }, [number]>("SELECT id FROM laps WHERE session_id=?").all(affected).map((lap) => lap.id);
    const probe = start(["bun", "--no-env-file", "--eval", `import { readOnlineLapSource } from "./server/session-capture/online-source.ts"; const ids=${JSON.stringify([...heldLapIds, healthyLap.id])}; const results=[]; for(const id of ids){const source=await readOnlineLapSource(id); results.push({id,kind:source.kind,...(source.kind==="held"?{reason:source.reason}:{})});} console.log(JSON.stringify(results)); process.exit(0);`], desktopRoot, { NODE_ENV: "test", DATA_DIR: desktopData });
    assert.equal(await probe.exited, 0); await childLogs.get(probe)!.done; children.delete(probe);
    const eligibility = JSON.parse(childLogs.get(probe)!.text.trim().split("\n").findLast((line) => line.startsWith("["))!);
    for (const id of heldLapIds) assert.equal(eligibility.find((result: { id: number }) => result.id === id)?.kind, "held");
    assert.equal(eligibility.find((result: { id: number }) => result.id === healthyLap!.id)?.kind, "ready");
    results.udpOverload = { affectedSessionId: affected, affectedLapCount: heldLapIds.length, healthyLapId: healthyLap.id, committedIdentityPreserved: true, completeOriginalProof: false, incompleteSourceHeld: true, healthySourceReady: true, maximumBurstDatagrams: 8192 };
    if (offlineCapture) {
      assert.equal(bodyTransfers, transfersBeforeOverload, "Signed-out offline capture must not start a recording body");
      results.offlineCaptureAfterRestore = { signedOut: true, cloudAccessDenied: true, completeLocalSelfLap: true, healthySourceReady: true, additionalBodyTransfers: 0 };
    }
  } finally {
    socket.close(); udp.close(); database.close();
    if (offlineCapture) offlineUntil = 0;
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { shuttingDown = true; for (const child of children) child.kill("SIGTERM"); });
const results: Record<string, unknown> = {};
let succeeded = false;
try {
  desktopData = await cloneDesktop("device-one");
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
  // Ambiguous multipart failures retain the real server reservation's 90-second retry lease.
  await waitUntil(() => restartRequired, "server accepted response dropped and desktop crashed", 90_000 * (transferFaults.length + 1)); await dropped.promise;
  await stop(desktop, true); desktop = undefined;
  assert.equal(bodyTransfers, transferFaults.length + 1); assert.equal(droppedResponses, 1); assert.ok(acceptedJobId);
  results.acceptanceResponseLost = { bodyTransfers, droppedResponses, remoteJobId: acceptedJobId };
  const storageFailure = durableRecovery ? await verifyDeniedStorageStartup() : undefined;
  if (storageFailure) results.storageDeniedStartup = storageFailure;
  startDesktop(); await ready(desktopBase, "/api/auth/status"); local = localClient(); assert.equal((await authenticate(local)).status, 200);
  recoveryAuthenticated.resolve();
  if (durableRecovery) {
    await waitUntil(() => outageArmed && offlineUntil > 0, "authenticated background reconciliation starts outage", 120_000);
    await waitUntil(async () => {
      if (Date.now() >= offlineUntil) return true;
      assert.equal((await fetch(desktopBase + "/api/auth/status", { signal: AbortSignal.timeout(2_000) })).status, 200);
      offlineHealthChecks++;
      return false;
    }, "main app remains available through connection outage", offlineDuration + 30_000, 1_000);
  }
  let receipt: UploadItem | undefined;
  await waitUntil(async () => { receipt = await acceptedReceipt(local); return !!receipt; }, "actual app reconciles durable acceptance after crash", offlineDuration + 240_000);
  assert.ok(receipt);
  assert.equal(bodyTransfers, transferFaults.length + 1, "Restart must reconcile acceptance before another recording transfer"); assert.equal(acceptedKeys.size, 1);
  await waitUntil(() => cloudDb!.query<{ status: string }, [string]>("SELECT status FROM lap_uploads WHERE id=?").get(acceptedJobId!)?.status === "completed", "native processing completion");
  assert.equal(cloudDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lap_uploads").get()?.n, 1);
  assert.equal(cloudDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM laps WHERE publication_status='public'").get()?.n, 1);
  assertCopiedNativeIdentity(receipt.lapGuid);
  results.restartReconciled = { bodyTransfers, stableRequestKeys: acceptedKeys.size, delivery: receipt.delivery, lapGuid: receipt.lapGuid };
  if (durableRecovery) {
    assert.ok(Date.now() >= offlineUntil, "Durable acceptance must reconcile after the full connection outage");
    assert.ok(offlineRequestCount > 1, "The running app must observe repeated connection failures");
    assert.equal(offlineBodyStarts, 0, "Unknown acceptance cannot authorize another body during outage");
    assert.ok((offlineRoutes.get("POST /api/v1/laps/reservations") ?? 0) <= Math.ceil(offlineDuration / 90_000) + 1,
      "Ambiguous acceptance retries must remain bounded by the reservation lease");
    results.offlineRecovery = { outageMilliseconds: offlineDuration, failedRequests: offlineRequestCount, byRoute: Object.fromEntries(offlineRoutes), offlineHealthChecks, bodyStartsDuringOutage: offlineBodyStarts, receiptReconciled: true };
    results.storageRecovery = { ...storageFailure, stableRequestKeys: acceptedKeys.size, originalGuidPreserved: true };
  }
  await stop(desktop); desktop = undefined;
  if (durableRecovery) {
    const accepted = receipt;
    assert.ok(accepted.acceptedAt, "The backup must contain an actual durable accepted receipt");
    const backup = join(temporary, "accepted-data-backup");
    const beforeRestore = await dataDigests(desktopData);
    await cp(desktopData, backup, { recursive: true, preserveTimestamps: true });
    await rename(desktopData, join(temporary, "pre-restore-data"));
    await cp(backup, desktopData, { recursive: true, preserveTimestamps: true });
    assert.deepEqual(await dataDigests(desktopData), beforeRestore, "Restore must preserve every backed-up data file exactly");
    startDesktop(); await ready(desktopBase, "/api/auth/status"); local = localClient();
    assert.equal((await authenticate(local)).status, 200);
    let restored: UploadItem | undefined;
    await waitUntil(async () => { restored = await acceptedReceipt(local); return !!restored; }, "restored app exposes its accepted receipt");
    assert.deepEqual(
      [restored!.id, restored!.lapGuid, restored!.remoteJobId, restored!.admittedAt, restored!.acceptedAt],
      [accepted.id, accepted.lapGuid, accepted.remoteJobId, accepted.admittedAt, accepted.acceptedAt],
      "Restore preserves original delivery identity and receipt timestamps",
    );
    assert.equal(bodyTransfers, transferFaults.length + 1, "Restored accepted state must not transfer another recording");
    assertCopiedNativeIdentity(restored!.lapGuid);
    results.acceptedReceiptRestore = { deliveryIdPreserved: true, originalGuidPreserved: true, knownNativeIdentityPreserved: true, acceptedAtPreserved: true, dataFilesPreserved: beforeRestore.length, additionalBodyTransfers: 0 };
    if (process.env.RACEIQ_OVERLOAD_FIXTURE) await verifyUdpOverload(local, process.env.RACEIQ_OVERLOAD_FIXTURE, true);
    await stop(desktop); desktop = undefined;
  }
  desktopData = await cloneDesktop("device-two"); startDesktop(); await ready(desktopBase, "/api/auth/status"); local = localClient(); assert.equal((await authenticate(local)).status, 200);
  state = (await local("/api/online/state")).data;
  assert.equal((await local("/api/online/preferences", "PUT", { ...context(state), preferences: { visibility: "public", setupUploads: false } })).status, 200);
  await waitUntil(async () => !!await acceptedReceipt(local), "second device reconciles already uploaded original", 120_000);
  assert.equal(bodyTransfers, transferFaults.length + 1); assert.equal(cloudDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lap_uploads").get()?.n, 1);
  results.secondDevice = { additionalBodyTransfers: 0, cloudJobs: 1, originalGuidPreserved: true };
  const rejectedAccount = await authenticate(local, true); assert.equal(rejectedAccount.status, 400, "Another Online account cannot claim this installation's originals");
  assert.equal(bodyTransfers, transferFaults.length + 1); assert.equal(cloudDb.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM laps WHERE user_id=?").get(otherOwner)?.n, 0);
  results.otherAccountRejected = true;
  if (transferFaults.length) {
    assert.equal(injectedTransferFaults.length, transferFaults.length);
    assert.equal(new Set(injectedTransferFaults.map((fault) => fault.key)).size, 1, "Multipart transfer failures must preserve durable request key");
    assert.equal(transferRecordingHashes.size, 1, "Faulted and successful attempts must preserve exact recording bytes");
    results.multipartTransferFailures = { injected: injectedTransferFaults, stableRequestKey: true, recoveredByPublishedApi: true, cloudJobs: cloudDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lap_uploads").get()?.n };
  }
  if (reservationFaults.length) {
    assert.equal(injectedReservationFaults.length, reservationFaults.length);
    assert.equal(retryViolation, null);
    assert.equal(new Set(injectedReservationFaults.map((fault) => fault.key)).size, 1, "Transient reservation failures must preserve the durable request key");
    assert.ok(acceptedKeys.has(injectedReservationFaults[0]!.key));
    results.reservationFailures = { injected: reservationFaults, retryAfterHonored: true, stableRequestKey: true, recordingTransfersBeforeRecovery: 1 };
  }
  if (process.env.RACEIQ_OVERLOAD_FIXTURE && !durableRecovery) await verifyUdpOverload(local, process.env.RACEIQ_OVERLOAD_FIXTURE);
  console.log(JSON.stringify({ scenario: "actual-desktop-upload-http-recovery", passed: true, results }));
  succeeded = true;
} catch (error) {
  results.transport = { bodyTransfers, droppedResponses, injectedTransferFaults, injectedReservationFaults, outageArmed, offlineRequestCount, offlineRoutes: Object.fromEntries(offlineRoutes) };
  for (const [child, log] of childLogs) { await writeFile(join(temporary, `child-${child.pid}.log`), log.text); }
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : "smoke failure", results, evidenceDirectory: temporary })); throw error;
} finally {
  shuttingDown = true; await stop(desktop); await stop(processor); await stop(cloud); cloudDb?.close();
  faultProxy.closeAllConnections(); faultProxy.close(); tlsProvider.stop(true); plainProvider.stop(true);
  if (succeeded) await rm(temporary, { recursive: true, force: true });
}
