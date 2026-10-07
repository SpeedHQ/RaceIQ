import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { decompressIfGzipSync, iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { IRACING_DUMP_MAGIC, readIRacingFramesFromBuffer } from "@raceiq/capture-formats/iracing/dump";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { replayWithClock } from "./recorder-bench-replay";
import { ProcessTreeSampler } from "./recorder-bench-process";
import type { FileImportResponse } from "./recorder-file-import-validation";
import { createInterface } from "node:readline";

import type { GameId } from "@raceiq/shared/games/ids";
import type { MemoryImportResult } from "./recorder-bench-import";
import type * as BenchmarkDatabase from "@raceiq/backend-core/db/index";
import type * as BenchmarkPipeline from "@raceiq/backend-core/telemetry/live-pipeline";
type ImportResult = {
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
const fixtureBytes = new Map<string, Buffer>();
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


function outcomeSignature(result: MemoryImportResult): {
  packetCount: number;
  importedLapCount: number;
  outcomeSha256: string;
  outcome: { packetCount: number; identity: unknown; laps: Record<string, unknown>[] };
} {
  const { packetCount, identity, laps } = result;
  const normalizedLaps = laps.map((lap) => ({
    lapNumber: lap.lapNumber,
    lapTime: lap.lapTime,
    valid: lap.isValid,
    car: lap.carId,
    track: lap.trackId,
  }));
  const outcome = { packetCount, identity, laps: normalizedLaps };
  return {
    packetCount,
    importedLapCount: laps.length,
    outcomeSha256: createHash("sha256").update(stableJson(outcome)).digest("hex"),
    outcome,
  };
}

async function runMemoryImport(testCase: typeof GAMES[number]): Promise<ImportResult> {
  const { fixture, gameId } = testCase;
  const bytes = await loadFixtureBytes(`test/artifacts/sessions/${fixture}`);
  let sourceRecordCount = sourceFrameCounts.get(fixture);
  if (sourceRecordCount === undefined) {
    sourceRecordCount = sourceFrameCount(bytes);
    sourceFrameCounts.set(fixture, sourceRecordCount);
  }
  // Static imports would initialize storage before temporary DATA_DIR; preserve this loading boundary.
  benchmarkDatabase ??= await import("@raceiq/backend-core/db/index");
  benchmarkPipeline ??= await import("@raceiq/backend-core/telemetry/live-pipeline");
  const { runMemoryImport: runMemoryImportInMemory } = await import("./recorder-bench-import");
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const start = process.hrtime.bigint();
  const imported = await runMemoryImportInMemory(bytes, gameId as GameId);
  const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
  const cpu = process.cpuUsage(cpuBefore);
  const processCpuSeconds = (cpu.user + cpu.system) / 1e6;
  const peakRssBytes = Math.max(rssBefore, process.memoryUsage().rss);
  const result = { packetCount: imported.packetCount, laps: imported.laps, identity: imported.identity };
  const resourceMethod = "Bun process CPU delta; RSS sampled before/after each trial";
  return {
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

async function loadFixtureBytes(fixture: string): Promise<Buffer> {
  let bytes = fixtureBytes.get(fixture);
  if (!bytes) {
    bytes = await readFile(resolve(ROOT, fixture));
    fixtureBytes.set(fixture, bytes);
  }
  return bytes;
}
type MemorySample = { peakRssBytes: number; idleRssBytes: number; elapsedSeconds: number; method?: string; status?: string };

async function measureIsolatedMemory(testCase: typeof GAMES[number]): Promise<MemorySample> {
  const child = spawn(process.execPath, ["run", resolve(import.meta.dir, "recorder-bench-memory-child.ts"), testCase.gameId, resolve(ROOT, `test/artifacts/sessions/${testCase.fixture}`)], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr?.resume();
  const exited = Promise.withResolvers<number>();
  child.once("error", (error) => exited.reject(error));
  child.once("exit", (code) => exited.resolve(code ?? -1));
  const lines = createInterface({ input: child.stdout! });
  const lineIterator = lines[Symbol.asyncIterator]();
  const nextEvent = async (): Promise<{ event: string }> => {
    while (true) {
      const line = await lineIterator.next();
      if (line.done) throw new Error("Bun memory child exited without completing protocol");
      if (line.value.startsWith("@recorder-memory ")) return JSON.parse(line.value.slice("@recorder-memory ".length));
    }
  };
  let sampler: ProcessTreeSampler | null = null;
  try {
    if ((await nextEvent()).event !== "ready") throw new Error("Bun memory child failed before ready");
    sampler = new ProcessTreeSampler(child.pid!, true); await sampler.start();
    const idleRssBytes = (await sampler.stop()).peakRssBytes;
    sampler = new ProcessTreeSampler(child.pid!, true); await sampler.start();
    const started = Date.now(); child.stdin?.write("go\n");
    if ((await nextEvent()).event !== "done") throw new Error("Bun memory child failed during import");
    const { peakRssBytes } = await sampler.stop(); child.stdin?.write("release\n");
    const code = await exited.promise; if (code !== 0) throw new Error(`Memory child exited ${code}`);
    return { peakRssBytes, idleRssBytes, elapsedSeconds: (Date.now() - started) / 1000 };
  } finally {
    lines.close(); if (sampler) await sampler.stop();
    if (child.exitCode === null) child.kill("SIGKILL");
    if (child.exitCode === null) await exited.promise;
  }
}

const ROOT = resolve(import.meta.dir, "../../../../");
const FIXTURE_ROOT = join(ROOT, "test/artifacts/sessions");
const memoryDataDir = await mkdtemp(join(tmpdir(), "raceiq-memory-bench-"));
process.env.DATA_DIR = memoryDataDir;
// Capture DB/maintenance handles before helper imports so failed initialization also cleans up.
let benchmarkDatabase: typeof BenchmarkDatabase | undefined;
let benchmarkPipeline: typeof BenchmarkPipeline | undefined;
const GAMES = [
  { gameId: "fm-2023", fixture: "fm-2023-2026-04-09T21-53-00-102Z.bin.gz", port: 15329 },
  { gameId: "f1-2025", fixture: "f1-2025-2026-04-09T21-34-10-190Z.bin.gz", port: 15330 },
  { gameId: "acc", fixture: "acc-2026-04-23T16-42-16-158Z.bin.gz", port: 15331 },
  { gameId: "ac-evo", fixture: "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz", port: 15332 },
  { gameId: "iracing", fixture: "iracing-daytona-am-vantage-gt3-pit.bin.gz", port: 15333 },
  { gameId: "lmu", fixture: "lmu-spa-iron-lynx-gte.bin.gz", port: 15334 },
] as const;
type Args = {
  mode: "imports" | "disk-imports" | "live" | "both" | "recording";
  output: string;
  baseline?: string;
  recordingTrials: number;
  recordingSpeed: number;
  recordingGame?: "fm-2023" | "f1-2025";
  fileImportTrials: number;
  fileImportGame?: typeof GAMES[number]["gameId"];
  game?: typeof GAMES[number]["gameId"];
  smokeTrials: number;
  liveTrials: number;
  storageRoot: string;
};
const IMPORT_MEASURED_TRIALS = 20;
const LIVE_MEASURED_TRIALS = 5;
function median(values: number[]) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null; }
function parseArgs(argv: string[]): Args {
  const values = Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => { const [key, ...rest] = value.slice(2).split("="); return [key, rest.join("=")]; }));
  const mode = values.mode ?? "imports";
  if (!["imports", "disk-imports", "live", "both", "recording"].includes(mode)) throw Error("--mode must be imports|disk-imports|live|both|recording");
  if (!values.output) throw Error("--output=<path> is required");
  const recordingOptions = ["speed", "storage-root"];
  if (mode !== "recording" && mode !== "disk-imports" && recordingOptions.some((key) => key in values)) throw Error("--speed and --storage-root require --mode=recording or --mode=disk-imports");
  if (mode === "disk-imports" && "speed" in values) throw Error("--speed requires --mode=recording");
  const recordingTrials = Number(values.trials ?? LIVE_MEASURED_TRIALS);
  const fileImportTrials = Number(values.trials ?? 1);
  const smokeTrials = Number(values.trials ?? IMPORT_MEASURED_TRIALS);
  const liveTrials = Number(values.trials ?? LIVE_MEASURED_TRIALS);
  const recordingSpeed = Number(values.speed ?? 1);
  if (!Number.isSafeInteger(recordingTrials) || recordingTrials < 1 || !Number.isSafeInteger(fileImportTrials) || fileImportTrials < 1 || !Number.isSafeInteger(smokeTrials) || smokeTrials < 1 || !Number.isSafeInteger(liveTrials) || liveTrials < 1) throw Error("--trials must be a positive integer");
  if (!Number.isFinite(recordingSpeed) || recordingSpeed <= 0) throw Error("--speed must be positive and finite");
  if (values.game !== undefined && !GAMES.some(({ gameId }) => gameId === values.game)) throw Error(`--game must be ${GAMES.map(({ gameId }) => gameId).join("|")}`);
  if (["live", "recording"].includes(mode) && values.game !== undefined && values.game !== "fm-2023" && values.game !== "f1-2025") throw Error(`--game for ${mode} must be fm-2023|f1-2025`);
  return {
    mode: mode as Args["mode"], output: resolve(values.output),
    ...(values.baseline ? { baseline: resolve(values.baseline) } : {}),
    recordingTrials, recordingSpeed, fileImportTrials, smokeTrials, liveTrials,
    ...(mode === "recording" && values.game ? { recordingGame: values.game as Args["recordingGame"] } : {}),
    ...(mode === "disk-imports" && values.game ? { fileImportGame: values.game as Args["fileImportGame"] } : {}),
    ...(["imports", "both", "live"].includes(mode) && values.game ? { game: values.game as Args["game"] } : {}),
    storageRoot: resolve(values["storage-root"] ?? tmpdir()),
  };
}
const delay = (ms: number) => Bun.sleep(ms);
async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = Promise.withResolvers<void>();
  proc.once("exit", exited.resolve);
  proc.kill("SIGINT");
  if (await Promise.race([exited.promise.then(() => true), delay(10_000).then(() => false)])) return;
  const killed = Promise.withResolvers<void>();
  proc.once("exit", killed.resolve);
  proc.kill("SIGKILL");
  await killed.promise;
}
async function configureBackendEngine(serverPort: number, udpPort: number) {
  const settingsResponse = await fetch(`http://127.0.0.1:${serverPort}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ udpPort }),
  });
  const settings = await settingsResponse.json() as Record<string, unknown>;
  if (!settingsResponse.ok) throw Error(`Could not configure recorder: ${JSON.stringify(settings)}`);

}

type BenchmarkBackend = {
  proc: ChildProcess;
  sampler: ProcessTreeSampler;
  serverPort: number;
  diagnosticOutput: () => string;
};

async function launchBackend(dataDir: string, serverPort: number, udpPort: number): Promise<BenchmarkBackend> {
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
    await configureBackendEngine(serverPort, udpPort);
    return { proc, sampler, serverPort, diagnosticOutput: () => output };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { await stop(proc); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await sampler.stop(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `Backend startup failed: ${error instanceof Error ? error.message : String(error)}; cleanup also failed: ${cleanupErrors.map((cleanupError) => cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).join("; ")}`);
    throw error;
  }
}
async function launchIsolatedBackend(dataDir: string, serverPort: number, udpPort: number) {
  try {
    return await launchBackend(dataDir, serverPort, udpPort);
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

async function runLive(testCase: typeof GAMES[number], speed: number, trial: number) {
  if (testCase.gameId !== "fm-2023" && testCase.gameId !== "f1-2025") throw Error(`Live UDP replay unsupported for ${testCase.gameId}`);
  const path = join(FIXTURE_ROOT, testCase.fixture), bytes = await readFile(path);
  const dataDir = await mkdtemp(join(tmpdir(), "raceiq-live-bench-"));
  const serverPort = 35000 + trial;
  const backend = await launchIsolatedBackend(dataDir, serverPort, testCase.port);
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
    const replayTask = replayWithClock(path, testCase.gameId, testCase.port, speed, abort.signal).finally(() => { replayFinished = true; });
    const [sourceRecords, importResult] = await Promise.all([replayTask, importPromise, probeTask]);
    await delay(400);
    await stop(backend.proc);
    const liveStats = await finalizedLiveCapture(dataDir, testCase.gameId);
    const processMetrics = await resources(backend.sampler);
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const sortedLatencies = [...reviewLatencies].sort((a, b) => a - b);
    const sortedAnalysisLatencies = [...analysisLatencies].sort((a, b) => a - b);
    const analysisHttpLatencyMs = { count: sortedAnalysisLatencies.length, p50: sortedAnalysisLatencies.length ? sortedAnalysisLatencies[Math.floor((sortedAnalysisLatencies.length - 1) * 0.5)] : null, p95: sortedAnalysisLatencies.length ? sortedAnalysisLatencies[Math.floor((sortedAnalysisLatencies.length - 1) * 0.95)] : null, p99: sortedAnalysisLatencies.length ? sortedAnalysisLatencies[Math.floor((sortedAnalysisLatencies.length - 1) * 0.99)] : null };
    return { fixture: testCase.fixture, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), inputCaptureBytes: bytes.byteLength, elapsedSeconds, ...processMetrics, sourceDatagramsSent: sourceRecords, sourceAcceptedRecords: null, sourceAcceptedRecordsReason: "Recording API does not expose a per-frame accepted-record counter to this harness", sourceRejectedDatagrams: null, sourceRejectedDatagramsReason: "Malformed/rejected source counts are not exposed by the recording API", droppedAtSource: null, droppedAtSourceReason: "UDP sender has no per-datagram ACK/counter", ...liveStats, importedLapCount: importResult.imported ?? null, speedMultiplier: speed, gameClockCadence: "FM TimestampMS / F1 sessionTime native clock proxy; not host acquisition timestamp", analysisHttpLatencyMs, reviewHttpLatencyMs: { count: sortedLatencies.length, p50: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.5)] : null, p95: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.95)] : null, p99: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.99)] : null } };
  } finally {
    replayFinished = true;
    abort.abort();
    try {
      if (backend.proc.exitCode === null) await stop(backend.proc);
    } finally {
      try { await resources(backend.sampler); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  }
}
async function runRecording(testCase: typeof GAMES[number], config: Args) {
  if (testCase.gameId !== "fm-2023" && testCase.gameId !== "f1-2025") throw Error(`Recording UDP replay unsupported for ${testCase.gameId}`);
  const path = join(FIXTURE_ROOT, testCase.fixture);
  const bytes = await loadFixtureBytes(path);
  await mkdir(config.storageRoot, { recursive: true });
  const dataDir = await mkdtemp(join(config.storageRoot, "raceiq-recording-bench-"));
  const backend = await launchIsolatedBackend(dataDir, 35010, testCase.port);
  const abort = new AbortController();
  const onExit = () => abort.abort(new Error(`Recording backend exited during replay: exit=${backend.proc.exitCode}, signal=${backend.proc.signalCode}`));
  backend.proc.once("exit", onExit);
  if (backend.proc.exitCode !== null || backend.proc.signalCode !== null) onExit();
  try {
    await backend.sampler.mark();
    const start = process.hrtime.bigint();
    const sourceDatagramsSent = await replayWithClock(path, testCase.gameId, testCase.port, config.recordingSpeed, abort.signal);
    const replayEnd = process.hrtime.bigint();
    // Sender completion is not a receiver ACK. Match the live harness's drain allowance.
    await delay(400);
    abort.signal.throwIfAborted();
    backend.proc.removeListener("exit", onExit);
    const shutdownStart = process.hrtime.bigint();
    await stop(backend.proc);
    const end = process.hrtime.bigint();
    if (backend.proc.exitCode !== 0 || backend.proc.signalCode !== null) {
      throw Error(`Recording did not finalize cleanly: exit=${backend.proc.exitCode}, signal=${backend.proc.signalCode}`);
    }
    const processMetrics = await resources(backend.sampler);
    const sessions = persistedSessions(dataDir).filter((session) => session.gameId === testCase.gameId && session.ownership === "mine");
    if (!sessions.length || sessions.some((session) => !session.rawFile)) throw Error("Recording produced no finalized capture for one or more persisted sessions");
    const capture = await finalizedLiveCapture(dataDir, testCase.gameId);
    if (capture.liveRecords === 0 || capture.liveCaptureBytes === 0) throw Error("Finalized recording contains no readable capture records");
    return {
      fixture: testCase.fixture,
      fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
      inputCaptureBytes: bytes.byteLength, sourceDatagramsSent,
      elapsedSeconds: Number(end - start) / 1e9,
      replayWriteSeconds: Number(replayEnd - start) / 1e9,
      receiveDrainSeconds: Number(shutdownStart - replayEnd) / 1e9,
      finalizationSeconds: Number(end - shutdownStart) / 1e9,
      speedMultiplier: config.recordingSpeed, storageRoot: config.storageRoot,
      persistedSessionCount: sessions.length, ...capture, ...processMetrics,
    };
  } catch (error) {
    const reason = abort.signal.aborted ? abort.signal.reason : error;
    throw Error(`${reason instanceof Error ? reason.message : String(reason)}\n${backend.diagnosticOutput()}`);
  } finally {
    backend.proc.removeListener("exit", onExit);
    abort.abort();
    try { await stop(backend.proc); }
    finally {
      try { await resources(backend.sampler); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  }
}

async function runFileImport(testCase: typeof GAMES[number], config: Args) {
  // Validator dependencies open the parent DB; initialize only after temporary DATA_DIR exists.
  // Keep all module initialization outside the measured HTTP/resource window.
  benchmarkDatabase ??= await import("@raceiq/backend-core/db/index");
  const { validateFileImport } = await import("./recorder-file-import-validation");
  const path = join(FIXTURE_ROOT, testCase.fixture);
  await mkdir(config.storageRoot, { recursive: true });
  const dataDir = await mkdtemp(join(config.storageRoot, "raceiq-file-import-bench-"));
  let backend: BenchmarkBackend | undefined;
  let resourceWindowClosed = false;
  let outcome: { failed: false; value: Record<string, unknown> & { elapsedSeconds: number } } | { failed: true; error: unknown };
  const abort = new AbortController();
  const onExit = () => abort.abort(new Error(`File-import backend exited: exit=${backend?.proc.exitCode}, signal=${backend?.proc.signalCode}`));
  try {
    backend = await launchBackend(dataDir, 35010, testCase.port);
    backend.proc.once("exit", onExit);
    if (backend.proc.exitCode !== null || backend.proc.signalCode !== null) onExit();
    await backend.sampler.mark();
    abort.signal.throwIfAborted();
    const start = process.hrtime.bigint();
    // Bun.file remains lazy: source contents are first read by the multipart upload.
    const form = new FormData();
    form.set("file", Bun.file(path), testCase.fixture);
    form.set("ownership", "mine");
    const response = await fetch(`http://127.0.0.1:${backend.serverPort}/api/laps/import`, {
      method: "POST", body: form, signal: abort.signal,
    });
    const result = await response.json() as FileImportResponse;
    const end = process.hrtime.bigint();
    const processMetrics = await resources(backend.sampler);
    resourceWindowClosed = true;
    if (!response.ok) throw Error(`File import failed (${response.status}): ${JSON.stringify(result)}`);
    abort.signal.throwIfAborted();
    const validation = await validateFileImport(dataDir, testCase.gameId, result);
    const hash = createHash("sha256");
    let inputCaptureBytes = 0;
    // Hash only after the measured resource window, without retaining fixture bytes.
    for await (const chunk of createReadStream(path)) {
      inputCaptureBytes += chunk.byteLength;
      hash.update(chunk);
    }
    abort.signal.throwIfAborted();
    outcome = { failed: false, value: {
      gameId: testCase.gameId, fixture: testCase.fixture,
      fixtureSha256: hash.digest("hex"), inputCaptureBytes,
      elapsedSeconds: Number(end - start) / 1e9,
      packetCount: result.packetCount, importedLapCount: result.imported,
      captureStorage: "sparse", ownership: "mine",
      backendExecution: "source-backend",
      storageRoot: config.storageRoot,
      ...validation, ...processMetrics,
    } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = { failed: true, error: new Error(`${message}${backend ? `\n${backend.diagnosticOutput()}` : ""}`, { cause: error }) };
  }
  const cleanupErrors: unknown[] = [];
  if (backend) {
    backend.proc.removeListener("exit", onExit);
    // Stop sampling before shutdown even when the import fails.
    if (!resourceWindowClosed) {
      try { await resources(backend.sampler); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      await stop(backend.proc);
      if (backend.proc.exitCode !== 0 || backend.proc.signalCode !== null) {
        cleanupErrors.push(Error(`File-import backend did not exit cleanly: exit=${backend.proc.exitCode}, signal=${backend.proc.signalCode}`));
      }
    } catch (error) { cleanupErrors.push(error); }
  }
  abort.abort();
  try { await rm(dataDir, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    throw new AggregateError(outcome.failed ? [outcome.error, ...cleanupErrors] : cleanupErrors,
      `${outcome.failed ? `File import failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}; ` : ""}file-import cleanup failed: ${cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`);
  }
  if (outcome.failed) throw outcome.error;
  return outcome.value;
}

async function main() {
  const config = parseArgs(Bun.argv.slice(2));
  await mkdir(dirname(config.output), { recursive: true });
  const trials: Record<string, unknown> = {};
  const limitations = {
    inMemoryImports: "Bun parser/detector pipeline runs in memory; results do not include import persistence or reconciliation. No per-trial backend startup or disk writes.",
    diskRecording: "Recording mode uses production database/capture writes without concurrent import or analysis. Timing includes source replay file decoding, paced replay/writes, a 400ms receive-drain allowance and graceful backend shutdown/finalisation; excludes startup, output validation reads and cleanup. OS cache remains enabled: capture bytes are logical output sizes, not disk-device I/O counters or fsync durability proof. UDP delivery/accepted-record counts are not exposed.",
    diskImports: "Disk-imports uses a fresh source-backend process and database for every measured trial, always zero warmups. Timing covers lazy multipart fixture reading/upload, production decompression/detection, lap replay/finalization and persistence through the completed JSON response. Startup/settings, validation, source hashing and cleanup are excluded. Sparse capture is the production default. No separate lap-finalization duration is instrumented. OS cache remains enabled; trials are not guaranteed cold. Output sizes are logical bytes, not device I/O counters or fsync durability proof.",
    importCoverage: "One canonical .bin.gz fixture per supported game; MoTeC, IBT, DuckDB, and ZIP archive import paths are excluded.",
    windowsCapture: "Windows shared-memory acquisition requires Windows; live UDP replay covers FM/F1 only.",
    cadence: "UDP .bin.gz fixtures lack host receive timestamps; FM TimestampMS/F1 sessionTime replay is nominal game-clock cadence, not captured acquisition cadence. 2x/4x replay supported.",
    dashboard: "Live mode measures review HTTP API latency during capture; browser dashboard latency is unavailable without a browser consumer.",
    processResources: "Throughput-trial resources use process-tree snapshots; isolated memory results describe Bun PID RSS.",
  };
  const memoryMethod = "isolated-bun-pid-ps-rss-100ms-v1";
  const fileImportMethod = "production-http-file-import-source-backend-v1";
  const report = {
    schemaVersion: 1, mode: config.mode, createdAt: new Date().toISOString(),
    trials, limitations, baseline: config.baseline ?? null,
    ...(config.mode === "disk-imports" ? {
      fileImportMethod, warmupTrials: 0, measuredTrialsPerFixture: config.fileImportTrials,
      backendExecution: "source-backend",
      osCache: "enabled; not guaranteed cold",
    } : config.mode === "imports" || config.mode === "both" ? {
      memoryMethod,
      memoryMethodDescription: "One fresh Bun process per fixture; own PID sampled by ps every 100ms. Includes runtime, input and parser state, not allocator-only memory. Brief peaks may be missed; idle RSS contextual only, not subtracted as allocation.",
    } : {}),
    comparison: null as unknown,
  };
  const save = async () => writeFile(config.output, JSON.stringify(report, null, 2));
  const runSeries = async <T extends { elapsedSeconds: number }>(key: string, run: () => Promise<T>) => {
    const measuredTrials = key.startsWith("disk-import:") ? config.fileImportTrials : key.startsWith("recording:") ? config.recordingTrials : key.startsWith("live:") ? config.liveTrials : config.smokeTrials;
    const warmupTrials = key.startsWith("recording:") || key.startsWith("disk-import:") ? 0 : 1;
    const samples: T[] = [];
    const summarize = () => {
      const metric = (name: string) => {
        const values = samples.map((sample) => (sample as unknown as Record<string, unknown>)[name]).filter((value): value is number => typeof value === "number");
        return median(values);
      };
      return {
        status: samples.length === measuredTrials ? "measured" : "running",
        warmupTrials,
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
        medianReplayWriteSeconds: metric("replayWriteSeconds"),
        medianReceiveDrainSeconds: metric("receiveDrainSeconds"),
        medianFinalizationSeconds: metric("finalizationSeconds"),
        medianPersistedSessionCount: metric("persistedSessionCount"),
        ...(key.startsWith("disk-import:") ? {
          medianPacketCount: metric("packetCount"),
          medianPersistedLapCount: metric("persistedLapCount"),
          medianCaptureBytes: metric("captureBytes"),
          medianMetricLapCount: metric("metricLapCount"),
          medianDerivedMetricValueCount: metric("derivedMetricValueCount"),
          medianFinalizedLapCount: metric("finalizedLapCount"),
          medianFinalizedMetricLapCount: metric("finalizedMetricLapCount"),
          validationPassed: samples.length === measuredTrials && samples.every((sample) => (sample as unknown as { validationPassed?: boolean }).validationPassed === true),
        } : {}),
        medianSampledProcessTreeCpuSecondsLowerBound: metric("sampledProcessTreeCpuSecondsLowerBound"),
        medianPeakProcessTreeRssBytes: metric("peakProcessTreeRssBytes"),
      };
    };
    try {
      for (let index = 0; index < warmupTrials; index++) await run();
      await save();
      for (let index = 0; index < measuredTrials; index++) {
        samples.push(await run());
        trials[key] = summarize();
        await save();
      }
    } catch (error) {
      trials[key] = { ...summarize(), status: "failed", error: error instanceof Error ? error.message : String(error) };
      await save();
      process.exitCode = 1;
    }
  };
  const recordBlocker = async (key: string, reason: string) => {
    trials[key] = { status: "blocked", reason };
    await save();
  };
  if (config.mode === "imports" || config.mode === "both") {
    for (const testCase of GAMES.filter(({ gameId }) => !config.game || gameId === config.game)) {
      const relativePath = `test/artifacts/sessions/${testCase.fixture}`;
      if (!(await Bun.file(resolve(ROOT, relativePath)).exists())) {
        await recordBlocker(`import:${testCase.gameId}`, `Missing original capture fixture: ${relativePath}`);
        continue;
      }
      await runSeries(`import:${testCase.gameId}:${testCase.fixture}`, () => runMemoryImport(testCase));
      try {
        const memory = await measureIsolatedMemory(testCase);
        const current = trials[`import:${testCase.gameId}:${testCase.fixture}`] as Record<string, unknown> | undefined;
        if (current) current.memory = { ...memory, method: memoryMethod };
      } catch (error) {
        const current = trials[`import:${testCase.gameId}:${testCase.fixture}`] as Record<string, unknown> | undefined;
        if (current) current.memory = { status: "failed", error: error instanceof Error ? error.message : String(error) };
        process.exitCode = 1;
      }
    }
  }
  if (config.mode === "live" || config.mode === "both") {
    for (const testCase of GAMES.slice(0, 2).filter(({ gameId }) => !config.game || gameId === config.game)) {
      const path = join(FIXTURE_ROOT, testCase.fixture);
      if (!(await Bun.file(path).exists())) {
        await recordBlocker(`live:${testCase.gameId}`, `Missing original UDP capture fixture: ${testCase.fixture}`);
        continue;
      }
      for (const speed of [1, 2, 4]) await runSeries(`live:${testCase.gameId}:${speed}x`, () => runLive(testCase, speed, speed === 1 ? 0 : speed));
    }
  }
  if (config.mode === "recording") {
    for (const testCase of GAMES.slice(0, 2)) {
      if (config.recordingGame && testCase.gameId !== config.recordingGame) continue;
      if (!(await Bun.file(join(FIXTURE_ROOT, testCase.fixture)).exists())) {
        await recordBlocker(`recording:${testCase.gameId}`, `Missing original UDP capture fixture: ${testCase.fixture}`);
        continue;
      }
      await runSeries(`recording:${testCase.gameId}:${config.recordingSpeed}x`, () => runRecording(testCase, config));
    }
  }
  if (config.mode === "disk-imports") {
    for (const testCase of GAMES) {
      if (config.fileImportGame && testCase.gameId !== config.fileImportGame) continue;
      if (!(await Bun.file(join(FIXTURE_ROOT, testCase.fixture)).exists())) {
        await recordBlocker(`disk-import:${testCase.gameId}:${testCase.fixture}`, `Missing original capture fixture: ${testCase.fixture}`);
        continue;
      }
      await runSeries(`disk-import:${testCase.gameId}:${testCase.fixture}`, () => runFileImport(testCase, config));
    }
  }
  if (config.baseline && config.mode !== "disk-imports") {
    const reference = JSON.parse(await readFile(config.baseline, "utf8")) as {
      memoryMethod?: unknown; trials?: Record<string, Record<string, unknown>>;
    };
    const metrics = ["medianElapsedSeconds", "medianProcessCpuSeconds", "medianPeakRssBytes", "medianLiveRecords", "medianLiveCaptureBytes", "medianImportedLaps", "medianReplayWriteSeconds", "medianReceiveDrainSeconds", "medianFinalizationSeconds", "medianSampledProcessTreeCpuSecondsLowerBound", "medianPeakProcessTreeRssBytes"];
    const observations: Record<string, unknown> = {};
    const legacyMemory = reference.memoryMethod !== memoryMethod;
    const numericChanges: Record<string, Record<string, { baseline: number; current: number; relativeChangePercent: number | null }>> = {};
    let matchedTrials = 0;
    for (const [key, raw] of Object.entries(trials)) {
      const current = raw as Record<string, unknown>;
      const prior = reference.trials?.[key];
      const inMemoryImport = key.startsWith("import:");
      const baselineSamples = Array.isArray(prior?.measuredTrials) ? prior.measuredTrials as Record<string, unknown>[] : [];
      const currentSamples = Array.isArray(current.measuredTrials) ? current.measuredTrials as Record<string, unknown>[] : [];
      const incomparableMemory = (reason: string) => inMemoryImport
        ? { status: "incomparable", reason }
        : { status: "not-applicable", reason: "Isolated-PID import memory is not measured for paced live/recording scenarios" };
      if (prior?.status !== "measured" || current.status !== "measured" || !baselineSamples.length || !currentSamples.length) {
        const reason = "Both reports require successful measured trials for this fixture";
        observations[key] = { status: "incomparable", reason, elapsed: null, memory: incomparableMemory(reason) };
        continue;
      }
      const baselineSources = [...new Set(baselineSamples.map((sample) => sample.fixtureSha256))];
      const currentSources = [...new Set(currentSamples.map((sample) => sample.fixtureSha256))];
      const baselineMethods = [...new Set(baselineSamples.map((sample) => sample.resourceMethod))];
      const currentMethods = [...new Set(currentSamples.map((sample) => sample.resourceMethod))];
      const validSignatures = (hashes: unknown[]) => hashes.every((hash) => typeof hash === "string" && hash.length > 0);
      const sameSource = baselineSources.length === 1 && currentSources.length === 1
        && validSignatures(baselineSources) && validSignatures(currentSources) && baselineSources[0] === currentSources[0];
      const sameMethod = baselineMethods.length === 1 && currentMethods.length === 1
        && validSignatures(baselineMethods) && validSignatures(currentMethods) && baselineMethods[0] === currentMethods[0];
      const baselineOutcomes = inMemoryImport ? [...new Set(baselineSamples.map((sample) => sample.outcomeSha256))].sort() : [];
      const currentOutcomes = inMemoryImport ? [...new Set(currentSamples.map((sample) => sample.outcomeSha256))].sort() : [];
      const validBaselineOutcomes = inMemoryImport && validSignatures(baselineOutcomes);
      const validCurrentOutcomes = inMemoryImport && validSignatures(currentOutcomes);
      const sameOutcomes = validBaselineOutcomes && validCurrentOutcomes
        ? JSON.stringify(baselineOutcomes) === JSON.stringify(currentOutcomes) : null;
      const outcomes = inMemoryImport ? {
        equal: sameOutcomes, baselineSha256: baselineOutcomes, currentSha256: currentOutcomes,
        baselineRepeatable: validBaselineOutcomes ? baselineOutcomes.length === 1 : null,
        currentRepeatable: validCurrentOutcomes ? currentOutcomes.length === 1 : null,
        ...(sameOutcomes === false ? {
          baseline: baselineSamples.filter((sample, index) => baselineSamples.findIndex((item) => item.outcomeSha256 === sample.outcomeSha256) === index)
            .map((sample) => ({ outcomeSha256: sample.outcomeSha256, outcome: sample.outcome })),
          current: currentSamples.filter((sample, index) => currentSamples.findIndex((item) => item.outcomeSha256 === sample.outcomeSha256) === index)
            .map((sample) => ({ outcomeSha256: sample.outcomeSha256, outcome: sample.outcome })),
        } : {}),
      } : {
        status: "not-assessed",
        reason: "Paced UDP live/recording outcomes can vary; this harness has no deterministic outcome signature for these scenarios. Numeric changes compare source, resource method and replay pace only, not outcome equality.",
      };
      const fidelity = {
        source: { equal: sameSource, baselineSha256: baselineSources, currentSha256: currentSources },
        resourceMethod: { equal: sameMethod, baseline: baselineMethods, current: currentMethods },
        baselineMeasuredTrials: baselineSamples.length, currentMeasuredTrials: currentSamples.length,
        outcomes,
      };
      if (!sameSource || !sameMethod) {
        const reason = "Source hashes or resource methods are missing, inconsistent or different";
        observations[key] = { status: "incomparable", reason, ...fidelity, elapsed: null, memory: incomparableMemory(reason) };
        continue;
      }
      if (inMemoryImport && (sameOutcomes !== true || baselineOutcomes.length !== 1 || currentOutcomes.length !== 1)) {
        const reason = sameOutcomes === false ? "Normalized import outcomes differ"
          : sameOutcomes === null ? "Normalized import outcome signatures are missing"
          : "Normalized import outcomes are not repeatable within measured trials";
        observations[key] = {
          status: sameOutcomes === false ? "different-outcomes" : sameOutcomes === true ? "nonrepeatable-outcomes" : "incomparable",
          reason, ...fidelity, elapsed: null, memory: incomparableMemory(reason),
        };
        continue;
      }
      let pace: { equal: boolean; baseline: unknown[]; current: unknown[] } | undefined;
      if (!inMemoryImport) {
        const baselinePaces = [...new Set(baselineSamples.map((sample) => sample.speedMultiplier))];
        const currentPaces = [...new Set(currentSamples.map((sample) => sample.speedMultiplier))];
        const samePace = baselinePaces.length === 1 && currentPaces.length === 1
          && typeof baselinePaces[0] === "number" && Number.isFinite(baselinePaces[0]) && baselinePaces[0] > 0
          && baselinePaces[0] === currentPaces[0];
        pace = { equal: samePace, baseline: baselinePaces, current: currentPaces };
        if (!samePace) {
          const reason = "Replay pace is missing, inconsistent or different";
          observations[key] = { status: "incomparable", reason, ...fidelity, pace, elapsed: null, memory: incomparableMemory(reason) };
          continue;
        }
      }
      matchedTrials++;
      const matched: Record<string, { baseline: number; current: number; relativeChangePercent: number | null }> = {};
      for (const metric of metrics) {
        const before = prior[metric], after = current[metric];
        if (typeof before !== "number" || typeof after !== "number" || !Number.isFinite(before) || !Number.isFinite(after)) continue;
        matched[metric] = { baseline: before, current: after, relativeChangePercent: before === 0 ? null : ((after - before) / before) * 100 };
      }
      if (Object.keys(matched).length) numericChanges[key] = matched;
      const baseMemory = prior.memory as MemorySample | undefined;
      const currentMemory = current.memory as MemorySample | undefined;
      const validBaseMemory = baseMemory?.method === memoryMethod && baseMemory.status === undefined
        && Number.isFinite(baseMemory.peakRssBytes) && baseMemory.peakRssBytes > 0;
      const validCurrentMemory = currentMemory?.method === memoryMethod && currentMemory.status === undefined
        && Number.isFinite(currentMemory.peakRssBytes) && currentMemory.peakRssBytes > 0;
      const memory = inMemoryImport && !legacyMemory && baseMemory && currentMemory && validBaseMemory && validCurrentMemory ? {
        baselineMiB: baseMemory.peakRssBytes / 1048576,
        currentMiB: currentMemory.peakRssBytes / 1048576,
        deltaMiB: (currentMemory.peakRssBytes - baseMemory.peakRssBytes) / 1048576,
        deltaPercent: ((currentMemory.peakRssBytes - baseMemory.peakRssBytes) / baseMemory.peakRssBytes) * 100,
      } : incomparableMemory("Baseline/current report lacks a successful matching isolated-PID sampled RSS result");
      const elapsed = matched.medianElapsedSeconds
        ? { baseline: matched.medianElapsedSeconds.baseline, current: matched.medianElapsedSeconds.current } : null;
      observations[key] = {
        status: inMemoryImport ? "matched" : "matched-source-method-and-pace", ...fidelity,
        ...(pace ? { pace } : {}), elapsed, memory,
      };
    }
    report.comparison = {
      matchedTrials, metricChangesOnly: numericChanges, observations,
      ...(config.mode === "imports" || config.mode === "both" ? { memoryMethod: legacyMemory ? "legacy baseline; memory incomparable" : memoryMethod } : {}),
    };
  }
  if (config.baseline && config.mode === "disk-imports") {
    const reference = JSON.parse(await readFile(config.baseline, "utf8")) as {
      mode?: unknown; fileImportMethod?: unknown;
      trials?: Record<string, Record<string, unknown>>;
    };
    if (reference.mode !== config.mode || reference.fileImportMethod !== fileImportMethod) {
      report.comparison = {
        status: "incomparable",
        reason: "Disk-imports requires a disk-imports baseline with the same production HTTP measurement method; memory-import/recording timings are separate modes.",
      };
    } else {
      const observations: Record<string, unknown> = {};
      const numericChanges: Record<string, Record<string, { baseline: number; current: number; relativeChangePercent: number | null }>> = {};
      const metrics = ["medianElapsedSeconds", "medianPacketCount", "medianPersistedSessionCount", "medianPersistedLapCount", "medianCaptureBytes", "medianMetricLapCount", "medianDerivedMetricValueCount", "medianSampledProcessTreeCpuSecondsLowerBound", "medianPeakProcessTreeRssBytes"];
      let matchedTrials = 0;
      for (const [key, raw] of Object.entries(trials)) {
        const current = raw as Record<string, unknown>;
        const prior = reference.trials?.[key];
        const baselineSamples = Array.isArray(prior?.measuredTrials) ? prior.measuredTrials as Record<string, unknown>[] : [];
        const currentSamples = Array.isArray(current.measuredTrials) ? current.measuredTrials as Record<string, unknown>[] : [];
        if (prior?.status !== "measured" || current.status !== "measured" || !baselineSamples.length || !currentSamples.length) {
          observations[key] = { status: "incomparable", reason: "Both reports require successful measured trials for this fixture" };
          continue;
        }
        const baselineSources = [...new Set(baselineSamples.map((sample) => sample.fixtureSha256))];
        const currentSources = [...new Set(currentSamples.map((sample) => sample.fixtureSha256))];
        const baselineMethods = [...new Set(baselineSamples.map((sample) => sample.resourceMethod))];
        const currentMethods = [...new Set(currentSamples.map((sample) => sample.resourceMethod))];
        const baselineOutcomes = [...new Set(baselineSamples.map((sample) => sample.outcomeSha256))].sort();
        const currentOutcomes = [...new Set(currentSamples.map((sample) => sample.outcomeSha256))].sort();
        if (baselineSources.length !== 1 || currentSources.length !== 1 || typeof baselineSources[0] !== "string" || baselineSources[0] !== currentSources[0]
          || baselineMethods.length !== 1 || currentMethods.length !== 1 || typeof baselineMethods[0] !== "string" || baselineMethods[0] !== currentMethods[0]
          || [...baselineOutcomes, ...currentOutcomes].some((hash) => typeof hash !== "string")) {
          observations[key] = { status: "incomparable", reason: "Source hashes, resource methods or normalized outcome signatures are missing or inconsistent" };
          continue;
        }
        matchedTrials++;
        const matched: Record<string, { baseline: number; current: number; relativeChangePercent: number | null }> = {};
        for (const metric of metrics) {
          const before = prior[metric], after = current[metric];
          if (typeof before !== "number" || typeof after !== "number") continue;
          matched[metric] = { baseline: before, current: after, relativeChangePercent: before === 0 ? null : ((after - before) / before) * 100 };
        }
        numericChanges[key] = matched;
        const sameOutcomes = JSON.stringify(baselineOutcomes) === JSON.stringify(currentOutcomes);
        observations[key] = {
          status: sameOutcomes ? "matched" : "different-outcomes", fixtureSha256: baselineSources[0],
          resourceMethod: baselineMethods[0],
          baselineMeasuredTrials: baselineSamples.length, currentMeasuredTrials: currentSamples.length,
          outcomes: {
            equal: sameOutcomes, baselineSha256: baselineOutcomes, currentSha256: currentOutcomes,
            baselineRepeatable: baselineOutcomes.length === 1, currentRepeatable: currentOutcomes.length === 1,
            ...(!sameOutcomes ? {
              baseline: baselineSamples.filter((sample, index) => baselineSamples.findIndex((item) => item.outcomeSha256 === sample.outcomeSha256) === index)
                .map((sample) => ({ outcomeSha256: sample.outcomeSha256, sessionOutcomes: sample.sessionOutcomes, lapOutcomes: sample.lapOutcomes })),
              current: currentSamples.filter((sample, index) => currentSamples.findIndex((item) => item.outcomeSha256 === sample.outcomeSha256) === index)
                .map((sample) => ({ outcomeSha256: sample.outcomeSha256, sessionOutcomes: sample.sessionOutcomes, lapOutcomes: sample.lapOutcomes })),
            } : {}),
          },
        };
      }
      report.comparison = { fileImportMethod, matchedTrials, metricChangesOnly: numericChanges, observations };
    }
  }
  const rows = Object.entries(trials).filter(([key]) => key.startsWith("import:")).map(([key, raw]) => {
    const current = raw as Record<string, unknown>;
    const memory = current.memory as MemorySample | undefined;
    const comparison = report.comparison as { observations?: Record<string, { memory?: { baselineMiB?: number; currentMiB?: number; deltaMiB?: number; deltaPercent?: number | null; status?: string } }> } | null;
    const delta = comparison?.observations?.[key]?.memory;
    const currentMiB = memory && memory.status === undefined && Number.isFinite(memory.peakRssBytes) && memory.peakRssBytes > 0 ? memory.peakRssBytes / 1048576 : null;
    const baselineMiB = delta?.baselineMiB;
    return `${key} | ${typeof current.medianElapsedSeconds === "number" ? current.medianElapsedSeconds.toFixed(3) : "n/a"} | ${baselineMiB?.toFixed(1) ?? "n/a"} | ${currentMiB?.toFixed(1) ?? "n/a"} | ${delta?.deltaMiB !== undefined ? `${delta.deltaMiB.toFixed(1)} MiB (${delta.deltaPercent?.toFixed(1) ?? "n/a"}%)` : delta?.status === "incomparable" ? "N/A (incomparable)" : "n/a"}`;
  });
  if (config.mode !== "disk-imports") console.log("Fixture | elapsed s | baseline RSS MiB | current RSS MiB | absolute/relative delta");
  for (const row of rows) console.log(row);
  if (config.mode === "disk-imports") {
    console.log("Fixture | elapsed s | packets | persisted laps | process-tree CPU s (lower bound) | sampled RSS MiB");
    for (const [key, raw] of Object.entries(trials)) {
      const trial = raw as Record<string, unknown>;
      console.log(`${key} | ${typeof trial.medianElapsedSeconds === "number" ? trial.medianElapsedSeconds.toFixed(3) : "n/a"} | ${trial.medianPacketCount ?? "n/a"} | ${trial.medianPersistedLapCount ?? "n/a"} | ${typeof trial.medianSampledProcessTreeCpuSecondsLowerBound === "number" ? trial.medianSampledProcessTreeCpuSecondsLowerBound.toFixed(3) : "n/a"} | ${typeof trial.medianPeakProcessTreeRssBytes === "number" ? (trial.medianPeakProcessTreeRssBytes / 1048576).toFixed(1) : "n/a"}`);
    }
  }
  await save();
  console.log(JSON.stringify(report, null, 2));
  if ((config.mode === "recording" || config.mode === "disk-imports") && Object.values(trials).some((trial) => !trial || typeof trial !== "object" || !("status" in trial) || trial.status !== "measured")) process.exitCode = 1;
  if (config.mode === "disk-imports" && Object.values(trials).some((trial) => (trial as { validationPassed?: boolean }).validationPassed !== true)) process.exitCode = 1;
}
try {
  await main();
} finally {
  try { benchmarkPipeline?.stopMaintenanceTasks(); }
  finally {
    try { benchmarkDatabase?.client.close(); }
    finally { await rm(memoryDataDir, { recursive: true, force: true }); }
  }
}
