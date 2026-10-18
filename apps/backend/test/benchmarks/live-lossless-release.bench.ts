import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import { createLiveCaptureWorker } from "../../src/session-capture/live-worker-factory";
import { IRACING_DUMP_MAGIC, readIRacingFramesFromBuffer } from "@raceiq/capture-formats/iracing/dump-decoder";
import { decompressIfGzipSync, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump-decoder";
import type { GameId } from "@raceiq/shared/games/ids";
import { LatencyHistogram, NativeRecordDigest, observeEventLoop, processDiskBytes } from "./live-lossless-metrics";
import { Schema } from "effect";
import { LiveArchiveMemberSchema } from "@raceiq/capture-splitting";

const WorkerMessageSchema = Schema.Record(Schema.String, Schema.Unknown);
const ReplayVerificationSchema = Schema.Struct({ parserReplayVerified: Schema.optional(Schema.Boolean) });

const ROOT = resolve(import.meta.dir, "../../../../");
const FIXTURE_ROOT = join(ROOT, "test/artifacts/sessions");
const FIXTURES = [
  { gameId: "fm-2023", fixture: "fm-2023-with-pitting.bin.gz" },
  { gameId: "f1-2025", fixture: "f1-2025-2026-04-09T21-34-10-190Z.bin.gz" },
  { gameId: "acc", fixture: "acc-2026-04-23T16-42-16-158Z.bin.gz" },
  { gameId: "ac-evo", fixture: "session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz" },
  { gameId: "iracing", fixture: "iracing-daytona-am-vantage-gt3-pit.bin.gz" },
  { gameId: "lmu", fixture: "lmu-spa-iron-lynx-gte.bin.gz" },
] as const;
type Frame = { bytes: Buffer; timestampMs?: number };
type Args = { game?: string; trials: number; output: string; rateScale: number };
function args(argv: string[]): Args {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || values.has(match[1]!)) throw Error(`Expected unique --name=value option: ${arg}`);
    values.set(match[1]!, match[2]!);
  }
  for (const key of values.keys()) if (!["game", "trials", "output", "rate-scale"].includes(key)) throw Error(`Unknown option --${key}`);
  const trials = Number(values.get("trials") ?? 3);
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20) throw Error("--trials must be between 1 and 20");
  const game = values.get("game");
  if (game && !FIXTURES.some((item) => item.gameId === game)) throw Error(`No supported real fixture for game ${game}`);
  const output = values.get("output");
  if (!output) throw Error("--output=<path> is required");
  const rateScale = Number(values.get("rate-scale") ?? 1);
  if (!Number.isFinite(rateScale) || rateScale < 0 || rateScale > 64) throw Error("--rate-scale must be between 0 (burst) and 64");
  return { ...(game ? { game } : {}), trials, output: resolve(output), rateScale };
}
function fixtureFrames(bytes: Buffer, gameId: GameId): Frame[] {
  const capture = decompressIfGzipSync(bytes);
  if (gameId === "iracing" && capture.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)) {
    return readIRacingFramesFromBuffer(capture).map((frame) => ({ bytes: frame }));
  }
  if (gameId === "lmu" && hasLMUDumpMagic(capture)) return readLMUFramesFromBuffer(capture).map((frame) => ({ bytes: frame }));
  const frames: Frame[] = [];
  for (const record of iterateSessionCaptureRecords(capture)) {
    if (record.kind === "frame") frames.push({ bytes: record.frame, ...(record.frameTimeMs === undefined ? {} : { timestampMs: record.frameTimeMs }) });
  }
  if (!frames.length) throw Error(`${gameId} fixture contains no supported source frames`);
  return frames;
}
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

