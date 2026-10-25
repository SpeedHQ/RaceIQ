import { afterAll, beforeAll, expect, test } from "bun:test";
import Database from "libsql";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createRecording, drivenRows } from "@raceiq/game-iracing/test-support/games/iracing-ibt";
import { createLMUDuckDB } from "@raceiq/game-lmu/test-support/duckdb";
import { containsSparseCaptureFrames, decompressIfGzipSync } from "@raceiq/capture-formats/session/framing";
import { DASHBOARD_PROCESSOR_VERSION } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { dashboardCarIdentity, dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import type { GameId } from "@raceiq/shared/games/ids";

async function removeDatabaseDirectory(directory: string) {
  // Release unreachable native handles before deleting the Windows fixture.
  if (process.platform === "win32") Bun.gc(true);
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyOnWindows = process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EBUSY";
      if (!isBusyOnWindows || attempt === 9) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }
}

const ROOT = resolve(import.meta.dir, "../../../..");
const PublicationSchema = z.object({ type: z.enum(["candidatePrepared", "transactionOpen", "beforeCommit", "afterCommit"]), eventId: z.number(), sessionId: z.number() });
type Publication = z.infer<typeof PublicationSchema>;
const ImportedSchema = z.object({ ok: z.boolean().optional(), imported: z.number().optional(), errors: z.array(z.string()).optional(), laps: z.array(z.object({ lapId: z.number(), sessionId: z.number() })).optional() });
let binBytes: Uint8Array<ArrayBuffer>;
let ibtBytes: Uint8Array<ArrayBuffer>;
let duckdbBytes: Uint8Array<ArrayBuffer>;
let motecBytes: Uint8Array<ArrayBuffer>;
let fixtureDirectory: string;
beforeAll(async () => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "raceiq-write-fixtures-"));
  const raw = decompressIfGzipSync(readFileSync(join(ROOT, "packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-grid-2026-10-22.bin.gz")));
  if (!containsSparseCaptureFrames(raw)) throw new Error("LMU grid fixture must be canonical sparse capture");
  binBytes = Uint8Array.from(raw);
  const ibt = createRecording("driven.ibt", drivenRows());
  try { ibtBytes = Uint8Array.from(readFileSync(ibt.path)); } finally { ibt.cleanup(); }
  const duckdb = join(fixtureDirectory, "import.duckdb");
  await createLMUDuckDB(duckdb);
  duckdbBytes = Uint8Array.from(readFileSync(duckdb));
  motecBytes = Uint8Array.from(readFileSync(join(ROOT, "test/artifacts/motec/acc-barcelona-porsche-992.zip")));
}, 180_000);
afterAll(() => { if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true }); });

interface Backend {
  api(path: string, init?: RequestInit): Promise<Response>;
  ready(): Promise<void>;
  pause(type: Publication["type"], sessionId?: number): Promise<void>;
  next(type: Publication["type"]): Promise<Publication>;
  waiting(operation?: string): Promise<void>;
  lifecycle(type: "workerStopping" | "workerStopped" | "workerExited"): Promise<void>;
  release(publication: Publication): Promise<void>;
  resume(): Promise<void>;
  holdPermit(): Promise<void>;
  releasePermit(): Promise<void>;
  checkpoint(sessionId: number): Promise<void>;
  rejectImports(reject: boolean): Promise<void>;
  republish(sessionId: number): Promise<void>;
  command(type: "stopWorker" | "terminateWorker"): Promise<void>;
  output(): string;
  stop(): Promise<void>;
}

