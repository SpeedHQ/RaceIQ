import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { decompressIfGzipSync, iterateSessionFrames } from "@raceiq/backend-core/session-capture/framing";
import { IRACING_DUMP_MAGIC, readIRacingFramesFromBuffer } from "@raceiq/capture-formats/iracing/dump";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { recorderBenchmarkFixtureInventory } from "./recorder-bench-fixtures";
import { replayWithNativeClock } from "./recorder-bench-replay";
import { ProcessTreeSampler } from "./recorder-bench-process";

const ROOT = resolve(import.meta.dir, "../../../../");
const FIXTURE_ROOT = join(ROOT, "test/artifacts/sessions");
const GAMES = [
  { gameId: "fm-2023", fixture: "fm-2023-2026-04-09T21-53-00-102Z.bin.gz", port: 15329 },
  { gameId: "f1-2025", fixture: "f1-2025-2026-04-09T21-34-10-190Z.bin.gz", port: 15330 },
  { gameId: "acc", fixture: "acc-2026-04-23T16-42-16-158Z.bin.gz", port: 15331 },
  { gameId: "ac-evo", fixture: "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz", port: 15332 },
  { gameId: "iracing", fixture: "iracing-daytona-am-vantage-gt3-pit.bin.gz", port: 15333 },
  { gameId: "lmu", fixture: "lmu-spa-iron-lynx-gte.bin.gz", port: 15334 },
] as const;
type Args = { engine: "bun" | "rust"; mode: "imports" | "live" | "both"; output: string; baseline?: string };
type ImportResult = { fixture: string; fixtureSha256: string; inputCaptureBytes: number; sourceRecordCount: number | null; sourceRecordReason: string | null; persistedCaptureBytes: number | null; persistedCaptureRecords: number | null; persistedCaptureReason: string | null; elapsedSeconds: number; sampledProcessTreeCpuSecondsLowerBound: number; peakProcessTreeRssBytes: number; rustComputeSeconds: null; ipcSeconds: null; persistenceAnalysisSplitSeconds: null; unobservableTimingReason: string; packetCount: unknown; importedLapCount: unknown; persistedLapRowsByGame: Record<string, number | null>; response: Record<string, unknown> };
function median(values: number[]) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null; }
function parseArgs(argv: string[]): Args {
  const values = Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => { const [key, ...rest] = value.slice(2).split("="); return [key, rest.join("=")]; }));
  const engine = values.engine ?? "bun", mode = values.mode ?? "both";
  if (engine !== "bun" && engine !== "rust") throw Error("--engine must be bun|rust");
  if (!["imports", "live", "both"].includes(mode)) throw Error("--mode must be imports|live|both");
  if (!values.output) throw Error("--output=<path> is required");
  if (engine === "rust") throw Error("Rust recorder benchmark unavailable: bundled recorder client/production engine is not implemented; no Rust timings fabricated.");
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
async function launchBackend(dataDir: string, serverPort: number, udpPort: number) {
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
    return { proc, sampler, serverPort };
  } catch (error) {
    if (proc.exitCode === null) await stop(proc);
    await sampler.stop();
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
async function persistedLapCounts(serverPort: number) {
  const result: Record<string, number | null> = {};
  for (const { gameId } of GAMES) {
    const response = await fetch(`http://127.0.0.1:${serverPort}/api/laps?gameId=${gameId}`);
    if (!response.ok) { result[gameId] = null; continue; }
    const rows = await response.json();
    result[gameId] = Array.isArray(rows) ? rows.length : null;
  }
  return result;
}
async function persistedCaptureMetrics(dataDir: string) {
  const files = new Set(persistedSessions(dataDir).flatMap((session) => session.rawFile ? [session.rawFile] : []));
  let persistedCaptureBytes = 0, persistedCaptureRecords = 0;
  let includesSourceArchive = false;
  for (const file of files) {
    const bytes = await readFile(file);
    persistedCaptureBytes += bytes.byteLength;
    if (/\.(?:bin|bin\.gz)$/i.test(file)) {
      persistedCaptureRecords += [...iterateSessionFrames(decompressIfGzipSync(bytes))].length;
    } else {
      includesSourceArchive = true;
    }
  }
  return {
    persistedCaptureBytes,
    persistedCaptureRecords: includesSourceArchive ? null : persistedCaptureRecords,
    persistedCaptureReason: includesSourceArchive ? "Original source archive storage uses packet indexes, not BIN records" : null,
  };
}
function sourceFrameCount(bytes: Buffer): number {
  const capture = decompressIfGzipSync(bytes);
  if (capture.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)) return readIRacingFramesFromBuffer(capture).length;
  if (hasLMUDumpMagic(capture)) return readLMUFramesFromBuffer(capture).length;
  return [...iterateSessionFrames(capture)].length;
}