async function sourceRate(
  frames: readonly Frame[],
  parse: (bytes: Buffer, timestamp?: number) => { TimestampMS: number; CurrentLap: number } | null,
  gameId: GameId,
): Promise<{ peakFramesPerSecond: number; clockDurationMs: number; clockDomain: "acquisition" | "game" | "game-lap"; unclockedFrames: number }> {
  const acquisition = frames.every((frame) => frame.timestampMs !== undefined && Number.isFinite(frame.timestampMs));
  const lapClock = gameId === "acc" || gameId === "ac-evo";
  let previousClock: number | undefined;
  let groupFrames = 0;
  let unclockedFrames = 0;
  let elapsed = 0;
  let bucket = 0;
  let bucketCount = 0;
  let peak = 0;
  const finishGroup = () => {
    // A long stationary simulation clock cannot establish packet acquisition rate.
    // Preserve every input; report excluded rate samples rather than treating paused traffic as an instantaneous burst.
    if (!acquisition && groupFrames > 128) unclockedFrames += groupFrames;
    else bucketCount += groupFrames;
    groupFrames = 0;
  };
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    const packet = parse(Buffer.from(frame.bytes), frame.timestampMs);
    const clock = acquisition ? frame.timestampMs : packet ? (lapClock ? packet.CurrentLap * 1000 : packet.TimestampMS) : previousClock;
    if (typeof clock !== "number" || !Number.isFinite(clock)) { unclockedFrames++; continue; }
    if (previousClock !== undefined && clock !== previousClock) {
      finishGroup();
      if (clock > previousClock) elapsed += clock - previousClock;
      const nextBucket = Math.floor(elapsed / 1_000);
      if (nextBucket !== bucket) { peak = Math.max(peak, bucketCount); bucket = nextBucket; bucketCount = 0; }
    }
    previousClock = clock;
    groupFrames++;
    if ((index & 4095) === 4095) await Bun.sleep(0);
  }
  finishGroup();
  if (elapsed < 1_000 || Math.max(peak, bucketCount) === 0) throw new Error("Fixture lacks sufficient clocked source coverage to estimate replay rate");
  return { peakFramesPerSecond: Math.max(peak, bucketCount), clockDurationMs: elapsed,
    clockDomain: acquisition ? "acquisition" : lapClock ? "game-lap" : "game", unclockedFrames };
}
type LiveTrial = {
  detectedLapCount: number;
  publishedLapCount: number;
  earlyLapReadWhileRecording: boolean;
  replayedLapCount: number;
  sourceFrameCount: number;
  sourceNativeBytes: number;
  sourceDiskBytes: number;
  elapsedMs: number;
  finalizingMs: number;
  offlineSplitMs: number;
  offlineSplitCpuMs: number;
  offlineArchiveBytes: number;
  liveArchiveBytes: number;
  ingressLatencyMs: { p50: number; p95: number; p99: number };
  readyLatencyMs: { p50: number; p95: number; p99: number };
  peakSourceInFlightBytes: number;
  peakSourcePendingBatchBytes: number;
  cpuMs: number;
  peakRssBytes: number;
  rssGrowthBytes: number;
  parserReplayVerifiedLapCount: number;
  sourceRate: Awaited<ReturnType<typeof sourceRate>>;
  replayFramesPerSecond: number;
  sourceEpochCount: number;
  workerGauges: Record<string, number>;
  eventLoopDelayMs: ReturnType<ReturnType<typeof observeEventLoop>>;
  physicalIoBytes: { read: number; written: number };
};