function startBackend(dataDir: string): Backend {
  const child = Bun.spawn([process.execPath, "--eval", `
    import { MessageChannel } from "node:worker_threads";
    import { bootServer } from "./apps/backend/src/runtime/boot";
    import { withDatabaseWrite } from "./server/db/write-coordination";
    import { client } from "./server/db/index";
    import { markDashboardCaptureCheckpoint } from "./server/session-capture/dashboard-processor";
    import { prepareDashboardPublicationCandidate, publishDashboardSession } from "./server/db/dashboard-summary-queries";
    const { port1, port2 } = new MessageChannel();
    const events = [], waiters = [];
    let selected = null, selectedSession = null, permitRelease = null, permitTask = null;
    const matches = (event, type, operation) => event.type === type && (!operation || event.operation === operation);
    port2.on("message", (event) => {
      if (event.eventId && (event.type === "stageEntered" || event.type !== selected || (selectedSession !== null && event.sessionId !== selectedSession))) {
        port2.postMessage({ type: "release", eventId: event.eventId }); return;
      }
      const index = waiters.findIndex((waiter) => matches(event, waiter.type, waiter.operation));
      if (index < 0) events.push(event);
      else waiters.splice(index, 1)[0].resolve(Response.json(event));
    });
    const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/event") {
        const type = url.searchParams.get("type"), operation = url.searchParams.get("operation");
        const index = events.findIndex((event) => matches(event, type, operation));
        if (index >= 0) return Response.json(events.splice(index, 1)[0]);
        const pending = Promise.withResolvers();
        const waiter = { type, operation, resolve: pending.resolve };
        waiters.push(waiter);
        request.signal.addEventListener("abort", () => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); pending.resolve(new Response(null, {status:499})); }, { once: true });
        return pending.promise;
      }
      const body = request.method === "POST" ? await request.json() : {};
      if (url.pathname === "/pause") {
        selected = body.type ?? null; selectedSession = body.sessionId ?? null;
        for (let index = events.length - 1; index >= 0; index--) if (events[index].type === "writeWaiting") events.splice(index, 1);
      } else if (url.pathname === "/release") port2.postMessage({ type: "release", eventId: body.eventId });
      else if (url.pathname === "/resume") { selected = null; selectedSession = null; port2.postMessage({ type: "release-all" }); }
      else if (url.pathname === "/command") port2.postMessage({ type: body.type });
      else if (url.pathname === "/checkpoint") await markDashboardCaptureCheckpoint(body.sessionId, true);
      else if (url.pathname === "/reject-imports") await withDatabaseWrite(() => client.execute(body.reject
        ? "CREATE TRIGGER reject_import BEFORE INSERT ON laps BEGIN SELECT RAISE(ABORT,'controlled import failure'); END"
        : "DROP TRIGGER IF EXISTS reject_import"));
      else if (url.pathname === "/republish") {
        const candidate = await prepareDashboardPublicationCandidate(body.sessionId);
        if (!candidate) throw new Error("Publication candidate is missing");
        await publishDashboardSession(candidate);
      }
      else if (url.pathname === "/hold-permit") {
        if (permitTask) return new Response(null, { status:409 });
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        permitRelease = release.resolve;
        permitTask = withDatabaseWrite(async () => { entered.resolve(); await release.promise; });
        await entered.promise;
      } else if (url.pathname === "/release-permit") { permitRelease?.(); await permitTask; permitTask = null; permitRelease = null; }
      else return new Response(null, { status:404 });
      return new Response(null, { status:204 });
    } });
    const server = await bootServer({ httpPort:0, udpPort:0, recordingGameId:null, testDependencies:{ workerPort:port1 } });
    console.log("[W-E2E] READY " + server.httpServer.port + " " + control.port);
  `], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "production", SERVER_HOST: "127.0.0.1", SERVER_PASSWORD: "", SERVER_ALLOWED_ORIGINS: "", RACEIQ_FEATURE_IRACING_ADAPTER: "true", RACEIQ_TEST_MODE: "0", DB_IN_MEMORY: "0" }, stdout: "pipe", stderr: "pipe" });
  let output = "";
  let ports: { api: number; control: number } | undefined;
  const ready = Promise.withResolvers<void>();
  const dashboardStarted = Promise.withResolvers<void>();
  // Failure deadline only; successful readiness comes from the actual worker.
  const startupDeadline = AbortSignal.timeout(30_000);
  const failStartup = () => {
    const error = new Error(`Backend startup did not become ready:\n${output}`);
    ready.reject(error);
    dashboardStarted.reject(error);
  };
  startupDeadline.addEventListener("abort", failStartup, { once: true });
  void Promise.all([ready.promise, dashboardStarted.promise]).finally(() => startupDeadline.removeEventListener("abort", failStartup)).catch(() => {});
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      if (output.length > 120_000) output = output.slice(-120_000);
      const match = output.match(/\[W-E2E\] READY (\d+) (\d+)/);
      if (match && !ports) { ports = { api:Number(match[1]), control:Number(match[2]) }; ready.resolve(); }
      if (output.includes("[StartupWorker] Starting dashboard processor")) dashboardStarted.resolve();
    }
  };
  const drained = Promise.all([consume(child.stdout), consume(child.stderr)]);
  const exited = child.exited.then((code) => {
    const error = new Error(`Backend exited ${code}:\n${output}`);
    if (!ports) ready.reject(error);
    dashboardStarted.reject(error);
    return code;
  });
  let stopPromise: Promise<void> | undefined;
  const control = async (path: string, body: unknown = {}) => {
    await ready.promise;
    const response = await fetch(`http://127.0.0.1:${ports!.control}${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    if (response.status !== 204) throw new Error(`Test control ${path} returned ${response.status}: ${output}`);
  };
  const event = async (type: string, operation?: string) => {
    await ready.promise;
    const response = await fetch(`http://127.0.0.1:${ports!.control}/event?type=${type}${operation ? `&operation=${operation}` : ""}`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Worker event ${type} failed: ${output}`);
    return response.json();
  };
  const api = async (path: string, init?: RequestInit) => {
    await ready.promise;
    return fetch(`http://127.0.0.1:${ports!.api}${path}`, { signal: AbortSignal.timeout(180_000), ...init });
  };
  return {
    api,
    async ready() {
      await ready.promise;
      const setup = await api("/api/auth/setup", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({password:null,exposureConfirmed:true}) });
      if (setup.status !== 200 && setup.status !== 409) throw new Error(`Auth setup failed ${setup.status}: ${await setup.text()}\n${output}`);
      await dashboardStarted.promise;
    },
    pause: (type: Publication["type"], sessionId?: number) => control("/pause", { type, sessionId }),
    next: async (type: Publication["type"]) => PublicationSchema.parse(await event(type)),
    async waiting(operation?: string) { const waiting = z.object({type:z.literal("writeWaiting"),operation:z.string()}).parse(await event("writeWaiting", operation)); if (operation) expect(waiting.operation).toBe(operation); },
    async lifecycle(type: "workerStopping" | "workerStopped" | "workerExited") { expect(z.object({type:z.string()}).parse(await event(type)).type).toBe(type); },
    release: (publication: Publication) => control("/release", { eventId:publication.eventId }),
    resume: () => control("/resume"),
    holdPermit: () => control("/hold-permit"),
    releasePermit: () => control("/release-permit"),
    checkpoint: (sessionId: number) => control("/checkpoint", { sessionId }),
    rejectImports: (reject: boolean) => control("/reject-imports", { reject }),
    republish: (sessionId: number) => control("/republish", { sessionId }),
    command: (type: "stopWorker" | "terminateWorker") => control("/command", { type }),
    output: () => output,
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (child.exitCode === null) {
          if (ports) { await control("/release-permit").catch(() => {}); await control("/resume").catch(() => {}); }
          child.kill("SIGTERM");
        }
        await exited;
        await drained;
      })();
      return stopPromise;
    },
  };
}

