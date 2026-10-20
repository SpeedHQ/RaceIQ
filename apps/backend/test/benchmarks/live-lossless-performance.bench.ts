import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GameId } from "@raceiq/shared/games/ids";
import { args, FIXTURES, fixtureFrames, liveFixtureTrial, sourceRate } from "./live-lossless-release.bench";
import { LatencyHistogram, observeEventLoop, processDiskBytes } from "./live-lossless-metrics";

// Fixed before matched measurements. A failed budget blocks runtime cutover.
const BUDGETS = {
  ingressP95Ratio: 1.25, ingressP95AllowanceMs: 0.05,
  eventLoopP99AllowanceMs: 2, eventLoopP99AbsoluteMs: 20,
  totalCpuRatio: 1.5, physicalIoRatio: 1.25, physicalIoAllowanceBytes: 1024 * 1024,
  archiveRatio: 1.1, archiveAllowanceBytes: 4096,
  closeMs: 500, readyP99Ms: 2000, additionalRssBytes: 64 * 1024 * 1024,
  sourceInFlightBytes: 16 * 1024 * 1024, sourceBatchBytes: 4 * 1024 * 1024,
  workerSourceCacheBytes: 8 * 1024 * 1024, workerSourceCacheRecords: 1024,
  workerQueueBytes: 8 * 1024 * 1024, workerControlBytes: 8 * 1024 * 1024,
  workerControlRecords: 1024, workerCheckpointBytes: 4 * 1024 * 1024, workerCandidates: 4,
} as const;