async function liveFixtureTrial(gameId: GameId, frames: Frame[], root: string, run: number, rateScale: number, purpose: "behavioral" | "performance"): Promise<LiveTrial> {
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.RACEIQ_TEST_MODE = "1";
  process.env.RACEIQ_FEATURE_F1_EXPERIMENTS = "true";
  process.env.RACEIQ_FEATURE_IRACING_ADAPTER = "true";
  const [{ initDb, db }, schema, queries, ports, pipelineModule, dispatch, initGames, lapReader, drizzle, splitRunner, sourceLoader, replayStorage] = await Promise.all([
    import("@raceiq/backend-core/db/index"), import("@raceiq/backend-core/db/schema"),
    import("@raceiq/backend-core/db/live-capture-queries"), import("@raceiq/backend-core/telemetry/pipeline-ports"),
    import("@raceiq/backend-core/telemetry/live-pipeline"), import("@raceiq/backend-core/games/packet-dispatch"),
    import("../../src/games/init"), import("@raceiq/backend-core/db/lap-read-queries"), import("drizzle-orm"),
    import("../../src/session-capture/split-runner"), import("@raceiq/backend-core/session-capture/source-loader"),
    import("@raceiq/backend-core/db/telemetry-replay-storage"),
  ]);
  await initDb();
  initGames.initServerGameAdapters();
  dispatch.resetParserState(gameId);
  const observedRate = await sourceRate(frames, dispatch.parsePacket, gameId);
  dispatch.resetParserState(gameId);
  const replayFramesPerSecond = observedRate.peakFramesPerSecond * rateScale;
  const expected = new Map<string, NativeRecordDigest>();
  const workers = new Set<Worker>();
  const workerGauges: Record<string, number> = {};
  let workerFailure: Error | undefined;
  ports.configureLiveCaptureWorkerFactory((workerGameId) => {
    const worker = createLiveCaptureWorker(workerGameId);
    workers.add(worker);
    worker.on("exit", () => workers.delete(worker));
    worker.on("message", (input: unknown) => {
      const message = Schema.decodeUnknownSync(WorkerMessageSchema)(input);
      if (message.type === "live-failed") workerFailure = new Error(String(message.message));
      if (message.type !== "live-worker-progress") return;
      for (const key of ["sourceCacheBytes", "sourceCacheRecords", "queuedSourceBytes", "queuedSourceRecords",
        "unresolvedCandidates", "checkpointBytes", "pendingControlBytes", "pendingControlRecords", "unreadJournalBytes"]) {
        const value = message[key];
        if (typeof value === "number") workerGauges[key] = Math.max(workerGauges[key] ?? 0, value);
      }
    });
    return worker;
  });
  class ObservedRecorder extends ports.SparseSessionRecorderAdapter {
    override start(id: GameId): void {
      super.start(id);
      if (!this.path) throw new Error("Recorder failed to reserve canonical path");
      expected.set(this.path, new NativeRecordDigest());
    }
    override writeRecord(frame: Buffer, timestampMs?: number): void {
      super.writeRecord(frame, timestampMs);
      if (this.path) expected.get(this.path)!.add(frame, timestampMs);
    }
    override writeRawCaptureBytes(bytes: Buffer): void {
      super.writeRawCaptureBytes(bytes);
      if (!this.path) return;
      for (const record of iterateSessionCaptureRecords(bytes, 0, { strict: true })) {
        if (record.kind === "frame") expected.get(this.path)!.add(record.frame, record.frameTimeMs);
      }
    }
  }
  const recorder = new ObservedRecorder();
  const readyHistogram = new LatencyHistogram();
  const boundAt = new Map<number, bigint>();
  const adapter = new ports.RealDbAdapter({ notifyDriverProfile: false });
  const unbind = adapter.subscribeLapBindings((binding) => boundAt.set(binding.lapId, process.hrtime.bigint()));
  const ws = new class extends ports.NullWsAdapter {
    override broadcastNotification(event: Record<string, unknown>): void {
      if (event.type === "recording-failed") workerFailure = new Error(String(event.error));
      if (event.type !== "lap-capture-ready" || typeof event.lapId !== "number") return;
      const binding = boundAt.get(event.lapId);
      if (binding === undefined) { workerFailure = new Error("Lap published before persisted binding"); return; }
      readyHistogram.record(Number(process.hrtime.bigint() - binding));
      boundAt.delete(event.lapId);
    }
  }();
  const pipeline = new pipelineModule.LiveTelemetryPipeline(adapter, ws, {
    bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, recorder,
  });
  const unsubscribe = dispatch.subscribeParserSource((input) => pipeline.captureParserSource(input));
  replayStorage._telemetryCacheForTest.clear();
  Bun.gc(true);
  const startedAt = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const diskStart = processDiskBytes();
  const stopEventLoop = observeEventLoop();
  const initialRssBytes = process.memoryUsage().rss;
  let peakRssBytes = initialRssBytes;
  let peakSourceInFlightBytes = 0, peakSourcePendingBatchBytes = 0;
  const ingress = new LatencyHistogram();
  let processed = 0, sessionId: number | undefined;
  let finalized = false, earlyLapReadWhileRecording = false;
  let finalization: Promise<void> | undefined;
  const seenLapIds = new Set<number>();
  const replayPublishedLap = async (lapId: number) => {
    const replay = await lapReader.getLapById(lapId);
    if (!replay || replay.parseError) throw new Error(`${gameId} live lap ${lapId} failed archive-backed replay`);
    seenLapIds.add(lapId);
  };
  try {
    for (const frame of frames) {
      if ((processed & 31) === 0) {
        const targetMs = replayFramesPerSecond === 0 ? 0 : processed * 1_000 / replayFramesPerSecond;
        await Bun.sleep(Math.max(0, targetMs - Number(process.hrtime.bigint() - startedAt) / 1e6));
      }
      const input = Buffer.from(frame.bytes);
      const ingressStart = process.hrtime.bigint();
      const packet = dispatch.parsePacket(input, frame.timestampMs);
      if (packet) await pipeline.processPacket(packet, input, frame.timestampMs);
      ingress.record(Number(process.hrtime.bigint() - ingressStart));
      if (workerFailure) throw workerFailure;
      if (recorder.workerRecorder?.error) throw recorder.workerRecorder.error;
      peakSourceInFlightBytes = Math.max(peakSourceInFlightBytes, recorder.workerRecorder?.inFlightByteCount ?? 0);
      peakSourcePendingBatchBytes = Math.max(peakSourcePendingBatchBytes, recorder.workerRecorder?.pendingBatchByteCount ?? 0);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      processed++;
      sessionId = pipeline.lapDetector?.session?.sessionId ?? sessionId;
      if (purpose !== "behavioral" || !sessionId || processed % 256 !== 0) continue;
      const liveLaps = await db.select({ id: schema.laps.id }).from(schema.laps).where(drizzle.eq(schema.laps.sessionId, sessionId)).all();
      for (const lap of liveLaps) {
        if (seenLapIds.has(lap.id)) continue;
        if (!await queries.getLiveLapCaptureSnapshot(sessionId, lap.id)) continue;
        await replayPublishedLap(lap.id);
        if (pipeline.isSessionActive && processed < frames.length) earlyLapReadWhileRecording = true;
      }
    }
    const finalizeStart = process.hrtime.bigint();
    finalization = pipeline.finalizeCurrentSession();
    const deadline = AbortSignal.timeout(10_000);
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([finalization, new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error(`Live close exceeded 10s; worker gauges=${JSON.stringify(workerGauges)}`));
        deadline.addEventListener("abort", onAbort, { once: true });
      })]);
    } finally { if (onAbort) deadline.removeEventListener("abort", onAbort); }
    finalized = true;
    const finalizingMs = Number(process.hrtime.bigint() - finalizeStart) / 1e6;
    const eventLoopDelayMs = stopEventLoop();
    const states = await db.select().from(schema.liveCaptures)
      .where(drizzle.inArray(schema.liveCaptures.sourcePath, [...expected.keys()])).all();
    if (states.length !== expected.size || !states.length || states.some((state) => state.status !== "sealed")) {
      throw new Error(`${gameId} did not seal every source epoch`);
    }
    if (purpose === "behavioral") {
      const membersToReplay = await db.select({ lapId: schema.liveCaptureMembers.lapId }).from(schema.liveCaptureMembers)
        .where(drizzle.inArray(schema.liveCaptureMembers.captureEpoch, states.map((state) => state.captureEpoch))).all();
      for (const member of membersToReplay) {
        if (member.lapId !== null && !seenLapIds.has(member.lapId)) await replayPublishedLap(member.lapId);
      }
    }
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    const liveElapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const cpu = process.cpuUsage(cpuStart);
    const diskEnd = processDiskBytes();
    let detectedLapCount = 0, publishedLapCount = 0, parserReplayVerifiedLapCount = 0;
    let sourceFrameCount = 0, sourceNativeBytes = 0, sourceDiskBytes = 0, liveArchiveBytes = 0;
    let offlineSplitMs = 0, offlineSplitCpuMs = 0, offlineArchiveBytes = 0;
    for (const state of states) {
      const allLaps = await db.select().from(schema.laps).where(drizzle.eq(schema.laps.sessionId, state.sessionId)).all();
      const members = await db.select().from(schema.liveCaptureMembers).where(drizzle.eq(schema.liveCaptureMembers.captureEpoch, state.captureEpoch)).all();
      const descriptors = members.map((member) => Schema.decodeUnknownSync(LiveArchiveMemberSchema)(JSON.parse(member.descriptor)));
      if (Math.max(0, ...descriptors.map((member) => member.sourceEnd)) !== state.sourceRecordCount) throw new Error(`${gameId} epoch has unrepresented logical source records`);
      const native = new NativeRecordDigest();
      const source = await db.select({ rawFile: schema.sessions.rawFile, source: schema.sessions.source,
        carId: schema.sessions.carId, trackId: schema.sessions.trackId }).from(schema.sessions).where(drizzle.eq(schema.sessions.id, state.sessionId)).get();
      if (!source?.rawFile) throw new Error(`${gameId} canonical source missing`);
      for await (const record of sourceLoader.iterateSessionCaptureRecordsFromSource({ ...source, rawFile: source.rawFile, gameId }, { strict: true })) {
        if (record.kind === "frame") native.add(record.frame, record.frameTimeMs);
      }
      const accepted = expected.get(state.sourcePath)!;
      if (native.count !== accepted.count || native.digest() !== accepted.digest()) throw new Error(`${gameId} epoch changed accepted native bytes/order/timestamp presence`);
      sourceFrameCount += native.count;
      sourceNativeBytes += native.bytes;
      sourceDiskBytes += (await stat(state.sourcePath)).size;
      liveArchiveBytes += (await stat(state.archivePath)).size;
      detectedLapCount += allLaps.length;
      publishedLapCount += descriptors.filter((member) => member.kind === "lap").length;
      parserReplayVerifiedLapCount += members.filter((member) =>
        Schema.decodeUnknownSync(ReplayVerificationSchema)(JSON.parse(member.verification)).parserReplayVerified === true).length;
      if (await db.select({ id: schema.sessionCaptureSplitJobs.sessionId }).from(schema.sessionCaptureSplitJobs)
        .where(drizzle.eq(schema.sessionCaptureSplitJobs.sessionId, state.sessionId)).get()) throw new Error(`${gameId} normal close enqueued redundant offline splitting`);
      const offlineStart = process.hrtime.bigint(), offlineCpuStart = process.cpuUsage();
      const offlineDirectory = join(root, `${gameId}-${run}-${state.sessionId}-offline`);
      const manifest = await splitRunner.runSessionCaptureSplit({
        jobId: `live-smoke-${gameId}-${run}-${state.sessionId}`, attemptId: run,
        source: { ...source, rawFile: source.rawFile, gameId }, outputDirectory: offlineDirectory,
        sourceRevision: `live-smoke-${gameId}-${run}-${state.sessionId}`,
        windows: allLaps.flatMap((lap) => lap.rawByteOffset !== null && lap.rawFrameCount !== null && lap.rawFrameCount > 0
          ? [{ lapId: String(lap.id), lapNumber: lap.lapNumber, startByteOffset: lap.rawByteOffset, frameCount: lap.rawFrameCount }] : []),
      });
      offlineSplitMs += Number(process.hrtime.bigint() - offlineStart) / 1e6;
      const offlineCpu = process.cpuUsage(offlineCpuStart);
      offlineSplitCpuMs += (offlineCpu.user + offlineCpu.system) / 1000;
      if (manifest.version !== 4) throw new Error("Offline comparison did not produce indexed v4 archive");
      offlineArchiveBytes += (await stat(join(offlineDirectory, manifest.archiveFile))).size;
      const oracle = await import("./live-lossless-oracle");
      await oracle.verifyLiveCaptureAgainstOffline({ sessionId: state.sessionId, outputDirectory: offlineDirectory });
    }
    if (publishedLapCount !== parserReplayVerifiedLapCount) throw new Error(`${gameId} published lap lacks independent parser evidence`);
    if (detectedLapCount < 2 || publishedLapCount < 2 || (purpose === "behavioral" && !earlyLapReadWhileRecording)) throw new Error(`${gameId} did not satisfy ${purpose} publication/replay coverage`);
    return { detectedLapCount, publishedLapCount, earlyLapReadWhileRecording, replayedLapCount: seenLapIds.size, sourceFrameCount, sourceNativeBytes, sourceDiskBytes,
      sourceRate: observedRate, replayFramesPerSecond, elapsedMs: liveElapsedMs, finalizingMs, offlineSplitMs, offlineSplitCpuMs,
      offlineArchiveBytes, liveArchiveBytes, ingressLatencyMs: ingress.snapshot(), readyLatencyMs: readyHistogram.snapshot(),
      peakSourceInFlightBytes, peakSourcePendingBatchBytes, cpuMs: (cpu.user + cpu.system) / 1000, peakRssBytes,
      parserReplayVerifiedLapCount, sourceEpochCount: states.length, workerGauges, eventLoopDelayMs, rssGrowthBytes: peakRssBytes - initialRssBytes,
      physicalIoBytes: { read: diskEnd.read - diskStart.read, written: diskEnd.written - diskStart.written } };
  } finally {
    unsubscribe(); unbind(); stopEventLoop();
    if (!finalized) {
      await Promise.all([...workers].map((worker) => worker.terminate()));
      await (finalization ?? pipeline.finalizeCurrentSession()).catch(() => {});
    }
  }
}


