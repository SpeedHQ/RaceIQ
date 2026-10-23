import Database from "libsql";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { DriverSummary, OnlineProfileResponse } from "@raceiq/online/contracts";
import { hashActivityContribution, type api } from "@speedhq/live-client";
import { dashboardLapAttribution } from "@raceiq/backend-core/driver-summary/dashboard-input";

// Run with: bun --no-env-file apps/backend/test/fixtures/online-profile-http-merge-smoke.ts
// Requires RACEIQ_CLOUD_ROOT, RACEIQ_UPLOAD_SOURCE_DATA_DIR, RACEIQ_UPLOAD_TEST_CERT,
// RACEIQ_UPLOAD_TEST_KEY. Source data must contain complete native F1 2025 and LMU originals.
type ActivityContribution = api.ActivityContribution;
type EntityContribution = { gameId: string; nativeId: string; seconds: number; laps: number };
const desktopRoot = resolve(import.meta.dir, "../../../..");
const cloudRoot = process.env.RACEIQ_CLOUD_ROOT;
const sourceData = process.env.RACEIQ_UPLOAD_SOURCE_DATA_DIR;
const certFile = process.env.RACEIQ_UPLOAD_TEST_CERT;
const keyFile = process.env.RACEIQ_UPLOAD_TEST_KEY;
assert.ok(cloudRoot && sourceData && certFile && keyFile, "Cloud root, isolated source data, and test TLS certificate/key are required");
let sourceReal = await realpath(sourceData);
assert.ok(sourceReal.startsWith((await realpath(tmpdir())) + sep), "Refuse non-temporary source data");
const temporary = await mkdtemp(join(tmpdir(), "raceiq-profile-http-merge-"));
const owner = "a2345678-1234-5678-9abc-def012345678";
const dashboardPassword = "RaceIQ-uploads-local-only-2026";
const childLogs = new Map<Bun.Subprocess, { text: string; done: Promise<void> }>();
const children = new Set<Bun.Subprocess>();
const policy = { RACEIQ_TERMS_VERSION: "profile-merge-terms", RACEIQ_PRIVACY_VERSION: "profile-merge-privacy", RACEIQ_TERMS_URL: "https://example.test/terms", RACEIQ_PRIVACY_URL: "https://example.test/privacy" };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const cert = await readFile(certFile, "utf8");
const codes = new Map<string, { challenge: string }>();
const tokens = new Set<string>();
const provider = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/auth/v1/authorize") {
    const callback = new URL(url.searchParams.get("redirect_to")!);
    if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.pathname !== "/api/online/auth/callback") return new Response(null, { status: 400 });
    const code = randomUUID(); codes.set(code, { challenge: url.searchParams.get("code_challenge")! });
    callback.searchParams.set("code", code); return Response.redirect(callback.href, 302);
  }
  if (url.pathname === "/auth/v1/token") {
    const body = await request.json() as { auth_code?: string; code_verifier?: string; refresh_token?: string };
    if (url.searchParams.get("grant_type") === "pkce") {
      const attempt = codes.get(body.auth_code ?? ""); codes.delete(body.auth_code ?? "");
      if (!attempt || createHash("sha256").update(body.code_verifier ?? "").digest("base64url") !== attempt.challenge) return new Response(null, { status: 400 });
    } else if (body.refresh_token !== "profile-merge-owner") return new Response(null, { status: 401 });
    const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: `${providerBase}/auth/v1`, aud: "authenticated", role: "authenticated", sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, session_id: randomUUID() })}.isolated-signature`;
    tokens.add(accessToken);
    return Response.json({ access_token: accessToken, refresh_token: "profile-merge-owner", token_type: "bearer", expires_in: 3600, user: { id: owner, user_metadata: { name: "Profile Merge Owner" }, identities: [] } });
  }
  const authorized = tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  return authorized && url.pathname === "/auth/v1/user"
    ? Response.json({ id: owner, user_metadata: { name: "Profile Merge Owner" }, identities: [] })
    : new Response(null, { status: 401 });
};
const plainProvider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: provider });
const providerBase = `http://127.0.0.1:${plainProvider.port}`;
const tlsProvider = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key: await readFile(keyFile) }, fetch: provider });
const authOrigin = `https://127.0.0.1:${tlsProvider.port}`;
async function freePort(): Promise<number> {
  const probe = createServer(), listening = Promise.withResolvers<void>(); probe.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = probe.address(); assert.ok(address && typeof address === "object");
  const closed = Promise.withResolvers<void>(); probe.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise; return address.port;
}
const apiPort = await freePort(), appPort = await freePort(), udpPort = await freePort(), metricsPort = await freePort();
const apiBase = `http://127.0.0.1:${apiPort}`, appBase = `http://127.0.0.1:${appPort}`;
let profileWrites = 0, recordingReservations = 0, recordingBodies = 0, setupTransfers = 0;
const profileSentHashes = new Set<string>();
const profileFailures: Array<{ status: number; code: string | null; message: string | null }> = [];
const proxy = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("Profile proxy request exceeds fixture budget"); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks), headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !["host", "connection", "transfer-encoding"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    if (headers.get("origin") === proxyBase) headers.set("origin", apiBase);
    const path = request.url?.split("?")[0] ?? "";
    if (request.method === "PUT" && path === "/api/v1/me/stats") {
      profileWrites++;
      try { const hash = JSON.parse(bytes.toString()).contribution?.contentHash; if (typeof hash === "string") profileSentHashes.add(hash); } catch {}
    }
    if (request.method === "POST" && path === "/api/v1/laps/reservations") recordingReservations++;
    if (request.method === "POST" && path === "/api/v1/laps") recordingBodies++;
    if (path.includes("setup") && request.method !== "GET") setupTransfers++;
    const upstream = await fetch(apiBase + request.url, { method: request.method, headers, ...(bytes.length ? { body: bytes } : {}), redirect: "error" });
    const payload = new Uint8Array(await upstream.arrayBuffer()); response.statusCode = upstream.status;
    if (path.startsWith("/api/v1/me/stats") && upstream.status >= 400 && upstream.status !== 404) {
      let detail: { error?: { code?: unknown; message?: unknown } } = {};
      try { detail = JSON.parse(Buffer.from(payload).toString()); } catch {}
      profileFailures.push({ status: upstream.status, code: typeof detail.error?.code === "string" ? detail.error.code : null,
        message: typeof detail.error?.message === "string" ? detail.error.message.slice(0, 512) : null });
      if (request.method === "PUT" && path === "/api/v1/me/stats") await writeFile(join(temporary, "profile-contribution-request.json"), bytes);
    }
    for (const name of ["content-type", "cache-control", "retry-after"]) { const value = upstream.headers.get(name); if (value) response.setHeader(name, value); }
    response.end(payload);
  } catch { if (!response.destroyed) { response.statusCode = 502; response.end(); } }
});
const proxyReady = Promise.withResolvers<void>(); proxy.listen(0, "127.0.0.1", proxyReady.resolve); await proxyReady.promise;
const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress === "object"); const proxyBase = `http://127.0.0.1:${proxyAddress.port}`;
const baseEnv = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR! };
function start(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd, env: { ...baseEnv, ...env }, stdout: "pipe", stderr: "pipe" }); children.add(child);
  const log = { text: "", done: Promise.resolve() };
  const collect = async (stream: ReadableStream<Uint8Array>) => { const reader = stream.getReader(), decoder = new TextDecoder(); while (true) { const next = await reader.read(); if (next.done) break; if (log.text.length < 1024 * 1024) log.text += decoder.decode(next.value, { stream: true }).slice(0, 1024 * 1024 - log.text.length); } };
  log.done = Promise.all([collect(child.stdout), collect(child.stderr)]).then(() => undefined); childLogs.set(child, log); return child;
}
async function stop(child: Bun.Subprocess | undefined) {
  if (!child) return;
  if (child.exitCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await child.exited; await childLogs.get(child)?.done; } finally { clearTimeout(timer); children.delete(child); }
}
let interrupted = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { interrupted = true; for (const child of children) child.kill("SIGTERM"); });
async function waitUntil<T>(predicate: () => Promise<T | false> | T | false, label: string, timeout = 120_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; if (interrupted) throw new Error("Smoke interrupted"); await Bun.sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function ready(base: string, path: string) { await waitUntil(async () => { try { return (await fetch(base + path)).status === 200; } catch { return false; } }, `${path} readiness`); }
async function cloneDesktop(name: string) {
  const destination = join(temporary, name); await mkdir(destination, { recursive: true });
  const original = new Database(join(sourceReal, "app.db"), { readonly: true });
  try { assert.equal(original.query<{ online_user_id: string | null }, []>("SELECT online_user_id FROM local_account_owner WHERE id=1").get()?.online_user_id, owner, "Source fixture must be pre-bound to isolated owner"); await writeFile(join(destination, "app.db"), original.serialize()); } finally { original.close(); }
  await cp(join(sourceReal, "sessions"), join(destination, "sessions"), { recursive: true, mode: constants.COPYFILE_FICLONE });
  const local = new Database(join(destination, "app.db"));
  try {
    for (const column of ["raw_file", "capture_manifest_file", "capture_archive_file"]) {
      const rows = local.query(`SELECT id,${column} AS path FROM sessions WHERE ${column} IS NOT NULL`).all() as Array<{ id: number; path: string }>;
      for (const row of rows) { const canonical = await realpath(row.path); assert.ok(canonical.startsWith(sourceReal + sep), "Refuse session file outside isolated source data"); local.query(`UPDATE sessions SET ${column}=? WHERE id=?`).run(join(destination, relative(sourceReal, canonical)), row.id); }
    }
  } finally { local.close(); }
  return destination;
}
type Source = { activityId: string; gameId: string; sessionIds: number[]; lapGuids: string[]; personalLapGuids: string[] };
function completeNativeSources(data: string): Source[] {
  const db = new Database(join(data, "app.db"), { readonly: true });
  try {
    const sessions = db.query<{ id: number; activityId: string; gameId: string; activityRevision: string; ownerUserId: string } , [string]>(`SELECT s.id,s.original_activity_id AS activityId,s.game_id AS gameId,s.original_source_revision AS activityRevision,s.owner_user_id AS ownerUserId
      FROM sessions s JOIN original_activity_sources f ON f.original_activity_id=s.original_activity_id AND f.source_revision=s.original_source_revision AND f.owner_user_id IS s.owner_user_id
      JOIN original_activity_representations r ON r.session_id=s.id AND r.original_activity_id=s.original_activity_id AND r.source_revision=s.original_source_revision
      JOIN native_original_source_closures c ON c.session_id=s.id AND c.original_activity_id=s.original_activity_id AND c.source_revision=s.original_source_revision
      WHERE s.ownership='mine' AND s.owner_user_id=? AND s.native_capture_origin=1 AND s.original_activity_id IS NOT NULL
        AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL AND s.downsampled_frequency_hz IS NULL
        AND f.origin='native_capture' AND r.origin='native_capture' AND c.gap_count=0 AND c.lap_count>0 AND c.lap_count=json_array_length(f.original_lap_guids_json)
      ORDER BY s.game_id,s.original_activity_id,s.id`).all(owner);
    const grouped = new Map<string, Source>();
    for (const session of sessions) {
      const facts = db.query<{ originalLapGuidsJson: string } , [string]>("SELECT original_lap_guids_json AS originalLapGuidsJson FROM original_activity_sources WHERE original_activity_id=?").get(session.activityId);
      if (!facts) continue;
      const expected = JSON.parse(facts.originalLapGuidsJson) as string[];
      const actual = db.query<{ lapGuid: string } , [number]>("SELECT lap_guid AS lapGuid FROM laps WHERE session_id=? AND lap_guid IS NOT NULL ORDER BY lap_guid").all(session.id).map(row => row.lapGuid);
      if (expected.length !== actual.length || [...expected].sort().some((guid, i) => guid !== actual[i])) continue;
      const personalLapGuids = db.query<{ lapGuid: string; lapStints: string | null; sessionStints: string | null; domain: string | null; start: number | null; end: number | null }, [number]>(
        `SELECT l.lap_guid AS lapGuid,l.driver_attribution_stints AS lapStints,s.driver_attribution_stints AS sessionStints,
          l.source_clock_domain AS domain,l.source_lap_start_ms AS start,l.source_lap_end_ms AS end
         FROM laps l JOIN sessions s ON s.id=l.session_id WHERE l.session_id=? AND l.lap_guid IS NOT NULL ORDER BY l.lap_guid`
      ).all(session.id).filter(row => dashboardLapAttribution(row.lapStints,row.sessionStints,row.domain,row.start,row.end)==="Self").map(row => row.lapGuid);
      if (!personalLapGuids.length) continue;
      const source = grouped.get(session.activityId) ?? { activityId: session.activityId, gameId: session.gameId, sessionIds: [], lapGuids: [...expected].sort(), personalLapGuids };
      if (source.gameId !== session.gameId || source.lapGuids.join("\0") !== [...expected].sort().join("\0")) continue;
      source.sessionIds.push(session.id); grouped.set(session.activityId, source);
    }
    return [...grouped.values()];
  } finally { db.close(); }
}
function localClient() {
  let cookie = "", csrf = "";
  return async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(appBase + path, { method, headers: { Origin: appBase, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-RaceIQ-CSRF": csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    csrf = response.headers.get("x-raceiq-csrf") ?? csrf;
    return { status: response.status, data: await response.json(), cookie };
  };
}
const context = (state: { revision: number; accountEpoch: string }) => ({ expectedRevision: state.revision, accountEpoch: state.accountEpoch });
async function startApp(data: string, retained: Set<number>) {
  const desktop = start(["bun", "--no-env-file", "apps/backend/src/index.ts"], desktopRoot, { NODE_ENV: "test", DATA_DIR: data, SERVER_HOST: "127.0.0.1", SERVER_PORT: String(appPort), UDP_PORT: String(udpPort), RACEIQ_DEV_UDP_PORT: String(udpPort), RACEIQ_E2E: "1", RACEIQ_E2E_ONLINE_ORIGIN: proxyBase, RACEIQ_E2E_AUTH_ORIGIN: authOrigin, RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "profile-merge-smoke-key", NODE_EXTRA_CA_CERTS: certFile!, RACEIQ_DISABLE_TRAY: "1", RACEIQ_LAUNCHER_OPENS_BROWSER: "0" });
  await ready(appBase, "/api/auth/status"); const local = localClient();
  if ((await local("/api/auth/status")).data.pending) {
    assert.equal((await local("/api/auth/setup", "POST", { password: dashboardPassword, exposureConfirmed: true })).status, 200);
  }
  assert.equal((await local("/api/auth/login", "POST", { password: dashboardPassword })).status, 200);
  const deletions = new Database(join(data, "app.db"), { readonly: true });
  let remove: number[];
  try { remove = (deletions.query<{ id: number }, []>("SELECT id FROM sessions").all()).map(row => row.id).filter(id => !retained.has(id)); } finally { deletions.close(); }
  if (remove.length) { const result = await local("/api/sessions/bulk-delete", "POST", { ids: remove }); assert.equal(result.status, 200, "Isolated fixture subset deletion must use actual app endpoint"); }
  let state = (await local("/api/online/state")).data;
  const connect = await local("/api/online/connect", "POST", context(state)); assert.equal(connect.status, 202);
  const authorization = new URL(connect.data.authorizationUrl);
  const redirect = await fetch(authorization, { redirect: "manual", tls: { ca: cert } }); assert.equal(redirect.status, 302);
  assert.equal((await fetch(redirect.headers.get("location")!, { headers: { Cookie: connect.cookie }, redirect: "error" })).status, 200);
  state = (await local("/api/online/state")).data;
  assert.equal((await local("/api/online/consent", "PUT", { ...context(state), acceptedPolicyVersions: state.policy.versions })).status, 200);
  state = (await local("/api/online/state")).data;
  assert.equal((await local("/api/online/preferences", "PUT", { ...context(state), preferences: { visibility: "private", setupUploads: false } })).status, 200);
  const preferences = (await local("/api/online/state")).data.preferences;
  assert.equal(preferences.visibility, "private");
  return { desktop, local };
}
async function onlineProfile(local: ReturnType<typeof localClient>) {
  const state = (await local("/api/online/state")).data;
  const query = new URLSearchParams({ accountEpoch: state.accountEpoch, expectedRevision: String(state.revision) });
  return (await local(`/api/online/profile?${query}`)).data as OnlineProfileResponse;
}
function sumMetrics(contributions: ActivityContribution[]) {
  const metrics = structuredClone(contributions[0]!.metrics);
  for (const contribution of contributions.slice(1)) {
    for (const key of ["laps", "positiveLaps", "validLaps", "drivenSeconds", "validSeconds", "sessionsWithDuration", "sessionsWithoutDuration"] as const) metrics[key] += contribution.metrics[key];
    for (const key of ["practice", "qualifying", "race", "unknown"] as const) metrics.sessionTypeSeconds[key] += contribution.metrics.sessionTypeSeconds[key];
  }
  let distance: number | null = null;
  for (const contribution of contributions) {
    if (typeof contribution.metrics.distanceMeters === "number") distance = (distance ?? 0) + contribution.metrics.distanceMeters;
  }
  metrics.distanceMeters = distance;
  return metrics;
}
// SQLite JSON projections can round a sum's decimal representation; hashes remain bit-exact.
function assertProjectedNumber(actual: number, expected: number, label: string) {
  const tolerance = expected === 0 ? 0 : Number.EPSILON * 32 * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} differs from ${expected} beyond projection precision`);
}
function assertMetricTotals(actual: DriverSummary["metrics"], expected: ActivityContribution["metrics"], label: string) {
  for (const key of ["laps", "positiveLaps", "validLaps", "sessionsWithDuration", "sessionsWithoutDuration"] as const) {
    assert.equal(actual[key], expected[key], `${label}.${key}`);
  }
  for (const key of ["drivenSeconds", "validSeconds"] as const) assertProjectedNumber(actual[key], expected[key], `${label}.${key}`);
  if (expected.distanceMeters == null) assert.equal(actual.distanceMeters, null, `${label}.distanceMeters must remain unavailable`);
  else {
    assert.ok(typeof actual.distanceMeters === "number", `${label}.distanceMeters must remain measured`);
    assertProjectedNumber(actual.distanceMeters, expected.distanceMeters, `${label}.distanceMeters`);
  }
  for (const key of ["practice", "qualifying", "race", "unknown"] as const) {
    assertProjectedNumber(actual.sessionTypeSeconds[key], expected.sessionTypeSeconds[key], `${label}.sessionTypeSeconds.${key}`);
  }
}
function assertEntityFavorite(actual: DriverSummary["games"][number]["favoriteCar"], entities: EntityContribution[], gameId: string) {
  const candidates = entities.filter(item => item.gameId === gameId).sort((a, b) => b.seconds - a.seconds || b.laps - a.laps || a.gameId.localeCompare(b.gameId) || a.nativeId.localeCompare(b.nativeId));
  if (!candidates.length) assert.equal(actual, null);
  else {
    assert.ok(actual, "A measured favourite must not disappear");
    assert.equal(actual.nativeId, candidates[0]!.nativeId);
    assert.equal(actual.laps, candidates[0]!.laps);
    assertProjectedNumber(actual.seconds, candidates[0]!.seconds, "Favourite measured seconds");
  }
  if (actual) assert.equal(typeof actual.name, "string");
}
const storagePath = join(temporary, "cloud.sqlite"), uploadDir = join(temporary, "uploads");
let cloud: Bun.Subprocess | undefined, processor: Bun.Subprocess | undefined, desktop: Bun.Subprocess | undefined, cloudDb: Database | undefined;
const results: Record<string, unknown> = {};
let succeeded = false;
try {
  if (process.env.RACEIQ_PROFILE_RECORD_FIXTURES === "1") {
    // Feed genuine recorded native input through the capture entry point. Do not
    // insert Self stints, GUIDs, source footprints or closure attestations in SQL.
    // Retain the previously confirmed F1 actor snapshot; fresh F1 input without
    // explicit native-driver confirmation correctly remains Unknown.
    const captureData = await cloneDesktop("native-source");
    const seed = start(["bun", "--no-env-file", "--eval", `
      import { readFile } from "node:fs/promises";
      import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
      import { initServerGameAdapters } from "./src/games/init.ts";
      import { fixtureFrames } from "./test/benchmarks/live-lossless-release.bench.ts";
      import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
      import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
      import { RealDbAdapter, NullWsAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
      import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
      import { claimLocalAccountOwner } from "@raceiq/backend-core/db/local-account-queries";
      import { initDb } from "@raceiq/backend-core/db/index";
      initGameAdapters(); initServerGameAdapters();
      await initDb();
      await claimLocalAccountOwner(${JSON.stringify(owner)});
      for (const [gameId,path] of [
        ["lmu",${JSON.stringify(join(desktopRoot, "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz"))}],
      ]) {
        resetParserState(gameId);
        const recorder = new DirectSessionRecorderAdapter("mine");
        const pipeline = new LiveTelemetryPipeline(
          new RealDbAdapter({notifyDriverProfile:false,sourceOrigin:{kind:"native_capture"}}),
          new NullWsAdapter(),
          {recorder,bypassPacketRateFilter:true,skipHistorySeeding:true,skipDevState:true,enqueueSessionCaptureSplits:false});
        const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
        try {
          let count=0;
          for (const input of fixtureFrames(await readFile(path),gameId)) {
            while((recorder.capture?.queuedBytes??0)>512*1024) {
              if(recorder.capture?.hasFailed) throw recorder.capture.error;
              await Bun.sleep(1);
            }
            const bytes=Buffer.from(input.bytes),packet=parsePacket(bytes,input.timestampMs);
            if(packet) await pipeline.processPacket(packet,bytes,input.timestampMs);
            if((++count&127)===0) await new Promise(resolve=>setImmediate(resolve));
          }
          await pipeline.finalizeCurrentSession();
          console.log(JSON.stringify({capturedGame:gameId,sourceFrames:count}));
        } finally { unsubscribe(); }
      }
      process.exit(0);
    `], join(desktopRoot, "apps/backend"), { NODE_ENV: "test", DATA_DIR: captureData });
    assert.equal(await seed.exited, 0, "Genuine native fixture capture must complete");
    await childLogs.get(seed)!.done; children.delete(seed);
    sourceReal = await realpath(captureData);
  }
  const originalDb = new Database(join(sourceReal, "app.db"), { readonly: true });
  let sources: Source[];
  try {
    const sourceOwner = originalDb.query<{ id: string | null }, []>("SELECT online_user_id AS id FROM local_account_owner WHERE id=1").get()?.id;
    assert.equal(sourceOwner, owner, "Source snapshot must be bound to isolated owner");
    sources = completeNativeSources(sourceReal);
  } finally { originalDb.close(); }
  const f1 = sources.find(source => source.gameId === "f1-2025");
  const lmu = sources.find(source => source.gameId === "lmu" && source.activityId !== f1?.activityId);
  assert.ok(f1 && lmu, "Prerequisite missing: isolated source data must contain complete, closed native-capture originals with Self contribution for both f1-2025 and lmu, distinct activity IDs, exact GUID membership");
  assert.equal(new Set([...f1.lapGuids, ...lmu.lapGuids]).size, f1.lapGuids.length + lmu.lapGuids.length, "Distinct original identities must not share lap GUIDs");
  const fixtureDb = new Database(join(sourceReal, "app.db"), { readonly: true });
  try {
    const existingLedger = fixtureDb.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM driver_summary_activities WHERE activity_id IN (?,?) AND (cloud_revision IS NOT NULL OR held_cloud_revision IS NOT NULL OR expected_cloud_revision IS NOT NULL)").get(f1.activityId, lmu.activityId)?.n ?? 0;
    assert.equal(existingLedger, 0, "Source fixture must not carry prior profile receipts for selected originals");
  } finally { fixtureDb.close(); }
  const sourceOne = await cloneDesktop("device-one"), sourceTwo = await cloneDesktop("device-two");
  const retainedOne = new Set(f1.sessionIds), retainedTwo = new Set([...f1.sessionIds, ...lmu.sessionIds]);
  const startupPolicy = { ...policy, SQLITE_PATH: storagePath, UPLOAD_DIR: uploadDir, DISCORD_BOT_TOKEN: "" };
  cloud = start([join(cloudRoot!, "apps/raceiq/target/debug/raceiq-server")], cloudRoot!, { ...startupPolicy, HOST: "127.0.0.1", PORT: String(apiPort), HTTP_METRICS_HOST: "127.0.0.1", HTTP_METRICS_PORT: "0", PUBLIC_BASE_URL: apiBase, SUPABASE_URL: providerBase, SUPABASE_PUBLISHABLE_KEY: "profile-merge-smoke-key", PUBLIC_API_RATE_LIMIT_PER_MINUTE: "60000", PUBLIC_API_RATE_LIMIT_BURST: "10000", PUBLIC_API_TRUSTED_PROXY_IPS: "" });
  await ready(apiBase, "/healthz");
  processor = start(["bun", "--no-env-file", "apps/lap-processor/src/main.ts"], cloudRoot!, { ...startupPolicy, LAP_PROCESSOR_METRICS_HOST: "127.0.0.1", LAP_PROCESSOR_METRICS_PORT: String(metricsPort), RETENTION_MODE: "enabled" });
  cloudDb = new Database(storagePath, { readonly: true });
  const first = await startApp(sourceOne, retainedOne);
  desktop = first.desktop;
  const firstLocal = first.local;
  const firstProfile = await waitUntil(async () => {
    if (profileFailures.length) throw new Error(`Profile API rejected the real SDK request: ${JSON.stringify(profileFailures)}`);
    const profile = await onlineProfile(firstLocal);
    return profile.status === "ready" && profile.localPending === 0 && profile.summary?.metrics.laps === f1.personalLapGuids.length ? profile : false;
  }, "device one syncs genuine F1 contribution");
  assert.equal(firstProfile.status, "ready");
  assert.ok(firstProfile.summary && firstProfile.summary.metrics.laps > 0, "F1 source must produce real personal contribution");
  const f1Cloud = cloudDb.query<{ revision: number; contribution_json: string }, [string, string]>("SELECT revision,contribution_json FROM activity_contributions WHERE user_id=? AND activity_id=?").get(owner, f1.activityId);
  assert.ok(f1Cloud, "Actual Rust API must persist F1 contribution");
  const firstContribution = JSON.parse(f1Cloud.contribution_json) as ActivityContribution;
  assert.equal(firstContribution.metrics.laps, firstProfile.summary!.metrics.laps);
  await stop(desktop); desktop = undefined;

  const second = await startApp(sourceTwo, retainedTwo);
  desktop = second.desktop;
  const secondLocal = second.local;
  const { profile, publicProfile, cloudRows } = await waitUntil(async () => {
    const profile = await onlineProfile(secondLocal);
    if (profile.status !== "ready" || profile.localPending !== 0 ||
      profile.summary?.metrics.laps !== f1.personalLapGuids.length + lmu.personalLapGuids.length) return false;
    // One SQLite statement observes contribution bodies and their shared aggregate revision.
    const cloudRows = cloudDb!.query<{ activity_id: string; revision: number; contribution_json: string; online_revision: number }, [string]>(
      "SELECT c.activity_id,c.revision,c.contribution_json,r.online_revision FROM activity_contributions c JOIN online_stats_revisions r ON r.user_id=c.user_id WHERE c.user_id=? AND c.status='confirmed' ORDER BY c.activity_id",
    ).all(owner);
    if (cloudRows.length !== 2 || cloudRows[0]!.online_revision !== profile.onlineRevision) return false;
    const response = await fetch(`${apiBase}/api/v1/profiles/${owner}`);
    assert.equal(response.status, 200);
    const publicProfile = await response.json() as { stats: { summary: DriverSummary; onlineRevision: number } | null };
    assert.ok(publicProfile.stats, "Confirmed contributions must have a public all-time projection");
    if (publicProfile.stats.onlineRevision !== profile.onlineRevision) return false;
    return { profile, publicProfile, cloudRows };
  }, "second device reconciles overlap and syncs distinct LMU original", 180_000);
  const finalF1Cloud = cloudRows.find(row => row.activity_id === f1.activityId);
  const lmuCloud = cloudRows.find(row => row.activity_id === lmu.activityId);
  assert.ok(finalF1Cloud && lmuCloud, "Both genuine originals must have confirmed canonical contributions");
  const finalF1Contribution = JSON.parse(finalF1Cloud.contribution_json) as ActivityContribution;
  const lmuContribution = JSON.parse(lmuCloud.contribution_json) as ActivityContribution;
  assert.ok(lmuContribution.metrics.laps > 0, "LMU original must contain real personal contribution");
  assertMetricTotals(profile.summary!.metrics, sumMetrics([finalF1Contribution, lmuContribution]), "Unique original contributions");
  const expectedGames = [finalF1Contribution, lmuContribution].sort((a, b) => a.gameId.localeCompare(b.gameId));
  assert.deepEqual(profile.summary!.games.map(game => game.gameId), expectedGames.map(item => item.gameId));
  assert.equal(publicProfile.stats !== null, true);
  assert.deepEqual(publicProfile.stats!.summary, profile.summary, "Public profile projection must match owner-confirmed SDK readback");
  for (const game of profile.summary!.games) {
    const contribution = expectedGames.find(item => item.gameId === game.gameId)!;
    assertMetricTotals(game.metrics, contribution.metrics, `${game.gameId} contribution`);
    assertEntityFavorite(game.favoriteCar, contribution.cars, game.gameId);
    assertEntityFavorite(game.favoriteTrack, contribution.tracks, game.gameId);
  }
  assert.deepEqual(cloudRows.map(row => row.activity_id).sort(), [f1.activityId, lmu.activityId].sort(), "Exactly two unique original activities must exist in cloud contribution ledger");
  if (finalF1Contribution.contentHash === firstContribution.contentHash) {
    assert.equal(finalF1Cloud.revision, f1Cloud.revision, "Unchanged overlap must retain its existing receipt");
  } else {
    assert.ok(finalF1Cloud.revision > f1Cloud.revision, "A derived correction must replace the same original at a newer revision");
  }
  const f1LapRows = cloudDb.query<{ lap_guid: string }, [string, string]>("SELECT lap_guid FROM activity_contribution_laps WHERE user_id=? AND activity_id=? ORDER BY lap_guid").all(owner, f1.activityId).map(row => row.lap_guid);
  const lmuLapRows = cloudDb.query<{ lap_guid: string }, [string, string]>("SELECT lap_guid FROM activity_contribution_laps WHERE user_id=? AND activity_id=? ORDER BY lap_guid").all(owner, lmu.activityId).map(row => row.lap_guid);
  assert.deepEqual(f1LapRows, f1.personalLapGuids, "Cloud must retain exact original personal F1 GUID membership");
  assert.deepEqual(lmuLapRows, lmu.personalLapGuids, "Cloud must retain exact original personal LMU GUID membership");
  assert.ok(profileWrites >= 2, "Both genuine contribution writes must traverse the production SDK and HTTP API");
  assert.equal(recordingReservations, 0, "Private visibility must prevent recording reservations");
  assert.equal(recordingBodies, 0, "Private visibility must prevent recording transfers");
  assert.equal(setupTransfers, 0, "Private visibility and setup preference must prevent setup transfers");
  // Seed a valid older business intent, not native facts or Effect queue tables.
  // The current genuine source already matches owner readback; this intent must retire without a PUT.
  const obsolete: ActivityContribution = {
    ...finalF1Contribution, lapGuids: [], expectedRevision: null, contentHash: "", cars: [], tracks: [],
    metrics: { laps: 0, positiveLaps: 0, validLaps: 0, drivenSeconds: 0, validSeconds: 0, distanceMeters: null,
      sessionTypeSeconds: { practice: 0, qualifying: 0, race: 0, unknown: 0 }, sessionsWithDuration: 0, sessionsWithoutDuration: 0 },
    coverage: { identity: "complete", driverAttribution: "partial", sessionDuration: "unavailable", distance: "unavailable" },
  };
  obsolete.contentHash = await hashActivityContribution(obsolete);
  const obsoleteInput = { accountId: owner, activityId: obsolete.activityId, contentHash: obsolete.contentHash,
    gameId: obsolete.gameId, activityRevision: null, payloadJson: JSON.stringify(obsolete) };
  const admission = start(["bun", "--no-env-file", "-e",
    `import { admitProfileDelivery, closeProfileStorage } from ${JSON.stringify(join(desktopRoot, "packages/online/server/profile-storage.ts"))}; await admitProfileDelivery(${JSON.stringify(obsoleteInput)}); await closeProfileStorage();`,
  ], desktopRoot, { DATA_DIR: sourceTwo });
  assert.equal(await admission.exited, 0, "Public business-ledger admission must succeed in the isolated second app directory");
  await childLogs.get(admission)?.done;
  const deliveries = new Database(join(sourceTwo, "raceiq-online-profile-deliveries.db"), { readonly: true });
  try {
    const retired = await waitUntil(() => {
      const row = deliveries.query<{ state: string; attempts: number; accepted_at: number | null }, [string, string, string]>(
        "SELECT state,attempts,accepted_at FROM profile_deliveries WHERE account_id=? AND activity_id=? AND content_hash=?",
      ).get(owner, obsolete.activityId, obsolete.contentHash);
      if (row?.state === "accepted" || row?.state === "rejected") throw new Error(`Obsolete intent unexpectedly became ${row.state}`);
      return row?.state === "superseded" ? row : false;
    }, "owner readback supersedes obsolete profile intent", 60_000);
    assert.equal(retired.attempts, 0, "Readback reconciliation must not begin an obsolete transfer");
    assert.equal(retired.accepted_at, null, "A superseded intent must not acquire another payload's acceptance receipt");
  } finally { deliveries.close(); }
  assert.equal(profileSentHashes.has(obsolete.contentHash), false, "Obsolete statistics must never reach HTTP transport");
  const retainedReceipt = cloudDb.query<{ revision: number; content_hash: string }, [string, string]>(
    "SELECT revision,content_hash FROM activity_contributions WHERE user_id=? AND activity_id=?",
  ).get(owner, f1.activityId);
  assert.ok(retainedReceipt && retainedReceipt.revision >= finalF1Cloud.revision, "The canonical original receipt must remain present and monotonic");
  assert.notEqual(retainedReceipt.content_hash, obsolete.contentHash, "Obsolete intent must not replace the accepted personal contribution");
  const afterRetirement = await waitUntil(async () => {
    const current = await onlineProfile(secondLocal);
    return current.status === "ready" && current.localPending === 0 ? current : false;
  }, "profile remains ready after obsolete intent retirement");
  assert.ok(afterRetirement.onlineRevision !== null && profile.onlineRevision !== null && afterRetirement.onlineRevision >= profile.onlineRevision);
  assert.equal(afterRetirement.summary?.metrics.laps, f1.personalLapGuids.length + lmu.personalLapGuids.length);
  results.obsoleteDelivery = { superseded: true, transferAttempts: 0, fabricatedAcceptance: false, canonicalIdentityPreserved: true, profileReady: true, observedOnlineRevision: afterRetirement.onlineRevision };
  results.profileMerge = { scenario: "two-real-app-private-profile-merge", activities: cloudRows.map(row => ({ activityId: row.activity_id, revision: row.revision })), mergedLaps: profile.summary!.metrics.laps, onlineRevision: profile.onlineRevision, profileWrites, recordingReservations, recordingBodies, setupTransfers, ownerAndPublicReadbackMatch: true, correctionDecrease: "NOT_RUN: application-derived correction/decrease scenario remains unexecuted; the original native source revision must remain unchanged" };
  console.log(JSON.stringify({ passed: true, results }));
  succeeded = true;
} catch (error) {
  results.transport = { profileWrites, recordingReservations, recordingBodies, setupTransfers, profileFailures };
  for (const [child, log] of childLogs) {
    let scrubbed = log.text.replaceAll(dashboardPassword, "[redacted]").replaceAll("profile-merge-owner", "[redacted]").replaceAll("profile-merge-smoke-key", "[redacted]");
    for (const token of tokens) scrubbed = scrubbed.replaceAll(token, "[redacted]");
    await writeFile(join(temporary, `child-${child.pid}.log`), scrubbed);
  }
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : "profile merge smoke failure", results, evidenceDirectory: temporary })); throw error;
} finally {
  await stop(desktop); await stop(processor); await stop(cloud); cloudDb?.close();
  for (const child of children) await stop(child);
  proxy.closeAllConnections(); proxy.close(); tlsProvider.stop(true); plainProvider.stop(true);
  if (succeeded) await rm(temporary, { recursive: true, force: true });
}
