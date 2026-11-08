import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { initDb, db } from "@raceiq/backend-core/db/index";
import * as schema from "@raceiq/backend-core/db/schema";
import { getLapById, getLapsByIds } from "@raceiq/backend-core/db/lap-read-queries";
import { eq } from "drizzle-orm";
import { RealDbAdapter, NullWsAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { subscribeParserSource, parsePacket, resetParserState } from "@raceiq/backend-core/games/packet-dispatch";
import { initServerGameAdapters } from "../../src/games/init";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { DirectSessionRecorderAdapter, DirectCaptureRecording } from "@raceiq/backend-core/session-capture/direct-recorder";
import { fixtureFrames as decodeFixtureFrames } from "./live-lossless-release.bench";
import { NativeRecordDigest, LatencyHistogram, observeEventLoop, processDiskBytes } from "./live-lossless-metrics";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { Schema } from "effect";
import { GameId as GameIdSchema, ManifestSchema } from "@raceiq/capture-splitting";

const ConfigSchema = Schema.Struct({ gameId: Schema.String, trial: Schema.Number, fixturePath: Schema.String, fixtureSha256: Schema.String, fps: Schema.Number, sampleLimit: Schema.optional(Schema.Number), result: Schema.String });
const configPath = process.argv.find((arg) => arg.startsWith("--config="))?.slice(9);
if (!configPath) throw new Error("--config=<path> required");
const config = Schema.decodeUnknownSync(ConfigSchema)(JSON.parse(await readFile(configPath, "utf8")));
const gameId = Schema.decodeUnknownSync(GameIdSchema)(config.gameId);
const fixtureFrames = decodeFixtureFrames(await readFile(config.fixturePath), gameId);
if (!fixtureFrames.length) throw new Error(`${gameId} fixture has no native frames`);
const frames = config.sampleLimit ? fixtureFrames.slice(0, config.sampleLimit) : fixtureFrames;
await initDb();
initServerGameAdapters();
resetParserState(gameId);

const diskAck = new LatencyHistogram();
const durablePaths = new Set<string>(), closedPaths = new Set<string>();
const expectedBySource = new Map<string, NativeRecordDigest>();
const adapter = new RealDbAdapter({ notifyDriverProfile: false });
const recorder = new DirectSessionRecorderAdapter("mine", { writerOptions: {
  onWritten: (_info, _bytes, elapsedMs) => diskAck.record(elapsedMs * 1e6),
  onDurable: (info) => { durablePaths.add(info.path); },
  onClosed: (info) => { closedPaths.add(info.path); },
} });
const callbacks = { boundaries: 0, admissionOver2ms: 0, writeOver2ms: 0, boundaryOver2ms: 0, combinedNormalOver2ms: 0, combinedBoundaryOver2ms: 0, startupBySessionMs: [] as number[] };
const startupBySource = new Map<string, Promise<void>>();
const originalStart = DirectSessionRecorderAdapter.prototype.start;
DirectSessionRecorderAdapter.prototype.start = function (...args: Parameters<typeof originalStart>) {
  const began = process.hrtime.bigint();
  const result = originalStart.apply(this, args);
  const capture = this.capture;
  if (capture) {
    expectedBySource.set(capture.sourcePath, new NativeRecordDigest());
    if (!startupBySource.has(capture.sourcePath)) startupBySource.set(capture.sourcePath, capture.ready.then(() => { callbacks.startupBySessionMs.push(Number(process.hrtime.bigint() - began) / 1e6); }));
  }
  return result;
};
const pipeline = new LiveTelemetryPipeline(adapter, new NullWsAdapter(), { bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, recorder });
const admissionLatency = new LatencyHistogram(), writeLatency = new LatencyHistogram(), transitionLatency = new LatencyHistogram(), packetLatency = new LatencyHistogram();
const combinedNormalLatency = new LatencyHistogram(), combinedBoundaryLatency = new LatencyHistogram(), heartbeatLatency = new LatencyHistogram();
let inProcessPacket = false, packetSyncWorkNs = 0, packetHadBoundary = false;
const admissionByFrame = new WeakMap<Buffer, number>();
const captureParserSource = pipeline.captureParserSource.bind(pipeline);
pipeline.captureParserSource = ((...args: Parameters<typeof pipeline.captureParserSource>) => {
  const began = process.hrtime.bigint();
  captureParserSource(...args);
  const elapsed = Number(process.hrtime.bigint() - began);
  admissionLatency.record(elapsed);
  admissionByFrame.set(args[0].frame, elapsed);
  if (elapsed > 2e6) callbacks.admissionOver2ms++;
}) as typeof pipeline.captureParserSource;
const originalWriteRecord = DirectCaptureRecording.prototype.writeRecord;
DirectCaptureRecording.prototype.writeRecord = function (...args: Parameters<typeof originalWriteRecord>) {
  expectedBySource.get(this.sourcePath)?.add(args[0], args[1]);
  const began = process.hrtime.bigint();
  const result = originalWriteRecord.apply(this, args);
  const elapsed = Number(process.hrtime.bigint() - began);
  writeLatency.record(elapsed);
  if (elapsed > 2e6) callbacks.writeOver2ms++;
  if (inProcessPacket) packetSyncWorkNs += elapsed;
  return result;
};
const originalWriteRaw = DirectCaptureRecording.prototype.writeRawCaptureBytes;
DirectCaptureRecording.prototype.writeRawCaptureBytes = function (...args: Parameters<typeof originalWriteRaw>) {
  const expected = expectedBySource.get(this.sourcePath);
  if (expected) for (const record of iterateSessionCaptureRecords(args[0], 0, { strict: true })) if (record.kind === "frame") expected.add(record.frame, record.frameTimeMs);
  return originalWriteRaw.apply(this, args);
};
const originalTransitions = DirectCaptureRecording.prototype.processTransitions;
DirectCaptureRecording.prototype.processTransitions = function (...args: Parameters<typeof originalTransitions>) {
  const rotationsBefore = this.rotationCount;
  const began = process.hrtime.bigint();
  const result = originalTransitions.apply(this, args);
  const elapsed = Number(process.hrtime.bigint() - began);
  const rotations = this.rotationCount - rotationsBefore;
  if (inProcessPacket) packetSyncWorkNs += elapsed;
  if (rotations > 0) {
    transitionLatency.record(elapsed);
    callbacks.boundaries += rotations;
    if (elapsed > 2e6) callbacks.boundaryOver2ms++;
    if (inProcessPacket) packetHadBoundary = true;
  }
  return result;
};
const unsubscribe = subscribeParserSource((source) => pipeline.captureParserSource(source));
const stopEventLoop = observeEventLoop();
let peakRssBytes = process.memoryUsage().rss, peakQueueBytes = 0;
const heartbeatPeriodNs = BigInt(Math.round(1e9 / 240));
let heartbeatDeadline = process.hrtime.bigint() + heartbeatPeriodNs;
let missedHeartbeats = 0;
let heartbeatSequence = 0, heartbeatWaiter: (() => void) | undefined;
const sampleHeartbeat = () => {
  heartbeatSequence++;
  const now = process.hrtime.bigint();
  heartbeatLatency.record(Number(now - heartbeatDeadline));
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  peakQueueBytes = Math.max(peakQueueBytes, recorder.capture?.queuedBytes ?? 0);
  const overdue = now > heartbeatDeadline ? Number((now - heartbeatDeadline) / heartbeatPeriodNs) : 0;
  missedHeartbeats += overdue;
  heartbeatDeadline += BigInt(overdue + 1) * heartbeatPeriodNs;
  heartbeatWaiter?.();
  heartbeatWaiter = undefined;
  heartbeatTimer = setTimeout(sampleHeartbeat, Math.max(0, Number(heartbeatDeadline - process.hrtime.bigint()) / 1e6));
};
const started = process.hrtime.bigint(), cpuStart = process.cpuUsage(), diskStart = processDiskBytes();
let heartbeatTimer = setTimeout(sampleHeartbeat, Math.max(0, Number(heartbeatDeadline - started) / 1e6));
let processed = 0;
try {
  for (const frame of frames) {
    const target = started + BigInt(Math.round(processed * 1e9 / config.fps));
    while (process.hrtime.bigint() < target) {
      const remainingMs = Number(target - process.hrtime.bigint()) / 1e6;
      await Bun.sleep(remainingMs > 1 ? Math.floor(remainingMs) : 0);
    }
    const native = Buffer.from(frame.bytes);
    const parsed = parsePacket(native, frame.timestampMs);
    if (parsed) {
      packetSyncWorkNs = admissionByFrame.get(native) ?? 0;
      packetHadBoundary = false;
      inProcessPacket = true;
      const began = process.hrtime.bigint();
      try { await pipeline.processPacket(parsed, native, frame.timestampMs); }
      finally {
        inProcessPacket = false;
        packetLatency.record(Number(process.hrtime.bigint() - began));
        if (packetHadBoundary) combinedBoundaryLatency.record(packetSyncWorkNs);
        else combinedNormalLatency.record(packetSyncWorkNs);
        if (packetSyncWorkNs > 2e6) {
          if (packetHadBoundary) callbacks.combinedBoundaryOver2ms++;
          else callbacks.combinedNormalOver2ms++;
        }
      }
    }
    processed++;
  }
  if (startupBySource.size === 0 && config.sampleLimit === undefined) throw new Error("Production pipeline never started direct recorder");
  await Promise.all(startupBySource.values());
  const finalizationStarted = process.hrtime.bigint();
  await pipeline.finalizeCurrentSession();
  const finalizationMs = Number(process.hrtime.bigint() - finalizationStarted) / 1e6;
  await new Promise<void>((resolvePulse) => { heartbeatWaiter = resolvePulse; });
  clearTimeout(heartbeatTimer);
  const measuredDurationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const cpu = process.cpuUsage(cpuStart), diskEnd = processDiskBytes(), eventLoopDelay = stopEventLoop();
  const measuredPeakRssBytes = peakRssBytes, measuredPeakQueuedBytes = peakQueueBytes, measuredMissedHeartbeats = missedHeartbeats;

  const sessionRows = (await db.select().from(schema.sessions).all()).filter((session) => session.gameId === gameId);
  if (config.sampleLimit === undefined && sessionRows.length !== expectedBySource.size) throw new Error(`Expected ${expectedBySource.size} capture sessions, found ${sessionRows.length}`);
  let totalLapCount = 0, sharedBoundaryPairs = 0, sourceFrames = 0, verifiedChunkCount = 0;
  const sessionResults: Record<string, unknown>[] = [];
  for (const session of sessionRows) {
    if (!session.rawFile) throw new Error(`Session ${session.id} missing direct manifest path`);
    if (session.captureArchiveFile || session.captureManifestFile !== session.rawFile || session.captureLayoutVersion !== 1) throw new Error(`Session ${session.id} is not standalone manifest layout 1`);
    const manifestPath = resolve(session.rawFile), expected = expectedBySource.get(resolve(session.rawFile));
    if (!expected) throw new Error(`No accepted native digest for capture ${manifestPath}`);
    const manifest = Schema.decodeSync(ManifestSchema)(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.sourceCoordinates !== "native-wire-v1") throw new Error(`Session ${session.id} manifest lacks native-wire-v1 coordinates`);
    const queuedSplitJobs = await db.select().from(schema.sessionCaptureSplitJobs).where(eq(schema.sessionCaptureSplitJobs.sessionId, session.id)).all();
    const liveArchives = await db.select().from(schema.liveCaptures).where(eq(schema.liveCaptures.sessionId, session.id)).all();
    if (queuedSplitJobs.length || liveArchives.length) throw new Error(`Session ${session.id} created split-job or live-archive state`);
    const chunks = [...manifest.chunks].sort((left, right) => left.sourceByteStart - right.sourceByteStart);
    let sessionSharedPairs = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const chunkPath = resolve(dirname(manifestPath), chunk.path);
      if (!durablePaths.has(chunkPath) || !closedPaths.has(chunkPath)) throw new Error(`Chunk was not durably synced and closed: ${chunkPath}`);
      verifiedChunkCount++;
      if (index === 0) continue;
      const previous = chunks[index - 1]!;
      const previousPath = resolve(dirname(manifestPath), previous.path);
      const previousRecords = await decodeChunk(previousPath), currentRecords = await decodeChunk(chunkPath);
      const previousFrames = previousRecords.filter((record) => record.kind === "frame");
      const currentSourceFrames = currentRecords.filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame" && record.offset >= (chunk.sourceRecordByteOffset ?? 0));
      const lastNative = previousFrames.at(-1), firstNative = currentSourceFrames[0];
      if (!lastNative || !firstNative || !lastNative.frame.equals(firstNative.frame) || lastNative.frameTimeMs !== firstNative.frameTimeMs) {
        if (config.sampleLimit === undefined) throw new Error(`Decoded native boundary mismatch across ${previous.path} -> ${chunk.path}`);
        continue;
      }
      if (previous.sourceByteEnd !== chunk.sourceByteStart) {
        if (config.sampleLimit === undefined) throw new Error(`Noncontiguous manifest coordinates across ${previous.path} -> ${chunk.path}`);
        continue;
      }
      sessionSharedPairs++;
    }
    if (config.sampleLimit === undefined && chunks.length > 1 && sessionSharedPairs !== chunks.length - 1) throw new Error(`Session ${session.id} has incomplete adjacent-chunk boundary evidence`);
    sharedBoundaryPairs += sessionSharedPairs;
    let reconstructedFrames = 0;
    const actual = new NativeRecordDigest();
    for await (const record of iterateSessionCaptureRecordsFromSource({ rawFile: manifestPath, source: null, gameId, carId: session.carId, trackId: session.trackId })) {
      if (record.kind === "frame") { actual.add(record.frame, record.frameTimeMs); reconstructedFrames++; }
    }
    if (actual.digest() !== expected.digest()) throw new Error(`Session ${session.id} native source mismatch: expected ${expected.digest()} got ${actual.digest()}`);
    sourceFrames += reconstructedFrames;
    const lapRows = await db.select().from(schema.laps).where(eq(schema.laps.sessionId, session.id)).all();
    const lapIds = lapRows.map((lap) => lap.id);
    for (const lapId of lapIds) {
      const lap = await getLapById(lapId);
      if (!lap || lap.parseError) throw new Error(`Session ${session.id} lap ${lapId} unreadable`);
    }
    if ((await getLapsByIds(lapIds)).length !== lapIds.length) throw new Error(`Session ${session.id} getLapsByIds omitted laps`);
    totalLapCount += lapIds.length;
    sessionResults.push({ sessionId: session.id, manifestPath, sourceDigest: actual.digest(), acceptedNativeRecordDigest: expected.digest(), acceptedNativeRecords: expected.count, reconstructedFrames, lapCount: lapIds.length, sharedBoundaryPairs: sessionSharedPairs, durableClosedChunkCount: chunks.length, sourceBytes: manifest.sourceByteLength, sourceRecords: manifest.sourceRecordCount });
  }
  if (sessionRows.length !== expectedBySource.size && config.sampleLimit === undefined) throw new Error(`Unpersisted capture epochs: accepted=${expectedBySource.size}, sessions=${sessionRows.length}`);
  const fullCoverage = callbacks.boundaries > 0 && sharedBoundaryPairs === callbacks.boundaries && verifiedChunkCount > 1;
  if (config.sampleLimit === undefined && !fullCoverage) throw new Error(`Incomplete full-fixture boundary coverage: rotations=${callbacks.boundaries}, decodedPairs=${sharedBoundaryPairs}`);
  const result = {
    gameId, trial: config.trial, fixtureSha256: config.fixtureSha256, fixtureFrameCount: fixtureFrames.length, acceptedNativeRecords: [...expectedBySource.values()].reduce((sum, digest) => sum + digest.count, 0), replayFps: config.fps,
    diagnosticSampleLimit: config.sampleLimit ?? null, measuredDurationMs, finalizationMs, startupBySessionMs: callbacks.startupBySessionMs,
    callbacks: { windowStartRotations: callbacks.boundaries, admissionOver2ms: callbacks.admissionOver2ms, encodingEnqueueOver2ms: callbacks.writeOver2ms, boundaryOver2ms: callbacks.boundaryOver2ms, combinedNormalOver2ms: callbacks.combinedNormalOver2ms, combinedBoundaryOver2ms: callbacks.combinedBoundaryOver2ms },
    latencyMs: { nativeAdmissionQueue: admissionLatency.snapshot(), nativeEncodingEnqueue: writeLatency.snapshot(), boundarySynchronousDispatch: transitionLatency.snapshot(), combinedNormalSyncRecordingWork: combinedNormalLatency.snapshot(), combinedBoundarySyncRecordingWork: combinedBoundaryLatency.snapshot(), processPacketIncludingDbDetectorNotDiskEnqueue: packetLatency.snapshot(), diskWriteAck: diskAck.snapshot(), heartbeatSchedulingLateness240Hz: heartbeatLatency.snapshot() },
    heartbeat: { missedDeadlines: measuredMissedHeartbeats }, disk: { physicalReadBytes: diskEnd.read - diskStart.read, physicalWrittenBytes: diskEnd.written - diskStart.written }, cpuMicros: cpu,
    rss: { peakBytes: measuredPeakRssBytes }, peakQueuedBytes: measuredPeakQueuedBytes, eventLoopDelayMs: eventLoopDelay,
    conservation: { sourceConserved: true, reconstructedFrames: sourceFrames, sharedBoundaryPairs }, replay: { completedLapCount: totalLapCount, allReadableById: true, allReadableByIds: true },
    verifiedChunkCount, sessions: sessionResults, boundaryCoverage: { complete: fullCoverage && config.sampleLimit === undefined, fullCoverageRequired: config.sampleLimit === undefined },
    budget: { limitMs: 2, breaches: callbacks.admissionOver2ms + callbacks.writeOver2ms + callbacks.boundaryOver2ms + callbacks.combinedNormalOver2ms + callbacks.combinedBoundaryOver2ms, passed: callbacks.admissionOver2ms + callbacks.writeOver2ms + callbacks.boundaryOver2ms + callbacks.combinedNormalOver2ms + callbacks.combinedBoundaryOver2ms === 0 },
  };
  await Bun.write(config.result, `${JSON.stringify(result, null, 2)}\n`);
} finally { unsubscribe(); clearTimeout(heartbeatTimer); }

async function decodeChunk(path: string): Promise<SessionCaptureRecord[]> {
  const bytes = await readFile(path);
  return [...iterateSessionCaptureRecords(bytes, 0, { strict: true })];
}