async function main() {
  const config = args(Bun.argv.slice(2));
  const selected = FIXTURES.filter(({ gameId }) => !config.game || gameId === config.game);
  const missing: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-release-"));
  try {
    for (const item of selected) {
      const fixturePath = join(FIXTURE_ROOT, item.fixture);
      let source: Buffer;
      try { source = await readFile(fixturePath); }
      catch { missing.push(item.fixture); continue; }
      const frames = fixtureFrames(source, item.gameId);
      const runs: LiveTrial[] = [];
      for (let run = 0; run < config.trials; run++) runs.push(await liveFixtureTrial(item.gameId, frames, root, run, config.rateScale, "behavioral"));
      results.push({
        gameId: item.gameId, fixture: item.fixture,
        fixtureSha256: createHash("sha256").update(source).digest("hex"),
        fixtureBytes: source.byteLength, frameCount: frames.length,
        timestampedFrameCount: frames.filter(({ timestampMs }) => timestampMs !== undefined).length,
        detectorOutputLaps: runs.map(({ detectedLapCount }) => detectedLapCount),
        publishedLiveLaps: runs.map(({ publishedLapCount }) => publishedLapCount),
        allTrialsReadLapBeforeClose: runs.every(({ earlyLapReadWhileRecording }) => earlyLapReadWhileRecording),
        metrics: {
          runs,
          ingressLatencyMs: {
            p50: percentile(runs.map((run) => run.ingressLatencyMs.p50), .5),
            p95: percentile(runs.map((run) => run.ingressLatencyMs.p95), .5),
            p99: percentile(runs.map((run) => run.ingressLatencyMs.p99), .5),
          },
          medianElapsedMs: percentile(runs.map((run) => run.elapsedMs), .5),
          medianOfflineSplitMs: percentile(runs.map((run) => run.offlineSplitMs), .5),
          medianOfflineSplitCpuMs: percentile(runs.map((run) => run.offlineSplitCpuMs), .5),
          medianFinalizingMs: percentile(runs.map((run) => run.finalizingMs), .5),
          medianCpuMs: percentile(runs.map((run) => run.cpuMs), .5),
          peakRssBytes: Math.max(...runs.map((run) => run.peakRssBytes)),
          sourceQueuePlateaus: {
            maxInFlightBytes: Math.max(...runs.map((run) => run.peakSourceInFlightBytes)),
            maxPendingBatchBytes: Math.max(...runs.map((run) => run.peakSourcePendingBatchBytes)),
            measurement: "Production WorkerSessionRecorder gauges sampled at every parser ingress frame.",
            splitterPendingQueueBytes: Math.max(...runs.map((run) => run.workerGauges.queuedSourceBytes ?? 0)),
            workerGauges: runs.map((run) => run.workerGauges),
          },
          readyLatencyMs: {
            p50: percentile(runs.map((run) => run.readyLatencyMs.p50), .5),
            p95: percentile(runs.map((run) => run.readyLatencyMs.p95), .5),
            p99: percentile(runs.map((run) => run.readyLatencyMs.p99), .5),
            measurement: "Persisted DB lap binding to lap-capture-ready publication notification; bounded nanosecond histogram.",
          },
          ioArtifactBytesPerRun: runs.map((run) => ({
            canonicalSourceFileBytes: run.sourceDiskBytes,
            liveArchiveBytes: run.liveArchiveBytes,
            offlineArchiveBytes: run.offlineArchiveBytes,
          })),
          physicalIoBytes: runs.map((run) => run.physicalIoBytes),
          physicalIoMeasurement: "OS-attributed process disk bytes via proc_pid_rusage; includes worker threads; page-cache effects apply.",
          eventLoopDelayMs: runs.map((run) => run.eventLoopDelayMs),
          sourceEpochCounts: runs.map((run) => run.sourceEpochCount),
          parserReplayVerifiedLapCount: runs.map((run) => run.parserReplayVerifiedLapCount),
          livePath: "Real detector through parser-source hook, live worker, durable DB publication, archive-backed lap replay while ingress continues, and final seal.",
        },
      });
    }
    const report = {
      benchmark: "live-lossless-detector-behavioral-smoke",
      scope: "Production parser/detector, shared worker, per-lap publication, early archive replay, source epoch conservation, and seal. Includes independent offline detector timing/validity/window comparison and offline member equality. Numeric performance approval requires the separate matched release runner.",
      completedAt: new Date().toISOString(),
      runtime: { bun: Bun.version, node: process.version, platform: process.platform, arch: process.arch },
      hardware: { logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
      trials: config.trials, results, missingFixtures: missing,
    };
    await mkdir(dirname(config.output), { recursive: true });
    await Bun.write(config.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output: config.output, completedGames: results.map((item) => item.gameId), missingFixtures: missing, status: missing.length ? "incomplete-missing-fixtures" : "behavioral-smoke-passed-no-release-budget" }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
export { args, FIXTURES, fixtureFrames, liveFixtureTrial, sourceRate };
if (import.meta.main) await main();