type Frames = ReturnType<typeof fixtureFrames>;
async function legacyTrial(gameId: GameId, frames: Frames, root: string, run: number, rateScale: number) {
  process.env.DATA_DIR = join(root, "data");
  process.env.RACEIQ_TEST_MODE = "1";
  process.env.RACEIQ_FEATURE_F1_EXPERIMENTS = "true";
  process.env.RACEIQ_FEATURE_IRACING_ADAPTER = "true";
  await mkdir(process.env.DATA_DIR, { recursive: true });
  const [{ initDb, db }, schema, ports, pipelines, dispatch, games, drizzle, split, replayStorage] = await Promise.all([
    import("@raceiq/backend-core/db/index"), import("@raceiq/backend-core/db/schema"),
    import("@raceiq/backend-core/telemetry/pipeline-ports"), import("@raceiq/backend-core/telemetry/live-pipeline"),
    import("@raceiq/backend-core/games/packet-dispatch"), import("../../src/games/init"), import("drizzle-orm"),
    import("../../src/session-capture/split-runner"),
    import("@raceiq/backend-core/db/telemetry-replay-storage"),
  ]);
  await initDb(); games.initServerGameAdapters(); dispatch.resetParserState(gameId);
  const rate = await sourceRate(frames, dispatch.parsePacket, gameId);
  dispatch.resetParserState(gameId);
  const paths = new Set<string>();
  class LegacyRecorder extends ports.SparseSessionRecorderAdapter {
    constructor() { super("mine", {}, "offline"); }
    override start(id: GameId) {
      super.start(id);
      if (!this.path) throw new Error("Legacy recorder did not reserve source path");
      paths.add(this.path);
    }
  }
  const recorder = new LegacyRecorder();
  const pipeline = new pipelines.LiveTelemetryPipeline(new ports.RealDbAdapter({ notifyDriverProfile: false }), new ports.NullWsAdapter(), {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, enqueueSessionCaptureSplits: false,
  });
  const unsubscribe = dispatch.subscribeParserSource((input) => pipeline.captureParserSource(input));
  replayStorage._telemetryCacheForTest.clear();
  Bun.gc(true);
  const startedAt = process.hrtime.bigint(), cpuStart = process.cpuUsage(), ioStart = processDiskBytes();
  const stopEventLoop = observeEventLoop();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const ingress = new LatencyHistogram();
  let processed = 0;
  let finalizingMs = 0;
  try {
    for (const frame of frames) {
      if ((processed & 31) === 0) {
        const target = rate.peakFramesPerSecond * rateScale;
        await Bun.sleep(Math.max(0, target ? processed * 1000 / target - Number(process.hrtime.bigint() - startedAt) / 1e6 : 0));
      }
      const native = Buffer.from(frame.bytes), before = process.hrtime.bigint();
      const packet = dispatch.parsePacket(native, frame.timestampMs);
      if (packet) await pipeline.processPacket(packet, native, frame.timestampMs);
      ingress.record(Number(process.hrtime.bigint() - before));
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      processed++;
    }
    const beforeClose = process.hrtime.bigint();
    await pipeline.finalizeCurrentSession();
    finalizingMs = Number(process.hrtime.bigint() - beforeClose) / 1e6;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  } finally { unsubscribe(); await pipeline.finalizeCurrentSession(); }
  // Old FileSink close does not fsync. Attribute its outstanding writes to the
  // baseline, not to the following live trial's OS I/O counters.
  let finalDurabilityFenceMs = 0;
  for (const path of paths) {
    const before = process.hrtime.bigint(), handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    finalDurabilityFenceMs += Number(process.hrtime.bigint() - before) / 1e6;
  }
  const ingressCpu = process.cpuUsage(cpuStart), ingressIo = processDiskBytes();
  const eventLoopDelayMs = stopEventLoop();
  let splitCpuMs = 0, splitMs = 0, archiveBytes = 0, splitReadBytes = 0, splitWrittenBytes = 0, lapCount = 0;
  const epochs = await db.select({ sessionId: schema.sessions.id, rawFile: schema.sessions.rawFile,
    source: schema.sessions.source, carId: schema.sessions.carId, trackId: schema.sessions.trackId }).from(schema.sessions)
    .where(drizzle.inArray(schema.sessions.rawFile, [...paths])).all();
  if (epochs.length !== paths.size || epochs.length === 0) throw new Error("Legacy baseline lost a source epoch");
  for (const epoch of epochs) {
    if (!epoch.rawFile) throw new Error("Legacy canonical source missing");
    const rows = await db.select().from(schema.laps).where(drizzle.eq(schema.laps.sessionId, epoch.sessionId)).all();
    lapCount += rows.length;
    const cpu = process.cpuUsage(), io = processDiskBytes(), before = process.hrtime.bigint();
    const outputDirectory = join(root, `baseline-${gameId}-${run}-${epoch.sessionId}`);
    const manifest = await split.runSessionCaptureSplit({
      jobId: `legacy-release-${epoch.sessionId}`, attemptId: run, outputDirectory,
      source: { ...epoch, rawFile: epoch.rawFile, gameId }, sourceRevision: `legacy-release-${epoch.sessionId}`,
      windows: rows.flatMap((lap) => lap.rawByteOffset !== null && lap.rawFrameCount !== null && lap.rawFrameCount > 0
        ? [{ lapId: String(lap.id), lapNumber: lap.lapNumber, startByteOffset: lap.rawByteOffset, frameCount: lap.rawFrameCount }] : []),
    });
    if (manifest.version !== 4) throw new Error("Legacy baseline archive is not indexed v4");
    const archivePath = join(outputDirectory, manifest.archiveFile);
    const beforeFence = process.hrtime.bigint(), handle = await open(archivePath, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    finalDurabilityFenceMs += Number(process.hrtime.bigint() - beforeFence) / 1e6;
    splitMs += Number(process.hrtime.bigint() - before) / 1e6;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const used = process.cpuUsage(cpu), disk = processDiskBytes();
    splitCpuMs += (used.user + used.system) / 1000;
    splitReadBytes += disk.read - io.read; splitWrittenBytes += disk.written - io.written;
    archiveBytes += (await stat(archivePath)).size;
  }
  return { ingressLatencyMs: ingress.snapshot(), eventLoopDelayMs, finalizingMs, splitMs, finalDurabilityFenceMs,
    cpuMs: (ingressCpu.user + ingressCpu.system) / 1000 + splitCpuMs, archiveBytes, lapCount, sourceEpochCount: epochs.length,
    rssGrowthBytes: peakRss - initialRss, physicalIoBytes: {
      read: ingressIo.read - ioStart.read + splitReadBytes, written: ingressIo.written - ioStart.written + splitWrittenBytes,
    } };
}

function budgetFailures(legacy: Awaited<ReturnType<typeof legacyTrial>>, live: Awaited<ReturnType<typeof liveFixtureTrial>>, rateScale: number) {
  const errors: string[] = [];
  const upper = (name: string, actual: number, limit: number) => { if (actual > limit) errors.push(`${name}: ${actual} > ${limit}`); };
  upper("ingress p95 ms", live.ingressLatencyMs.p95, legacy.ingressLatencyMs.p95 * BUDGETS.ingressP95Ratio + BUDGETS.ingressP95AllowanceMs);
  upper("event-loop p99 ms", live.eventLoopDelayMs.p99, Math.min(BUDGETS.eventLoopP99AbsoluteMs, legacy.eventLoopDelayMs.p99 + BUDGETS.eventLoopP99AllowanceMs));
  upper("total CPU ms", live.cpuMs, legacy.cpuMs * BUDGETS.totalCpuRatio);
  upper("physical disk bytes", live.physicalIoBytes.read + live.physicalIoBytes.written,
    (legacy.physicalIoBytes.read + legacy.physicalIoBytes.written) * BUDGETS.physicalIoRatio + BUDGETS.physicalIoAllowanceBytes);
  upper("archive bytes", live.liveArchiveBytes, legacy.archiveBytes * BUDGETS.archiveRatio + BUDGETS.archiveAllowanceBytes);
  if (rateScale === 1) upper("close ms", live.finalizingMs, BUDGETS.closeMs);
  upper("ready p99 ms", live.readyLatencyMs.p99, BUDGETS.readyP99Ms);
  upper("RSS growth bytes", live.rssGrowthBytes, legacy.rssGrowthBytes + BUDGETS.additionalRssBytes);
  upper("source transport bytes", live.peakSourceInFlightBytes, BUDGETS.sourceInFlightBytes);
  upper("source batch bytes", live.peakSourcePendingBatchBytes, BUDGETS.sourceBatchBytes);
  const gauges = live.workerGauges;
  for (const [key, limit] of Object.entries({ sourceCacheBytes: BUDGETS.workerSourceCacheBytes,
    sourceCacheRecords: BUDGETS.workerSourceCacheRecords, queuedSourceBytes: BUDGETS.workerQueueBytes,
    pendingControlBytes: BUDGETS.workerControlBytes, pendingControlRecords: BUDGETS.workerControlRecords,
    checkpointBytes: BUDGETS.workerCheckpointBytes, unresolvedCandidates: BUDGETS.workerCandidates })) {
    const value = gauges[key];
    if (value === undefined) errors.push(`missing worker measurement: ${key}`);
    else upper(key, value, limit);
  }
  if (legacy.lapCount !== live.detectedLapCount || legacy.sourceEpochCount !== live.sourceEpochCount) errors.push("Matched baseline detector outputs differ");
  return errors;
}

async function main() {
  const config = args(Bun.argv.slice(2));
  const selected = FIXTURES.filter((item) => !config.game || item.gameId === config.game);
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-performance-"));
  const results: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  try {
    for (const item of selected) {
      const bytes = await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions", item.fixture));
      const frames = fixtureFrames(bytes, item.gameId);
      const trials = [];
      for (let run = 0; run < config.trials; run++) {
        // Both paths use identical parser/detector contracts, source primer, fixture, pacing, and DB settings.
        const legacy = await legacyTrial(item.gameId, frames, root, run, config.rateScale);
        const live = await liveFixtureTrial(item.gameId, frames, root, run, config.rateScale, "performance");
        const errors = budgetFailures(legacy, live, config.rateScale);
        failures.push(...errors.map((error) => `${item.gameId} trial ${run}: ${error}`));
        trials.push({ legacy, live, errors });
      }
      results.push({ gameId: item.gameId, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), trials });
    }
    const completeCoverage = selected.length === FIXTURES.length && config.trials >= 3 && config.rateScale === 1;
    const processors = cpus();
    const report = { benchmark: "live-lossless-matched-release", completedAt: new Date().toISOString(), budgets: BUDGETS,
      trials: config.trials, rateScale: config.rateScale,
      closeBudgetScope: "500 ms at sustained game rate (scale 1). Accelerated/unpaced stress reports complete backlog drain latency without this cap; all other budgets and conservation/verification checks remain enforced.",
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, osRelease: release(),
        logicalCpus: processors.length, cpuModel: processors[0]?.model ?? "unknown", memoryBytes: totalmem() },
      baseline: "Capture-only comparison: synchronous legacy sparse recorder on the same corrected parser/detector and canonical primer, followed by the production offline splitter; no live worker. Both timed variants exclude user replay/cache work. Early replay/export and reconnect are separate mandatory behavioral/UI gates. Final source/archive fsync fences attribute deferred legacy writes before the next trial.",
      measurements: "OS-attributed process disk bytes include worker threads; page-cache effects apply. Each variant starts with empty replay cache and full GC. RSS includes recording, close, and offline splitting. Ingress histograms exclude pacing; event-loop delay uses platform clock.",
      completeCoverage, results, failures, passed: completeCoverage && failures.length === 0 };
    await mkdir(dirname(config.output), { recursive: true });
    await Bun.write(config.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output: config.output, completeCoverage, budgetFailures: failures.length, passed: report.passed }));
    if (failures.length || !completeCoverage) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
await main();