async function postFile(backend: Backend, path: string, name: string, bytes: Uint8Array<ArrayBuffer>, fields: Record<string,string> = {}) {
  const body = new FormData();
  body.append("file", new File([bytes], name));
  for (const [key,value] of Object.entries(fields)) body.append(key,value);
  return backend.api(path, { method:"POST", body });
}
async function stagedIbt(backend: Backend) {
  const preview = await backend.api("/api/laps/import-ibt/preview", {method:"POST",headers:{"x-file-name":"driven.ibt","x-file-size":String(ibtBytes.byteLength)},body:ibtBytes});
  expect(preview.status).toBe(200);
  const staged = z.object({token:z.string(),preview:z.object({canImport:z.boolean()})}).parse(await preview.json());
  expect(staged.preview.canImport).toBe(true);
  return backend.api("/api/laps/import-ibt/commit", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:staged.token,ownership:"mine"})});
}
function scalar(database: InstanceType<typeof Database>, sql: string): number {
  return z.object({n:z.coerce.number()}).parse(database.prepare(sql).get()).n;
}
async function drain(database: InstanceType<typeof Database>) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pending = scalar(database, `SELECT COUNT(*) n FROM dashboard_summary_state st LEFT JOIN sessions s ON s.id=st.session_id LEFT JOIN dashboard_session_summaries d ON d.session_id=st.session_id WHERE st.source_revision!=st.published_revision OR st.metadata_dirty!=0 OR st.capture_dirty!=0 OR st.processor_version!=${DASHBOARD_PROCESSOR_VERSION} OR (s.id IS NOT NULL AND (st.deleted!=0 OR d.session_id IS NULL)) OR (s.id IS NULL AND (st.deleted!=1 OR d.session_id IS NOT NULL))`);
    const splitting = scalar(database, "SELECT COUNT(*) n FROM session_capture_split_jobs WHERE status IN ('queued','splitting','verifying','publishing')");
    if (!pending && !splitting) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Dashboard did not drain source revisions");
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(),"raceiq-write-e2e-"));
  const dataDir = join(directory,"data"); mkdirSync(dataDir);
  const backend = startBackend(dataDir);
  let database: InstanceType<typeof Database> | undefined;
  try {
    await backend.ready();
    const imported = await stagedIbt(backend);
    expect(imported.status).toBe(200);
    const result = ImportedSchema.parse(await imported.json());
    expect(result.imported).toBe(1);
    const lap = result.laps?.[0]; if (!lap) throw new Error("IBT fixture did not persist a lap");
    const openedDatabase = new Database(join(dataDir,"app.db"));
    database = openedDatabase;
    await drain(openedDatabase);
    return {directory,dataDir,backend,database:openedDatabase,lap,async close() { await backend.stop(); openedDatabase.close(); await removeDatabaseDirectory(directory); }};
  } catch(error) { await backend.stop(); database?.close(); await removeDatabaseDirectory(directory); throw error; }
}
async function dirty(backend: Backend, lap: { lapId: number; sessionId: number }, favorite: boolean) {
  const response = await backend.api(`/api/laps/${lap.lapId}/favorite`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({favorite})});
  expect(response.status).toBe(200);
  // Favorites deliberately do not invalidate summaries; use the real capture producer.
  await backend.checkpoint(lap.sessionId);
}
async function deletion(backend: Backend, sessionId: number) {
  return backend.api("/api/sessions/bulk-delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:[sessionId]})});
}
async function publication(backend: Backend, lap: {lapId:number;sessionId:number}, type: Publication["type"], favorite = true) {
  await backend.pause(type,lap.sessionId);
  await dirty(backend,lap,favorite);
  const event = await backend.next(type);
  expect(event.sessionId).toBe(lap.sessionId);
  return event;
}
const SourceLapSchema = z.object({session_id:z.number(),game_id:z.string(),car_id:z.string(),track_id:z.string(),created_at:z.string(),lap_time:z.number(),is_valid:z.number()});
type Totals = {lap_count:number;positive_laps:number;valid_laps:number;driven_seconds:number;valid_seconds:number};
function assertSourceTotals(database: InstanceType<typeof Database>) {
  const expected = {sessions:new Map<string,Totals>(),days:new Map<string,Totals>(),months:new Map<string,Totals>(),buckets:new Map<string,Totals>()};
  const add = (map:Map<string,Totals>,key:string,time:number,valid:boolean) => {
    let total=map.get(key); if(!total) {total={lap_count:0,positive_laps:0,valid_laps:0,driven_seconds:0,valid_seconds:0};map.set(key,total);}
    total.lap_count++; if(time>0) {total.positive_laps++;total.driven_seconds+=time;if(valid){total.valid_laps++;total.valid_seconds+=time;}}
  };
  const rows=z.array(SourceLapSchema).parse(database.prepare("SELECT l.session_id,s.game_id,s.car_id,s.track_id,l.created_at,l.lap_time,l.is_valid FROM laps l JOIN sessions s ON s.id=l.session_id WHERE s.ownership='mine' ORDER BY l.id").all());
  for(const row of rows) {
    const stamp=Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(row.created_at)?row.created_at:row.created_at.replace(" ","T")+"Z");
    const day=new Date(stamp).toISOString().slice(0,10),car=dashboardCarIdentity(row.game_id as GameId,row.car_id)??"",track=dashboardTrackIdentity(row.game_id as GameId,row.track_id)??"";
    add(expected.sessions,String(row.session_id),row.lap_time,row.is_valid===1);
    add(expected.days,[day,row.game_id,car,track].join("\0"),row.lap_time,row.is_valid===1);
    add(expected.months,[day.slice(0,7),row.game_id,car,track].join("\0"),row.lap_time,row.is_valid===1);
    if(row.lap_time>0) add(expected.buckets,[Math.floor(stamp/900000)*900000,row.game_id].join("\0"),row.lap_time,row.is_valid===1);
  }
  const tables = [
    {table:"dashboard_session_summaries",keys:["session_id"],values:expected.sessions},
    {table:"dashboard_day_entities",keys:["utc_day","game_id","car_key","track_key"],values:expected.days},
    {table:"dashboard_month_entities",keys:["utc_month","game_id","car_key","track_key"],values:expected.months},
    {table:"dashboard_time_buckets",keys:["bucket_start_ms","game_id"],values:expected.buckets},
  ];
  for(const {table,keys,values} of tables) {
    const actual=z.array(z.record(z.string(),z.unknown())).parse(database.prepare(`SELECT * FROM ${table}`).all());
    expect(actual.map(row=>keys.map(key=>String(row[key])).join("\0")).sort()).toEqual([...values.keys()].sort());
    for(const row of actual) {
      const total=values.get(keys.map(key=>String(row[key])).join("\0"))!;
      if(table!=="dashboard_time_buckets") expect(Number(row.lap_count)).toBe(total.lap_count);
      expect(Number(row.positive_laps)).toBe(total.positive_laps);expect(Number(row.valid_laps)).toBe(total.valid_laps);
      expect(Number(row.driven_seconds)).toBeCloseTo(total.driven_seconds,8);expect(Number(row.valid_seconds)).toBeCloseTo(total.valid_seconds,8);
    }
  }
}

