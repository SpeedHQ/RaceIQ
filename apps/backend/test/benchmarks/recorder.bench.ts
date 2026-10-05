import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { decompressIfGzipSync, iterateSessionFrames } from "@raceiq/backend-core/session-capture/framing";
import { IRACING_DUMP_MAGIC, readIRacingFramesFromBuffer } from "@raceiq/capture-formats/iracing/dump";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { replayWithNativeClock } from "./recorder-bench-replay";
import { ProcessTreeSampler } from "./recorder-bench-process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { NullSessionRecorderAdapter, type DbAdapter, type SessionIdentity } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { initServerGameAdapters } from "../../src/games/init";

import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
class MemoryImportDb implements DbAdapter {
  #nextId = 1;
  readonly sessionIdentities: (SessionIdentity | null)[] = [];
  async insertSession(
    _carOrdinal: number,
    _trackOrdinal: number,
    _gameId: GameId,
    _sessionType?: string,
    _versionIdentity?: TelemetryVersionIdentity,
    _ownership?: SessionOwnership,
    identity?: SessionIdentity,
  ): Promise<number> {
    this.sessionIdentities.push(identity ?? null);
    return this.#nextId++;
  }
  async insertLap(): Promise<number> { return this.#nextId++; }
  async deleteLap(): Promise<void> {}
  async setLapMetrics(): Promise<void> {}
  async updateLapCarSetup(): Promise<void> {}
  async getLaps() { return []; }
  async updateSessionRawFile(): Promise<void> {}
  async updateSessionCarTrack(): Promise<void> {}
  async getTuneAssignment() { return null; }
  async getLapsForExclusionScope() { return []; }
  async setLapAutoExclusion(): Promise<void> {}
  async getLapExperimentScope() { return { experimentId: null, tuneId: null }; }
}

type ImportResult = {
  engine: "bun" | "rust";
  fixture: string;
  fixtureSha256: string;
  inputCaptureBytes: number;
  sourceRecordCount: number;
  elapsedSeconds: number;
  processCpuSeconds: number | null;
  peakRssBytes: number | null;
  packetCount: number;
  importedLapCount: number;
  outcomeSha256: string;
  outcome: { packetCount: number; identity: unknown; laps: Record<string, unknown>[] };
  outputStorage: "memory";
  resourceMethod: string;
};

const sourceFrameCounts = new Map<string, number>();
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


function outcomeSignature(result: Record<string, unknown>): {
  packetCount: number;
  importedLapCount: number;
  outcomeSha256: string;
  outcome: { packetCount: number; identity: unknown; laps: Record<string, unknown>[] };
} {
  const sessions = Array.isArray(result.sessions) ? result.sessions as Record<string, unknown>[] : [];
  const laps = Array.isArray(result.laps) ? result.laps as Record<string, unknown>[]
    : sessions.flatMap((session) => Array.isArray(session.laps) ? session.laps as Record<string, unknown>[] : []);
  const packetCount = typeof result.packetCount === "number" ? result.packetCount : 0;
  const normalizedLaps = laps.map((lap) => ({
    lapNumber: lap.lapNumber ?? lap.number ?? null,
    lapTime: lap.lapTime ?? lap.time ?? null,
    valid: lap.isValid ?? lap.valid ?? null,
    car: lap.carId ?? lap.car ?? null,
    track: lap.trackId ?? lap.track ?? null,
  }));
  const identity = result.identity ?? sessions[0]?.identity ?? null;
  const outcome = { packetCount, identity, laps: normalizedLaps };
  return {
    packetCount,
    importedLapCount: laps.length,
    outcomeSha256: createHash("sha256").update(stableJson(outcome)).digest("hex"),
    outcome,
  };
}

async function runMemoryImport(testCase: typeof GAMES[number], engine: Args["engine"]): Promise<ImportResult> {
  const { fixture, gameId } = testCase;
  const bytes = await loadFixtureBytes(`test/artifacts/sessions/${fixture}`);
  let sourceRecordCount = sourceFrameCounts.get(fixture);
  if (sourceRecordCount === undefined) {
    sourceRecordCount = sourceFrameCount(bytes);
    sourceFrameCounts.set(fixture, sourceRecordCount);
  }
  let result: Record<string, unknown>;
  let elapsedSeconds: number;
  let processCpuSeconds: number | null = null;
  let peakRssBytes: number | null = null;
  let resourceMethod: string;
  if (engine === "bun") {
    const db = new MemoryImportDb();
    const cpuBefore = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const start = process.hrtime.bigint();
    const imported = await importSessionBin(bytes, gameId, {
      dbAdapter: db,
      recorder: new NullSessionRecorderAdapter(),
    });
    elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const cpu = process.cpuUsage(cpuBefore);
    processCpuSeconds = (cpu.user + cpu.system) / 1e6;
    peakRssBytes = Math.max(rssBefore, process.memoryUsage().rss);
    result = { packetCount: imported.packetCount, laps: imported.laps, identity: db.sessionIdentities[0] };
    resourceMethod = "Bun process CPU delta; RSS sampled before/after each trial";
  } else {
    if (!rustBenchChild) startRustBenchProcess();
    const sampler = new ProcessTreeSampler(rustBenchChild!);
    await sampler.start();
    const reply = await requestRustBench(gameId, bytes);
    const resources = await sampler.stop();
    elapsedSeconds = reply.elapsedSeconds;
    processCpuSeconds = resources.cpuSeconds;
    peakRssBytes = resources.peakRssBytes;
    result = reply.result;
    resourceMethod = "Rust benchmark child process tree sampled at 100ms; CPU is a lower bound and RSS sampled peak";
  }
  return {
    engine,
    fixture,
    fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
    inputCaptureBytes: bytes.byteLength,
    sourceRecordCount,
    elapsedSeconds,
    processCpuSeconds,
    peakRssBytes,
    ...outcomeSignature(result),
    outputStorage: "memory",
    resourceMethod,
  };
}

type RustBenchReply = { elapsedSeconds: number; result: Record<string, unknown> };
let rustBenchChild: ChildProcess | null = null;
let rustBenchLines: ReadlineInterface | null = null;
let rustBenchPending: ((value: RustBenchReply) => void) | null = null;
let rustBenchFailure: ((error: Error) => void) | null = null;
const fixtureBytes = new Map<string, Buffer>();

async function loadFixtureBytes(fixture: string): Promise<Buffer> {
  let bytes = fixtureBytes.get(fixture);
  if (!bytes) {
    bytes = await readFile(resolve(ROOT, fixture));
    fixtureBytes.set(fixture, bytes);
  }
  return bytes;
}

function startRustBenchProcess(): void {
  if (rustBenchChild) return;
  const child = spawn(RUST_BENCHMARK_EXECUTABLE, ["--benchmark-stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  rustBenchChild = child;
  child.stderr?.resume();
  rustBenchLines = createInterface({ input: child.stdout! });
  rustBenchLines.on("line", (line) => {
    const resolveReply = rustBenchPending;
    rustBenchPending = null;
    if (!resolveReply) return;
    const response = JSON.parse(line) as RustBenchReply & { error?: string };
    if (response.error) rustBenchFailure?.(new Error(response.error));
    else resolveReply(response);
    rustBenchFailure = null;
  });
  child.once("error", (error) => rustBenchFailure?.(error));
  child.once("exit", (code) => {
    if (code !== 0 && rustBenchFailure) rustBenchFailure(new Error(`Rust benchmark process exited ${code}`));
  });
}

function requestRustBench(gameId: string, bytes: Buffer): Promise<RustBenchReply> {
  if (!rustBenchChild?.stdin) throw new Error("Rust benchmark process is not running");
  const { promise, resolve: resolveReply, reject: rejectReply } = Promise.withResolvers<RustBenchReply>();
  rustBenchPending = resolveReply;
  rustBenchFailure = rejectReply;
  rustBenchChild.stdin.write(`${JSON.stringify({ gameId, bytesBase64: bytes.toString("base64") })}\n`, (error) => {
    if (error) {
      rustBenchPending = null;
      rustBenchFailure = null;
      rejectReply(error);
    }
  });
  return promise;
}

async function stopRustBenchProcess(): Promise<void> {
  const child = rustBenchChild;
  if (!child) return;
  rustBenchChild = null;
  rustBenchLines?.close();
  rustBenchLines = null;
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
  child.once("exit", () => resolveExit());
  child.stdin?.end();
  await exited;
}

const ROOT = resolve(import.meta.dir, "../../../../");
const FIXTURE_ROOT = join(ROOT, "test/artifacts/sessions");
const RUST_BENCHMARK_EXECUTABLE = resolve(
  ROOT,
  "native/recorder/target/release",
  process.platform === "win32" ? "raceiq-recorder.exe" : "raceiq-recorder",
);
const GAMES = [
  { gameId: "fm-2023", fixture: "fm-2023-2026-04-09T21-53-00-102Z.bin.gz", port: 15329 },
  { gameId: "f1-2025", fixture: "f1-2025-2026-04-09T21-34-10-190Z.bin.gz", port: 15330 },
  { gameId: "acc", fixture: "acc-2026-04-23T16-42-16-158Z.bin.gz", port: 15331 },
  { gameId: "ac-evo", fixture: "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz", port: 15332 },
  { gameId: "iracing", fixture: "iracing-daytona-am-vantage-gt3-pit.bin.gz", port: 15333 },
  { gameId: "lmu", fixture: "lmu-spa-iron-lynx-gte.bin.gz", port: 15334 },
] as const;
type Args = { engine: "bun" | "rust"; mode: "imports" | "live" | "both"; output: string; baseline?: string };
const IMPORT_MEASURED_TRIALS = 20;
const LIVE_MEASURED_TRIALS = 5;
function median(values: number[]) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null; }
function parseArgs(argv: string[]): Args {
  const values = Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => { const [key, ...rest] = value.slice(2).split("="); return [key, rest.join("=")]; }));
  const engine = values.engine ?? "bun", mode = values.mode ?? "imports";
  if (engine !== "bun" && engine !== "rust") throw Error("--engine must be bun|rust");
  if (!["imports", "live", "both"].includes(mode)) throw Error("--mode must be imports|live|both");
  if (!values.output) throw Error("--output=<path> is required");
  return { engine, mode: mode as Args["mode"], output: resolve(values.output), ...(values.baseline ? { baseline: resolve(values.baseline) } : {}) };
}
const delay = (ms: number) => Bun.sleep(ms);
async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  const exited = Promise.withResolvers<void>();
  proc.once("exit", exited.resolve);
  proc.kill("SIGINT");
  if (await Promise.race([exited.promise.then(() => true), delay(10_000).then(() => false)])) return;
  const killed = Promise.withResolvers<void>();
  proc.once("exit", killed.resolve);
  proc.kill("SIGKILL");
  await killed.promise;
}
async function configureBackendEngine(serverPort: number, udpPort: number, engine: Args["engine"]) {
  const settingsResponse = await fetch(`http://127.0.0.1:${serverPort}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordingEngine: engine, udpPort }),
  });
  const settings = await settingsResponse.json() as Record<string, unknown>;
  if (!settingsResponse.ok) throw Error(`Could not select ${engine} recorder: ${JSON.stringify(settings)}`);
  const statusResponse = await fetch(`http://127.0.0.1:${serverPort}/api/status`);
  const status = await statusResponse.json() as { recordingEngine?: { engine?: unknown; state?: unknown; udpPort?: unknown } };
  if (!statusResponse.ok || status.recordingEngine?.engine !== engine || status.recordingEngine.state !== "ready" || status.recordingEngine.udpPort !== udpPort) {
    throw Error(`Recorder engine selection was not confirmed: requested ${engine} on UDP ${udpPort}, observed ${JSON.stringify(status.recordingEngine)}`);
  }
}

async function launchBackend(dataDir: string, serverPort: number, udpPort: number, engine: Args["engine"]) {
  const proc = spawn(process.execPath, ["run", "apps/backend/src/index.ts"], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, RACEIQ_TEST_MODE: "0", SERVER_PORT: String(serverPort), RACEIQ_DEV_UDP_PORT: String(udpPort), UDP_PORT: String(udpPort), NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
  const sampler = new ProcessTreeSampler(proc);
  let output = "";
  const keep = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-32_000); };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  try {
    await sampler.start();
    const started = Date.now();
    while (!output.includes(`[UDP] Listening on 0.0.0.0:${udpPort}`)) {
      if (proc.exitCode !== null) throw Error(`Backend exited before ready (${proc.exitCode}): ${output}`);
      if (Date.now() - started > 30_000) throw Error(`Backend startup timed out: ${output}`);
      await delay(25);
    }
    await configureBackendEngine(serverPort, udpPort, engine);
    return { proc, sampler, serverPort, engine };
  } catch (error) {
    if (proc.exitCode === null) await stop(proc);
    await sampler.stop();
    throw error;
  }
}
async function launchIsolatedBackend(dataDir: string, serverPort: number, udpPort: number, engine: Args["engine"]) {
  try {
    return await launchBackend(dataDir, serverPort, udpPort, engine);
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

function persistedSessions(dataDir: string) {
  using db = new Database(join(dataDir, "app.db"), { readonly: true });
  return db.query<{ id: number; gameId: string; rawFile: string | null; ownership: string }, []>(
    "SELECT id, game_id AS gameId, raw_file AS rawFile, ownership FROM sessions",
  ).all();
}

async function finalizedLiveCapture(dataDir: string, gameId: string) {
  const sessions = persistedSessions(dataDir).filter((session) => session.gameId === gameId && session.ownership === "mine");
  const liveIds = new Set(sessions.map((session) => session.id));
  using db = new Database(join(dataDir, "app.db"), { readonly: true });
  const liveLapRowsAfterShutdown = db.query<{ sessionId: number }, []>(
    "SELECT session_id AS sessionId FROM laps",
  ).all().filter((lap) => liveIds.has(lap.sessionId)).length;
  let liveRecords = 0, liveCaptureBytes = 0;
  for (const rawFile of new Set(sessions.flatMap((session) => session.rawFile ? [session.rawFile] : []))) {
    const bytes = await readFile(rawFile);
    liveCaptureBytes += bytes.byteLength;
    liveRecords += [...iterateSessionFrames(decompressIfGzipSync(bytes))].length;
  }
  return { liveLapRowsAfterShutdown, liveRecords, liveCaptureBytes, liveCaptureReason: null };
}
async function resources(sampler: ProcessTreeSampler) {
  const stats = await sampler.stop();
  return { sampledProcessTreeCpuSecondsLowerBound: stats.cpuSeconds, peakProcessTreeRssBytes: stats.peakRssBytes, resourceMethod: "100ms ps process-tree snapshots; CPU is a lower bound because exited descendants between samples may be missed; RSS is sampled peak" };
}
function sourceFrameCount(bytes: Buffer): number {
  const capture = decompressIfGzipSync(bytes);
  if (capture.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)) return readIRacingFramesFromBuffer(capture).length;
  if (hasLMUDumpMagic(capture)) return readLMUFramesFromBuffer(capture).length;
  return [...iterateSessionFrames(capture)].length;
}

async function runLive(testCase: typeof GAMES[number], speed: number, trial: number, engine: Args["engine"]) {
  if (testCase.gameId !== "fm-2023" && testCase.gameId !== "f1-2025") throw Error(`Live UDP replay unsupported for ${testCase.gameId}`);
  const dataDir = await mkdtemp(join(tmpdir(), "raceiq-live-bench-"));
  const path = join(FIXTURE_ROOT, testCase.fixture), bytes = await readFile(path);
  const serverPort = 35000 + trial;
  const backend = await launchIsolatedBackend(dataDir, serverPort, testCase.port, engine);
  const abort = new AbortController();
  let replayFinished = false;
  try {
    const upload = new FormData();
    upload.set("file", new File([bytes], testCase.fixture, { type: "application/octet-stream" }));
    upload.set("ownership", "others");
    const seedResponse = await fetch(`http://127.0.0.1:${serverPort}/api/laps/import`, { method: "POST", body: upload, signal: abort.signal });
    const seedResult = await seedResponse.json() as Record<string, unknown>;
    if (!seedResponse.ok) throw Error(`Analysis seed import failed: ${JSON.stringify(seedResult)}`);
    const seedLaps = Array.isArray(seedResult.laps) ? seedResult.laps : [];
    const seedLap = seedLaps.find((row) => row && typeof row === "object" && typeof row.lapId === "number" && typeof row.sessionId === "number");
    if (!seedLap) throw Error("Analysis seed import produced no readable lap");
    const analysisLapId = seedLap.lapId as number;
    const analysisSessionId = seedLap.sessionId as number;
    await backend.sampler.mark();
    const start = process.hrtime.bigint();
    const importPromise = fetch(`http://127.0.0.1:${serverPort}/api/laps/import`, { method: "POST", body: upload, signal: abort.signal }).then(async (response) => {
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw Error(`Concurrent import failed: ${JSON.stringify(result)}`);
      return result;
    }).catch((error) => { abort.abort(error); throw error; });
    const reviewLatencies: number[] = [];
    const analysisLatencies: number[] = [];
    const probe = async () => {
      while (!replayFinished) {
        const began = process.hrtime.bigint();
        const response = await fetch(`http://127.0.0.1:${serverPort}/api/laps/review?gameId=${testCase.gameId}&sessionId=${analysisSessionId}&limit=10`, { signal: abort.signal });
        if (!response.ok) throw Error(`Review API failed: ${response.status}`);
        await response.arrayBuffer();
        reviewLatencies.push(Number(process.hrtime.bigint() - began) / 1e6);
        const analysisStart = process.hrtime.bigint();
        const analysis = await fetch(`http://127.0.0.1:${serverPort}/api/laps/${analysisLapId}/semantic-telemetry`, { headers: { "X-Game-Id": testCase.gameId }, signal: abort.signal });
        if (!analysis.ok) throw Error(`Analysis API failed: ${analysis.status}: ${await analysis.text()}`);
        await analysis.arrayBuffer();
        analysisLatencies.push(Number(process.hrtime.bigint() - analysisStart) / 1e6);
        await delay(250);
      }
    };
    const probeTask = probe().catch((error) => { abort.abort(error); throw error; });
    const replayTask = replayWithNativeClock(path, testCase.gameId, testCase.port, speed, abort.signal).finally(() => { replayFinished = true; });
    const [sourceRecords, importResult] = await Promise.all([replayTask, importPromise, probeTask]);
    await delay(400);
    await stop(backend.proc);
    const liveStats = await finalizedLiveCapture(dataDir, testCase.gameId);
    const processMetrics = await resources(backend.sampler);
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const sortedLatencies = [...reviewLatencies].sort((a, b) => a - b);
    const sortedAnalysisLatencies = [...analysisLatencies].sort((a, b) => a - b);
    const analysisHttpLatencyMs = { count: sortedAnalysisLatencies.length, p50: sortedAnalysisLatencies.length ? sortedAnalysisLatencies[Math.floor((sortedAnalysisLatencies.length - 1) * 0.5)] : null, p95: sortedAnalysisLatencies.length ? sortedAnalysisLatencies[Math.floor((sortedAnalysisLatencies.length - 1) * 0.95)] : null, p99: sortedAnalysisLatencies.length ? sortedAnalysisLatencies[Math.floor((sortedAnalysisLatencies.length - 1) * 0.99)] : null };
    return { engine: backend.engine, fixture: testCase.fixture, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), inputCaptureBytes: bytes.byteLength, elapsedSeconds, ...processMetrics, sourceDatagramsSent: sourceRecords, sourceAcceptedRecords: null, sourceAcceptedRecordsReason: "Recording API does not expose a per-frame accepted-record counter to this harness", sourceRejectedDatagrams: null, sourceRejectedDatagramsReason: "Malformed/rejected source counts are not exposed by the recording API", droppedAtSource: null, droppedAtSourceReason: "UDP sender has no per-datagram ACK/counter", ...liveStats, importedLapCount: importResult.imported ?? null, speedMultiplier: speed, gameClockCadence: "FM TimestampMS / F1 sessionTime native clock proxy; not host acquisition timestamp", analysisHttpLatencyMs, reviewHttpLatencyMs: { count: sortedLatencies.length, p50: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.5)] : null, p95: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.95)] : null, p99: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.95)] : null } };
  } finally {
    replayFinished = true;
    abort.abort();
    if (backend.proc.exitCode === null) await stop(backend.proc);
    await resources(backend.sampler);
    await rm(dataDir, { recursive: true, force: true });
  }
}
async function main() {
  const config = parseArgs(Bun.argv.slice(2));
  await mkdir(dirname(config.output), { recursive: true });
  const trials: Record<string, unknown> = {};
  const limitations = {
    inMemoryImports: "Import cases preload each canonical fixture once, run Bun or Rust parsing/detection in memory, use a no-op DB and recorder, and retain outcomes in memory. No per-trial backend startup or disk writes.",
    importCoverage: "One canonical .bin.gz fixture per supported game; MoTeC, IBT, DuckDB, and ZIP archive import paths are excluded.",
    windowsCapture: "Windows shared-memory acquisition requires Windows; live UDP replay covers FM/F1 only.",
    cadence: "UDP .bin.gz fixtures lack host receive timestamps; FM TimestampMS/F1 sessionTime replay is nominal game-clock cadence, not captured acquisition cadence. 2x/4x replay supported.",
    dashboard: "Live mode measures review HTTP API latency during capture; browser dashboard latency is unavailable without a browser consumer.",
    processResources: "Bun process CPU delta and before/after RSS differ from Rust child process-tree CPU lower-bound and sampled peak RSS; resource values are estimates, not directly equivalent.",
  };
  const report = { schemaVersion: 1, engine: config.engine, mode: config.mode, createdAt: new Date().toISOString(), trials, limitations, baseline: config.baseline ?? null, comparison: null as unknown };
  const save = async () => writeFile(config.output, JSON.stringify(report, null, 2));
  const runSeries = async <T extends { elapsedSeconds: number }>(key: string, run: () => Promise<T>) => {
    const measuredTrials = key.startsWith("live:") ? LIVE_MEASURED_TRIALS : IMPORT_MEASURED_TRIALS;
    const samples: T[] = [];
    const summarize = () => {
      const metric = (name: string) => {
        const values = samples.map((sample) => (sample as unknown as Record<string, unknown>)[name]).filter((value): value is number => typeof value === "number");
        return median(values);
      };
      return {
        status: samples.length === measuredTrials ? "measured" : "running",
        warmupTrials: 1,
        measuredTrialCount: measuredTrials,
        completedMeasuredTrials: samples.length,
        measuredTrials: samples,
        medianElapsedSeconds: median(samples.map((sample) => sample.elapsedSeconds)),
        medianProcessCpuSeconds: metric("processCpuSeconds"),
        medianPeakRssBytes: metric("peakRssBytes"),
        medianImportedLaps: metric("importedLapCount"),
        medianSourceRecordCount: metric("sourceRecordCount"),
        medianInputCaptureBytes: metric("inputCaptureBytes"),
        medianSourceDatagramsSent: metric("sourceDatagramsSent"),
        medianLiveRecords: metric("liveRecords"),
        medianLiveLapRowsAfterShutdown: metric("liveLapRowsAfterShutdown"),
        medianLiveCaptureBytes: metric("liveCaptureBytes"),
      };
    };
    try {
      await run();
      await save();
      for (let index = 0; index < measuredTrials; index++) {
        samples.push(await run());
        trials[key] = summarize();
        await save();
      }
    } catch (error) {
      trials[key] = { ...summarize(), status: "failed", error: error instanceof Error ? error.message : String(error) };
      await save();
      return;
    }
  };
  const recordBlocker = async (key: string, reason: string) => {
    trials[key] = { status: "blocked", reason };
    await save();
  };
  if (config.mode !== "live") {
    if (config.engine === "bun") initServerGameAdapters();
    else startRustBenchProcess();
    for (const testCase of GAMES) {
      const relativePath = `test/artifacts/sessions/${testCase.fixture}`;
      if (!(await Bun.file(resolve(ROOT, relativePath)).exists())) {
        await recordBlocker(`import:${testCase.gameId}`, `Missing original capture fixture: ${relativePath}`);
        continue;
      }
      await runSeries(`import:${testCase.gameId}:${testCase.fixture}`, () => runMemoryImport(testCase, config.engine));
    }
    if (config.engine === "rust") await stopRustBenchProcess();
  }
  if (config.mode !== "imports") {
    for (const testCase of GAMES.slice(0, 2)) {
      const path = join(FIXTURE_ROOT, testCase.fixture);
      if (!(await Bun.file(path).exists())) {
        await recordBlocker(`live:${testCase.gameId}`, `Missing original UDP capture fixture: ${testCase.fixture}`);
        continue;
      }
      for (const speed of [1, 2, 4]) await runSeries(`live:${testCase.gameId}:${speed}x`, () => runLive(testCase, speed, speed === 1 ? 0 : speed, config.engine));
    }
  }
  if (config.baseline) {
    const reference = JSON.parse(await readFile(config.baseline, "utf8")) as { engine?: unknown; trials?: Record<string, Record<string, unknown>> };
    const referenceTrials = reference.trials ?? {};
    const metrics = ["medianElapsedSeconds", "medianProcessCpuSeconds", "medianPeakRssBytes", "medianLiveRecords", "medianLiveCaptureBytes", "medianImportedLaps"];
    const observations: Record<string, Record<string, { baseline: number; current: number; relativeChangePercent: number | null }>> = {};
    for (const [key, value] of Object.entries(trials)) {
      const current = value as Record<string, unknown>;
      const prior = referenceTrials[key];
      if (!prior) continue;
      const matched: Record<string, { baseline: number; current: number; relativeChangePercent: number | null }> = {};
      for (const metric of metrics) {
        if (typeof prior[metric] !== "number" || typeof current[metric] !== "number") continue;
        matched[metric] = { baseline: prior[metric], current: current[metric], relativeChangePercent: prior[metric] === 0 ? null : ((current[metric] - prior[metric]) / prior[metric]) * 100 };
      }
      if (Object.keys(matched).length) observations[key] = matched;
    }
    report.comparison = { referenceEngine: reference.engine ?? null, matchedTrials: Object.keys(observations).length, metricChangesOnly: observations, interpretation: "Relative measurements only; not labelled as speedup." };
  }
  await save();
  console.log(JSON.stringify(report, null, 2));
}
await main();