async function runBinImport(fixture: string, motec = false, routeOverride?: string): Promise<ImportResult> {
  const path = resolve(ROOT, fixture), bytes = await readFile(path);
  const fixtureSha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceRecordCount = motec || routeOverride ? null : sourceFrameCount(bytes);
  const dataDir = await mkdtemp(join(tmpdir(), "raceiq-import-bench-"));
  const serverPort = 34000 + Math.floor(Math.random() * 1000);
  const backend = await launchIsolatedBackend(dataDir, serverPort, 38000 + serverPort - 34000);
  try {
    const form = new FormData();
    form.set("file", new File([bytes], fixture.split("/").at(-1)!, { type: "application/octet-stream" }));
    form.set("ownership", "mine");
    if (motec) { form.set("gameId", "acc"); form.set("carOrdinal", "33"); form.set("trackOrdinal", "8"); }
    await backend.sampler.mark();
    const start = process.hrtime.bigint();
    const route = routeOverride ?? (motec ? "/api/laps/import-motec" : "/api/laps/import");
    const response = await fetch(`http://127.0.0.1:${serverPort}${route}`, { method: "POST", body: form });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw Error(`Import endpoint returned ${response.status}: ${JSON.stringify(result)}`);
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const processMetrics = await resources(backend.sampler);
    const persisted = await persistedLapCounts(serverPort);
    await stop(backend.proc);
    const captures = await persistedCaptureMetrics(dataDir);
    return { fixture, fixtureSha256, inputCaptureBytes: bytes.byteLength, sourceRecordCount, sourceRecordReason: sourceRecordCount === null ? "Archive input is not a canonical .bin/.bin.gz frame stream" : null, ...captures, elapsedSeconds, ...processMetrics, rustComputeSeconds: null, ipcSeconds: null, persistenceAnalysisSplitSeconds: null, unobservableTimingReason: "Bun route does not expose parser/detector, IPC, and persistence/analysis phase timers.", packetCount: result.packetCount ?? null, importedLapCount: result.imported ?? (Array.isArray(result.laps) ? result.laps.length : null), persistedLapRowsByGame: persisted, response: result };
  } finally {
    if (backend.proc.exitCode === null) await stop(backend.proc);
    await resources(backend.sampler);
    await rm(dataDir, { recursive: true, force: true });
  }
}
async function runIbtImport(fixturePath: string): Promise<ImportResult> {
  const bytes = await readFile(fixturePath);
  const fixture = fixturePath.slice(ROOT.length + 1);
  const fixtureSha256 = createHash("sha256").update(bytes).digest("hex");
  const dataDir = await mkdtemp(join(tmpdir(), "raceiq-ibt-bench-"));
  const serverPort = 35555 + Math.floor(Math.random() * 400);
  const backend = await launchIsolatedBackend(dataDir, serverPort, 39000 + serverPort - 35555);
  try {
    await backend.sampler.mark();
    const start = process.hrtime.bigint();
    const preview = await fetch(`http://127.0.0.1:${serverPort}/api/laps/import-ibt/preview`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": fixture.split("/").at(-1)!, "x-file-size": String(bytes.byteLength) }, body: bytes });
    const previewResult = await preview.json() as Record<string, unknown>;
    if (!preview.ok || typeof previewResult.token !== "string") throw Error(`IBT preview failed: ${JSON.stringify(previewResult)}`);
    const response = await fetch(`http://127.0.0.1:${serverPort}/api/laps/import-ibt/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: previewResult.token, ownership: "mine" }) });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw Error(`IBT commit failed: ${JSON.stringify(result)}`);
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const processMetrics = await resources(backend.sampler);
    const persisted = await persistedLapCounts(serverPort);
    await stop(backend.proc);
    const captures = await persistedCaptureMetrics(dataDir);
    return { fixture, fixtureSha256, inputCaptureBytes: bytes.byteLength, sourceRecordCount: null, sourceRecordReason: "IBT reader source-row count is not included in route response", ...captures, elapsedSeconds, ...processMetrics, rustComputeSeconds: null, ipcSeconds: null, persistenceAnalysisSplitSeconds: null, unobservableTimingReason: "Bun route does not expose parser/detector, IPC, and persistence/analysis phase timers.", packetCount: result.packetCount ?? null, importedLapCount: result.imported ?? null, persistedLapRowsByGame: persisted, response: result };
  } finally {
    if (backend.proc.exitCode === null) await stop(backend.proc);
    await resources(backend.sampler);
    await rm(dataDir, { recursive: true, force: true });
  }
}
async function runLive(testCase: typeof GAMES[number], speed: number, trial: number) {
  if (testCase.gameId !== "fm-2023" && testCase.gameId !== "f1-2025") throw Error(`Live UDP replay unsupported for ${testCase.gameId}`);
  const dataDir = await mkdtemp(join(tmpdir(), "raceiq-live-bench-"));
  const path = join(FIXTURE_ROOT, testCase.fixture), bytes = await readFile(path);
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
    return { fixture: testCase.fixture, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), inputCaptureBytes: bytes.byteLength, elapsedSeconds, ...processMetrics, sourceDatagramsSent: sourceRecords, sourceAcceptedRecords: null, sourceAcceptedRecordsReason: "Bun UDP listener does not expose a per-frame accepted-record counter to this harness", sourceRejectedDatagrams: null, sourceRejectedDatagramsReason: "Malformed/rejected source counts are not exposed by the recording API", droppedAtSource: null, droppedAtSourceReason: "UDP sender has no per-datagram ACK/counter", ...liveStats, importedLapCount: importResult.imported ?? null, speedMultiplier: speed, gameClockCadence: "FM TimestampMS / F1 sessionTime native clock proxy; not host acquisition timestamps", acquisitionToWriteLatencyMs: { p50: null, p95: null, p99: null, reason: "No source acquisition-to-file-write timestamps exposed by Bun API" }, acquisitionToDashboardLatencyMs: { p50: null, p95: null, p99: null, reason: "Browser/dashboard event consumption is not attached; review API latency is reported separately" }, concurrentImport: importResult, analysisHttpLatencyMs, reviewHttpLatencyMs: { count: sortedLatencies.length, p50: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.5)] : null, p95: sortedLatencies.length ? sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.95)] : null }, captureLoss: null, captureLossReason: "UDP replay has no receive ACK; sent and finalized live-written records reported separately." };
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
  const fixtureInventory = await recorderBenchmarkFixtureInventory(ROOT);
  const benchmarkBlockers: string[] = [];
  if (config.mode !== "live" && fixtureInventory.ibtOriginals.length === 0) benchmarkBlockers.push("IBT import: no original .ibt fixture available; synthetic helper recordings excluded.");
  if (config.mode !== "live" && fixtureInventory.duckdbOriginals.length === 0) benchmarkBlockers.push("DuckDB import: no original .duckdb/.wal fixture available; generated test databases excluded.");
  const motecArchives = fixtureInventory.zipArchives.filter((path) => path.includes("/motec/"));
  const raceiqArchives = fixtureInventory.zipArchives.filter((path) => !path.includes("/motec/"));
  if (config.mode !== "live" && raceiqArchives.length === 0) benchmarkBlockers.push("RaceIQ ZIP import: no original multi-capture ZIP fixture available.");
  const limitations = {
    rust: "Bundled recorder client/production engine unavailable; --engine=rust rejects explicitly.",
    importCoverage: "Missing original IBT, DuckDB, and RaceIQ ZIP inputs are reported as blockers; no synthetic timing substitutes.",
    windowsCapture: "Windows shared-memory acquisition requires Windows; live UDP replay covers FM/F1 only.",
    cadence: "UDP .bin.gz fixtures lack host receive timestamps; FM TimestampMS/F1 sessionTime replay is nominal game-clock cadence, not captured acquisition cadence. 2x/4x replay supported.",
    dashboard: "Review HTTP API latency is measured during capture/import; browser dashboard latency is unavailable without a browser consumer.",
    processResources: "100ms ps process-tree snapshots; sampled CPU is a lower bound because short-lived descendants between polls may be missed; RSS is sampled peak.",
  };
  const report = { schemaVersion: 1, engine: config.engine, mode: config.mode, createdAt: new Date().toISOString(), trials, benchmarkBlockers, limitations, fixtureInventory, baseline: config.baseline ?? null, comparison: null as unknown };
  const save = async () => writeFile(config.output, JSON.stringify(report, null, 2));
  const runSeries = async <T extends { elapsedSeconds: number }>(key: string, run: () => Promise<T>) => {
    const samples: T[] = [];
    try {
      await run();
      for (let index = 0; index < 5; index++) samples.push(await run());
      const metric = (name: string) => {
        const values = samples.map((sample) => (sample as unknown as Record<string, unknown>)[name]).filter((value): value is number => typeof value === "number");
        return median(values);
      };
      trials[key] = {
        status: "measured",
        warmupTrials: 1,
        measuredTrials: samples,
        medianElapsedSeconds: median(samples.map((sample) => sample.elapsedSeconds)),
        medianSampledProcessTreeCpuSecondsLowerBound: metric("sampledProcessTreeCpuSecondsLowerBound"),
        medianPeakProcessTreeRssBytes: metric("peakProcessTreeRssBytes"),
        medianImportedLaps: metric("importedLapCount"),
        medianSourceRecordCount: metric("sourceRecordCount"),
        medianInputCaptureBytes: metric("inputCaptureBytes"),
        medianPersistedCaptureRecords: metric("persistedCaptureRecords"),
        medianPersistedCaptureBytes: metric("persistedCaptureBytes"),
        medianSourceDatagramsSent: metric("sourceDatagramsSent"),
        medianLiveRecords: metric("liveRecords"),
        medianLiveLapRowsAfterShutdown: metric("liveLapRowsAfterShutdown"),
        medianLiveCaptureBytes: metric("liveCaptureBytes"),
      };
    } catch (error) {
      trials[key] = { status: "failed", warmupTrials: 1, completedMeasuredTrials: samples.length, measuredTrials: samples, error: error instanceof Error ? error.message : String(error) };
    }
    await save();
  };
  const recordBlocker = async (key: string, reason: string) => {
    trials[key] = { status: "blocked", reason };
    await save();
  };
  if (config.mode !== "live") {
    for (const { gameId, fixture } of GAMES) {
      const relativePath = `test/artifacts/sessions/${fixture}`;
      if (!(await Bun.file(resolve(ROOT, relativePath)).exists())) {
        await recordBlocker(`import:${gameId}`, `Missing original capture fixture: ${relativePath}`);
        continue;
      }
      await runSeries(`import:${gameId}:${fixture}`, () => runBinImport(relativePath));
    }
    for (const fixture of fixtureInventory.ibtOriginals) await runSeries(`import:ibt:${fixture}`, () => runIbtImport(fixture));
    if (fixtureInventory.ibtOriginals.length === 0) await recordBlocker("import:ibt", "No original .ibt fixture found; generated helper recordings are not benchmark evidence.");
    for (const fixture of motecArchives) await runSeries(`import:motec:${fixture}`, () => runBinImport(fixture.slice(ROOT.length + 1), true));
    if (motecArchives.length === 0) await recordBlocker("import:motec", "No MoTeC ZIP fixture with LD+LDX source files found.");
    for (const fixture of raceiqArchives) await runSeries(`import:raceiq-zip:${fixture}`, () => runBinImport(fixture.slice(ROOT.length + 1), false, "/api/laps/import-zip"));
    if (raceiqArchives.length === 0) await recordBlocker("import:raceiq-zip", "No original RaceIQ multi-capture ZIP fixture found.");
    for (const fixture of fixtureInventory.duckdbOriginals) await recordBlocker(`import:duckdb:${fixture}`, "DuckDB import requires original database/WAL and route integration; none available for this standalone upload harness.");
    if (fixtureInventory.duckdbOriginals.length === 0) await recordBlocker("import:duckdb", "No original .duckdb/.wal fixture found; generated test databases are not benchmark evidence.");
  }
  if (config.mode !== "imports") {
    for (const testCase of GAMES.slice(0, 2)) {
      const path = join(FIXTURE_ROOT, testCase.fixture);
      if (!(await Bun.file(path).exists())) {
        await recordBlocker(`live:${testCase.gameId}`, `Missing original UDP capture fixture: ${testCase.fixture}`);
        continue;
      }
      for (const speed of [1, 2, 4]) await runSeries(`live:${testCase.gameId}:${speed}x`, () => runLive(testCase, speed, speed === 1 ? 0 : speed));
    }
  }
  if (config.baseline) {
    const reference = JSON.parse(await readFile(config.baseline, "utf8")) as { engine?: unknown; trials?: Record<string, Record<string, unknown>> };
    const referenceTrials = reference.trials ?? {};
    const metrics = ["medianElapsedSeconds", "medianSampledProcessTreeCpuSecondsLowerBound", "medianPeakProcessTreeRssBytes", "medianLiveRecords", "medianLiveCaptureBytes", "medianImportedLaps"];
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