test("W-E1: stale candidate cannot resurrect a deleted session or double-subtract aggregates",async()=>{
  const f=await fixture();
  try {
    const candidate=await publication(f.backend,f.lap,"candidatePrepared");
    expect((await deletion(f.backend,f.lap.sessionId)).status).toBe(200);
    await f.backend.resume();await f.backend.release(candidate);await drain(f.database);
    await f.backend.republish(f.lap.sessionId);
    await f.backend.republish(f.lap.sessionId);
    for (const table of ["dashboard_session_summaries", "dashboard_session_days", "dashboard_session_sectors", "dashboard_session_time_buckets"]) {
      expect(scalar(f.database, `SELECT COUNT(*) n FROM ${table} WHERE session_id=${f.lap.sessionId}`)).toBe(0);
    }
    assertSourceTotals(f.database);
    expect(f.backend.output()).not.toContain("SQLITE_BUSY");
  } finally {await f.close();}
},180_000);

test("W-E4: raw-source checkpoint invalidates a prepared candidate before publication", async () => {
  const f = await fixture();
  try {
    const candidate = await publication(f.backend, f.lap, "candidatePrepared");
    const before = z.object({ source_revision: z.number(), published_revision: z.number() }).parse(f.database.prepare("SELECT source_revision,published_revision FROM dashboard_summary_state WHERE session_id=?").get(f.lap.sessionId));
    await dirty(f.backend, f.lap, false);
    await f.backend.checkpoint(f.lap.sessionId);
    const changed = z.object({ source_revision: z.number() }).parse(f.database.prepare("SELECT source_revision FROM dashboard_summary_state WHERE session_id=?").get(f.lap.sessionId));
    expect(changed.source_revision).toBeGreaterThan(before.source_revision);
    await f.backend.pause("beforeCommit", f.lap.sessionId);
    await f.backend.release(candidate);
    const fresh = await f.backend.next("beforeCommit");
    expect(z.object({ published_revision: z.number() }).parse(f.database.prepare("SELECT published_revision FROM dashboard_summary_state WHERE session_id=?").get(f.lap.sessionId)).published_revision).toBe(before.published_revision);
    await f.backend.resume();
    await f.backend.release(fresh);
    await drain(f.database);
    const settled = z.object({ source_revision: z.number(), published_revision: z.number(), capture_dirty: z.number() }).parse(f.database.prepare("SELECT source_revision,published_revision,capture_dirty FROM dashboard_summary_state WHERE session_id=?").get(f.lap.sessionId));
    expect(settled).toEqual({ source_revision: changed.source_revision, published_revision: changed.source_revision, capture_dirty: 0 });
    assertSourceTotals(f.database);
  } finally { await f.close(); }
}, 180_000);

test("W-E2/W-E6: deletion waits for real publication; reads retain committed snapshot and bypass permit-only admission",async()=>{
  const f=await fixture();
  try {
    await f.backend.holdPermit();
    const read=await f.backend.api("/api/sessions?gameId=iracing",{signal:AbortSignal.timeout(10_000)});expect(read.status).toBe(200);
    expect(z.array(z.object({id:z.number()})).parse(await read.json()).map(row=>row.id)).toContain(f.lap.sessionId);
    await f.backend.releasePermit();
    const candidate=await publication(f.backend,f.lap,"candidatePrepared");
    const from=new Date(Date.now()-86400000).toISOString(),to=new Date(Date.now()+86400000).toISOString();
    const dashboard=`/api/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const baseline=await (await f.backend.api(dashboard)).json();
    await f.backend.pause("beforeCommit",f.lap.sessionId);await f.backend.release(candidate);
    const commit=await f.backend.next("beforeCommit");
    const snapshot=await f.backend.api(dashboard,{signal:AbortSignal.timeout(10_000)});expect(snapshot.status).toBe(200);expect(await snapshot.json()).toEqual(baseline);
    let settled=false;const pending=deletion(f.backend,f.lap.sessionId).then(value=>{settled=true;return value;});
    await f.backend.waiting("session.delete");expect(settled).toBe(false);
    await f.backend.resume();await f.backend.release(commit);expect((await pending).status).toBe(200);await drain(f.database);
    assertSourceTotals(f.database);expect(f.backend.output()).not.toContain("SQLITE_BUSY");
  } finally {await f.close();}
},180_000);

for(const format of ["bin","zip","ibt","duckdb","motec"] as const) {
  test(`W-E3/W-E4: ${format} persistence and rollback overlap real worker publication without lost source data`,async()=>{
    const f=await fixture();
    try {
      const exported=await f.backend.api(`/api/laps/export-zip?ids=${f.lap.lapId}`);expect(exported.status).toBe(200);
      const zip=Uint8Array.from(new Uint8Array(await exported.arrayBuffer()));
      const runImport=()=>format==="ibt"?stagedIbt(f.backend):format==="zip"?postFile(f.backend,"/api/laps/import-zip","roundtrip.zip",zip,{ownership:"mine"}):format==="motec"?postFile(f.backend,"/api/laps/import-motec","recording.zip",motecBytes,{ownership:"mine",gameId:"acc",carId:"33",trackId:"8"}):postFile(f.backend,"/api/laps/import",format==="bin"?"lmu-spa.bin":"lmu-import.duckdb",format==="bin"?binBytes:duckdbBytes,{ownership:"mine"});
      for(const fail of [false,true]) {
        const before=scalar(f.database,"SELECT COUNT(*) n FROM sessions");
        const lapsBefore=scalar(f.database,"SELECT COUNT(*) n FROM laps");
        if(fail) await f.backend.rejectImports(true);
        const commit=await publication(f.backend,f.lap,"beforeCommit",!fail);
        await f.backend.pause("beforeCommit", f.lap.sessionId);
        let settled=false;const pending=runImport().then(value=>{settled=true;return value;});
        let admittedWait = false;
        await Promise.race([
          f.backend.waiting().then(() => { admittedWait = true; }),
          pending.then(async (response) => { if (!admittedWait) throw new Error(`Import completed before write admission (${response.status}): ${await response.clone().text()}`); }),
        ]);
        expect(settled).toBe(false);
        expect(scalar(f.database,"SELECT COUNT(*) n FROM sessions")).toBe(before);
        await f.backend.resume();await f.backend.release(commit);
        const response=await pending;const body=ImportedSchema.parse(await response.json());
        if(fail) {
          expect(response.ok && body.ok!==false && (body.imported??0)>0 && !(body.errors?.length)).toBe(false);
          expect(scalar(f.database,"SELECT COUNT(*) n FROM sessions")).toBe(before);
          expect(scalar(f.database,"SELECT COUNT(*) n FROM laps")).toBe(lapsBefore);
          await f.backend.rejectImports(false);
        } else {
          expect(response.status).toBe(200);expect(body.ok).not.toBe(false);expect(body.errors??[]).toEqual([]);expect(body.imported).toBeGreaterThan(0);
          expect(body.laps).toHaveLength(body.imported!);
          expect(scalar(f.database,"SELECT COUNT(*) n FROM sessions")).toBe(before + new Set(body.laps!.map((lap) => lap.sessionId)).size);
          expect(scalar(f.database,"SELECT COUNT(*) n FROM laps")).toBe(lapsBefore + body.imported!);
          for (const lap of body.laps!) {
            expect(f.database.prepare("SELECT id AS lapId,session_id AS sessionId FROM laps WHERE id=?").get(lap.lapId)).toMatchObject(lap);
          }
        }
        await drain(f.database);assertSourceTotals(f.database);
      }
      expect(f.backend.output()).not.toContain("SQLITE_BUSY");
    } finally { await f.close(); }
  },600_000);
}


for(const phase of ["beforeCommit","afterCommit"] as const) {
  test(`W-E5: stop at ${phase} reports settled rollback or commit and releases every resource`,async()=>{
    const f=await fixture();let restarted:Backend|undefined;
    try {
      const old=z.object({published_revision:z.number()}).parse(f.database.prepare("SELECT published_revision FROM dashboard_summary_state WHERE session_id=?").get(f.lap.sessionId)).published_revision;
      await publication(f.backend,f.lap,phase);
      await f.backend.command("stopWorker");await f.backend.lifecycle("workerStopping");await f.backend.lifecycle("workerStopped");await f.backend.lifecycle("workerExited");
      const state=z.object({source_revision:z.number(),published_revision:z.number()}).parse(f.database.prepare("SELECT source_revision,published_revision FROM dashboard_summary_state WHERE session_id=?").get(f.lap.sessionId));
      expect(state.published_revision).toBe(phase==="beforeCommit"?old:state.source_revision);
      expect((await deletion(f.backend,f.lap.sessionId)).status).toBe(200);
      await f.backend.stop();restarted=startBackend(f.dataDir);await restarted.ready();await drain(f.database);assertSourceTotals(f.database);
    } finally {await restarted?.stop();await f.close();}
  },180_000);
}

for (const action of ["stopWorker", "terminateWorker"] as const) {
  test(`W-E5/W-E7: ${action} while queued cancels the worker's unused grant`, async () => {
    const f = await fixture();
    try {
      const candidate = await publication(f.backend, f.lap, "candidatePrepared");
      await f.backend.holdPermit();
      await f.backend.pause("beforeCommit", f.lap.sessionId);
      await f.backend.release(candidate);
      await f.backend.waiting("worker");
      await f.backend.command(action);
      if (action === "stopWorker") {
        await f.backend.lifecycle("workerStopping");
        await f.backend.lifecycle("workerStopped");
      }
      await f.backend.lifecycle("workerExited");
      await f.backend.releasePermit();
      expect((await deletion(f.backend, f.lap.sessionId)).status).toBe(200);
      expect(scalar(f.database, "SELECT COUNT(*) n FROM sessions")).toBe(0);
      expect(f.backend.output()).not.toContain("SQLITE_BUSY");
    } finally { await f.close(); }
  }, 180_000);
}

test("W-E7: worker exit rolls back mutated projections before a queued HTTP deletion acquires ownership",async()=>{
  const f=await fixture();let restarted:Backend|undefined;
  try {
    const old=z.object({source_revision:z.number()}).parse(f.database.prepare("SELECT source_revision FROM dashboard_session_summaries WHERE session_id=?").get(f.lap.sessionId)).source_revision;
    await publication(f.backend,f.lap,"beforeCommit");
    let settled=false;const pending=deletion(f.backend,f.lap.sessionId).then(value=>{settled=true;return value;});
    await f.backend.waiting("session.delete");expect(settled).toBe(false);
    await f.backend.command("terminateWorker");
    await f.backend.lifecycle("workerExited");
    const deleted = await pending;
    if (deleted.status !== 200) throw new Error(`Queued deletion after worker exit returned ${deleted.status}: ${await deleted.text()}\n${f.backend.output().slice(-12_000)}`);
    expect(z.object({source_revision:z.number()}).parse(f.database.prepare("SELECT source_revision FROM dashboard_session_summaries WHERE session_id=?").get(f.lap.sessionId)).source_revision).toBe(old);
    await f.backend.stop();restarted=startBackend(f.dataDir);await restarted.ready();await drain(f.database);assertSourceTotals(f.database);
    expect(restarted.output()).not.toContain("SQLITE_BUSY");
  } finally {await restarted?.stop();await f.close();}
},180_000);
