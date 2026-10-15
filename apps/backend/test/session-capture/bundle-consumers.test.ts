import { createHash } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions, sessionCaptureSplitJobs } from "@raceiq/backend-core/db/schema";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { enqueueSessionCaptureSplit } from "@raceiq/backend-core/db/session-queries";
import { cacheDelete } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { reprocessSession } from "@raceiq/backend-core/session-capture/reprocess";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { encodeFrameLength, encodeMetaFrame, encodeParserBootstrapFrame, iterateSessionCaptureRecords, PARSER_BOOTSTRAP_VERSION, readFramePrefix } from "@raceiq/capture-formats/session/framing";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { unzipSync } from "fflate";
import { iterateSessionCaptureFrames, clearSessionCaptureCache } from "@raceiq/backend-core/session-capture/source-loader";
import { initServerGameAdapters } from "../../src/games/init";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { notifyDriverProfileLap } from "../../src/driver-profile/runner";
import { lapRoutes } from "../../src/routes/laps/index";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";
import { runSessionCaptureSplitQueueOnce } from "../../src/session-capture/split-manager";
import { buildLapsZip, importLapsZip } from "../../src/laps/archive";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { SESSION_SEGMENT_BOUNDARY } from "@raceiq/capture-formats/session/framing";
import { queryLapTelemetryBySemanticId } from "@raceiq/backend-core/telemetry/replay";
initServerGameAdapters();
registerDriverProfileLapNotifier(notifyDriverProfileLap);
const root = await mkdtemp(join(tmpdir(), "raceiq-bundle-consumers-"));
const sessionIds: number[] = [];
afterAll(async () => {
  for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id)).run();
  await rm(root, { recursive: true, force: true });
});
async function drainSplitQueueUntilReady(sessionId: number): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    const job = await db.select({ status: sessionCaptureSplitJobs.status })
      .from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get();
    if (job?.status === "ready") return;
    if (job?.status !== "queued") {
      throw new Error(`Expected queued split job for session ${sessionId}, got ${job?.status}`);
    }
    await runSessionCaptureSplitQueueOnce();
  }
  throw new Error(`Split job for session ${sessionId} did not become ready`);
}


async function addLap(rawFile: string, offset: number, count: number) {
  const session = await db.insert(sessions).values({ carId: "41", trackId: "19", gameId: "f1-2025", rawFile }).returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const lap = await db.insert(laps).values({ sessionId: session.id, lapNumber: 1, lapTime: 80, isValid: true, rawByteOffset: offset, rawFrameCount: count }).returning({ id: laps.id }).get();
  return { sessionId: session.id, lapId: lap.id };
}

function sourceRecordBytes(capture: Buffer, offset: number): Buffer {
  const prefix = readFramePrefix(capture, offset);
  if (!prefix) throw new Error(`Invalid source frame prefix at ${offset}`);
  return capture.subarray(offset, offset + prefix.prefixBytes + prefix.length);
}

function encodeFrameRecord(frame: Buffer, frameTimeMs?: number): Buffer {
  return Buffer.concat([encodeFrameLength(frame.length, frameTimeMs), frame]);
}

test("direct replay reads owned bundle frames and binary export returns lap artifact; legacy rows still replay", async () => {
  const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
  if (!fixture) throw new Error("Required F1 recording fixture is missing");
  const source = gunzipSync(await readFile(fixture));
  const game = getServerGame("f1-2025");
  if (!game.captureParserCheckpoint || !game.restoreParserCheckpoint) throw new Error("F1 parser checkpoint codec is unavailable");
  const parserState = game.createParserState();
  let sourceOrdinal = 0;
  let ownedSource: { offset: number; frame: Buffer; frameTimeMs?: number } | undefined;
  let checkpoint: Uint8Array | undefined;
  for await (const record of iterateSessionCaptureFrames({ rawFile: fixture, source: null, gameId: "f1-2025", carId: "41", trackId: "19" })) {
    const checkpointBeforeFrame = game.captureParserCheckpoint(parserState);
    const packet = game.tryParse(record.frame, parserState);
    sourceOrdinal++;
    if (sourceOrdinal > 1 && packet && checkpointBeforeFrame) {
      ownedSource = record;
      checkpoint = checkpointBeforeFrame;
      break;
    }
  }
  if (!ownedSource || !checkpoint) throw new Error("Fixture has no checkpointed F1 telemetry frame");
  const ownedSourceBytes = sourceRecordBytes(source, ownedSource.offset);
  const ownedRecord = encodeFrameRecord(ownedSource.frame, ownedSource.frameTimeMs);
  const bootstrap = encodeParserBootstrapFrame("f1-2025", checkpoint);
  const chunk = Buffer.concat([encodeMetaFrame(1), bootstrap, ownedRecord]);
  const ownedLocalOffset = 12 + bootstrap.length;
  const bundlePath = join(root, "bundle.bin");
  const manifestPath = join(root, "manifest.json");
  await writeFile(bundlePath, chunk);
  const decodedBundleFrames = [];
  for await (const record of iterateSessionCaptureFrames({ rawFile: bundlePath, source: null, gameId: "f1-2025", carId: "41", trackId: "19" })) {
    decodedBundleFrames.push(record.frame);
  }
  expect(decodedBundleFrames).toEqual([ownedSource.frame]);
  const { sessionId, lapId } = await addLap(join(root, "missing-source.bin"), ownedSource.offset, 1);
  await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: manifestPath }).where(eq(sessions.id, sessionId)).run();
  await db.update(laps).set({ captureChunkId: "owned" }).where(eq(laps.id, lapId)).run();
  const sourceRecordCount = [...iterateSessionCaptureRecords(source)].filter((record) => record.kind === "frame").length;
  await writeFile(manifestPath, JSON.stringify({
    version: 3, gameId: "f1-2025", sourceRevision: "test", sourceByteLength: source.length, sourceRecordCount,
    chunks: [{ id: "owned", kind: "lap", lapId: String(lapId), lapNumber: 1, path: "bundle.bin", byteLength: chunk.length, firstOrdinal: sourceOrdinal - 1, recordCount: 2, sourceStart: sourceOrdinal - 1, sourceEnd: sourceOrdinal, sourceByteStart: ownedSource.offset, sourceByteEnd: ownedSource.offset + ownedSourceBytes.length, ownedFrameByteOffset: ownedLocalOffset, ownedFrameCount: 1, trailingContextFrameCount: 0 }],
  }));
  cacheDelete(lapId);
  const replay = await getLapById(lapId);
  expect(replay?.parseError).toBeUndefined();
  expect(replay?.telemetry).toHaveLength(1);

  const semanticReplay = await queryLapTelemetryBySemanticId(lapId, ["motion.speed"]);
  expect(semanticReplay?.envelopes[0]?.rawReference).toEqual({
    objectId: `session:${sessionId}:lap-capture:owned`,
    contentHash: `sha256:${createHash("sha256").update(chunk).digest("hex")}`,
    contentEncoding: "identity",
    storageEncoding: "identity",
    byteOffset: ownedLocalOffset,
    frameCount: 1,
  });
  const semantic = await lapRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": "f1-2025" } });
  expect(semantic.status).toBe(200);
  expect((await semantic.json() as { envelopes: unknown[] }).envelopes.length).toBeGreaterThan(0);
  const exported = await lapRoutes.request(`/api/laps/${lapId}/export-bin`);
  expect(exported.status).toBe(200);
  expect(gunzipSync(Buffer.from(await exported.arrayBuffer()))).toEqual(chunk);
  expect(exported.headers.get("content-disposition")).toContain(`-lap1.bin.gz`);

  const legacySource = join(root, "legacy.bin");
  await writeFile(legacySource, source);
  const legacy = await addLap(legacySource, ownedSource.offset, 1);
  const legacyReplay = await getLapById(legacy.lapId);
  expect(legacyReplay?.parseError).toBeUndefined();
  expect(legacyReplay?.telemetry).toHaveLength(1);
  cacheDelete(lapId);
  cacheDelete(legacy.lapId);
});
test("failed segmented import rolls back sessions, captures, and split jobs", async () => {
  const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
  if (!fixture) throw new Error("Required F1 recording fixture is missing");
  const frames: Buffer[] = [];
  for await (const record of iterateSessionCaptureFrames({
    rawFile: fixture, source: null, gameId: "f1-2025", carId: "41", trackId: "19",
  })) frames.push(record.frame);
  const beforeSessions = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(({ id }) => id));
  const beforeJobs = new Set((await db.select({ sessionId: sessionCaptureSplitJobs.sessionId })
    .from(sessionCaptureSplitJobs).all()).map(({ sessionId }) => sessionId));
  await expect(importSessionFrames([
    ...frames,
    SESSION_SEGMENT_BOUNDARY,
    ...frames,
    SESSION_SEGMENT_BOUNDARY,
    { kind: "parser-bootstrap", gameId: "acc", formatVersion: PARSER_BOOTSTRAP_VERSION, payload: Buffer.alloc(0) },
  ], "f1-2025")).rejects.toThrow("Parser bootstrap does not match imported game");
  const afterSessions = await db.select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions).all();
  const added = afterSessions.filter(({ id }) => !beforeSessions.has(id));
  expect(added).toEqual([]);
  const afterJobs = await db.select({ sessionId: sessionCaptureSplitJobs.sessionId })
    .from(sessionCaptureSplitJobs).all();
  expect(afterJobs.filter(({ sessionId }) => !beforeJobs.has(sessionId))).toEqual([]);
  for (const { rawFile } of added) {
    if (rawFile) expect(await Bun.file(rawFile).exists()).toBe(false);
  }
}, 60_000);

test("corrupt published bundle references surface parse error without falling back to source", async () => {
  const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
  if (!fixture) throw new Error("Required F1 recording fixture is missing");
  const source = gunzipSync(await readFile(fixture));
  const sourcePath = join(root, "fallback-must-not-be-used.bin");
  const manifestPath = join(root, "corrupt-manifest.json");
  await writeFile(sourcePath, source);
  await writeFile(manifestPath, "{}");
  const { lapId, sessionId } = await addLap(sourcePath, 12, 1);
  await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: manifestPath }).where(eq(sessions.id, sessionId)).run();
  await db.update(laps).set({ captureChunkId: "missing" }).where(eq(laps.id, lapId)).run();
  const replay = await getLapById(lapId);
  expect(replay?.telemetry).toHaveLength(0);
  expect(replay?.parseError).toBeTruthy();
  cacheDelete(lapId);
});

test("bundle-backed archive export imports with real F1 parser bootstrap intact", async () => {
  const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
  if (!fixture) throw new Error("Required F1 recording fixture is missing");
  const session = await db.insert(sessions).values({
    carId: "41", trackId: "19", gameId: "f1-2025", rawFile: fixture,
  }).returning({ id: sessions.id }).get();
  sessionIds.push(session.id);

  await reprocessSession(session.id);
  const detectedLaps = await db.select().from(laps).where(eq(laps.sessionId, session.id)).all();
  const firstLap = detectedLaps
    .filter(({ rawByteOffset, rawFrameCount }) => rawByteOffset != null && (rawFrameCount ?? 0) > 0)
    .sort((a, b) => a.lapNumber - b.lapNumber)[0];
  if (!firstLap) throw new Error("F1 fixture produced no replayable lap");

  const queuedJob = await db.select({ status: sessionCaptureSplitJobs.status })
    .from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, session.id)).get();
  expect(queuedJob?.status).toBe("queued");
  await drainSplitQueueUntilReady(session.id);
  const job = await db.select({
    status: sessionCaptureSplitJobs.status,
    errorCode: sessionCaptureSplitJobs.errorCode,
    errorMessage: sessionCaptureSplitJobs.errorMessage,
  }).from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, session.id)).get();
  if (job?.status !== "ready") {
    throw new Error(`Expected ready split job, got ${job?.status}: ${job?.errorCode}: ${job?.errorMessage}`);
  }
  const publishedLap = await db.select().from(laps).where(eq(laps.id, firstLap.id)).get();
  if (!publishedLap?.captureChunkId) throw new Error("F1 lap bundle was not published");

  const game = getServerGame("f1-2025");
  if (!game.restoreParserCheckpoint) throw new Error("F1 parser checkpoint restore is unavailable");
  const sourceReplay = await getLapById(publishedLap.id);
  if (!sourceReplay || sourceReplay.parseError) throw new Error("F1 source lap did not replay");
  const sourceTelemetry = sourceReplay.telemetry;
  const archive = await buildLapsZip([publishedLap.id]);
  expect(archive.manifest.entries[0]?.laps.map(({ lapNumber }) => lapNumber)).toEqual([publishedLap.lapNumber]);
  const entryName = archive.manifest.entries[0]!.file;
  const imported = await importLapsZip(archive.bytes);
  expect(imported.skipped).toBe(0);
  expect(imported.laps.length).toBeGreaterThan(0);
  const importedSessionIds = [...new Set(imported.laps.map(({ sessionId }) => sessionId))];
  for (const importedSessionId of importedSessionIds) sessionIds.push(importedSessionId);
  const importedJob = await db.select({ status: sessionCaptureSplitJobs.status })
    .from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, importedSessionIds[0]!)).get();
  expect(importedJob?.status).toBe("queued");
  const zippedFiles = unzipSync(archive.bytes);
  const exportedEntry = gunzipSync(Buffer.from(zippedFiles[entryName]!));
  const exportedRecords = [...iterateSessionCaptureRecords(exportedEntry)];
  const exportedBootstrap = exportedRecords.find((record) => record.kind === "parser-bootstrap");
  expect(exportedBootstrap?.kind).toBe("parser-bootstrap");
  expect(exportedRecords.findIndex((record) => record.kind === "parser-bootstrap"))
    .toBeLessThan(exportedRecords.findIndex((record) => record.kind === "frame"));
  if (exportedBootstrap?.kind === "parser-bootstrap") {
    expect(exportedBootstrap.gameId).toBe("f1-2025");
    expect(exportedBootstrap.formatVersion).toBe(PARSER_BOOTSTRAP_VERSION);
    expect(game.restoreParserCheckpoint(game.createParserState(), exportedBootstrap.payload)).toBeTruthy();
  }
  clearSessionCaptureCache();
  const importedLap = imported.laps.find(({ lapNumber }) => lapNumber === publishedLap.lapNumber);
  if (!importedLap) throw new Error("Imported F1 lap missing");
  cacheDelete(importedLap.lapId);
  clearSessionCaptureCache();
  const coldReplay = await getLapById(importedLap.lapId);
  expect(coldReplay?.parseError).toBeUndefined();
  expect(coldReplay?.telemetry).toEqual(sourceTelemetry);
  expect(coldReplay?.lapTime).toBe(publishedLap.lapTime);
  expect(coldReplay?.isValid).toBe(publishedLap.isValid);
  const reExport = await buildLapsZip([importedLap.lapId]);
  const reExportedEntry = gunzipSync(Buffer.from(unzipSync(reExport.bytes)[reExport.manifest.entries[0]!.file]!));
  const reExportedRecords = [...iterateSessionCaptureRecords(reExportedEntry)];
  const reExportedBootstrapIndex = reExportedRecords.findIndex((record) => record.kind === "parser-bootstrap");
  const reExportedFrameIndex = reExportedRecords.findIndex((record) => record.kind === "frame");
  expect(reExportedBootstrapIndex).toBeGreaterThanOrEqual(0);
  expect(reExportedBootstrapIndex).toBeLessThan(reExportedFrameIndex);
  const reImported = await importLapsZip(reExport.bytes);
  for (const importedSessionId of new Set(reImported.laps.map(({ sessionId }) => sessionId))) sessionIds.push(importedSessionId);
  const reImportedLap = reImported.laps.find(({ lapNumber }) => lapNumber === publishedLap.lapNumber);
  if (!reImportedLap) throw new Error("Re-imported F1 lap missing");
  cacheDelete(reImportedLap.lapId);
  clearSessionCaptureCache();
  const reImportedReplay = await getLapById(reImportedLap.lapId);
  expect(reImportedReplay?.parseError).toBeUndefined();
  expect(reImportedReplay?.telemetry).toEqual(sourceTelemetry);
}, 120000);

test("iRacing checkpoint-dependent archive import cold replay preserves telemetry", async () => {
  const fixture = getRecordingFixture("iracing-daytona-am-vantage-gt3-pit.bin.gz");
  if (!fixture) throw new Error("Required iRacing recording fixture is missing");
  const importedSource = await importSessionFrames(readIRacingFrames(fixture), "iracing");
  const sourceSessionIds = [...new Set(importedSource.laps.map(({ sessionId }) => sessionId))];
  sessionIds.push(...sourceSessionIds);
  const detectedLaps = await db.select().from(laps).where(eq(laps.sessionId, importedSource.laps[0]!.sessionId)).all();
  const sourceLap = detectedLaps
    .filter(({ rawByteOffset, rawFrameCount }) => rawByteOffset != null && (rawFrameCount ?? 0) > 0)
    .sort((a, b) => a.lapNumber - b.lapNumber)[0];
  if (!sourceLap) throw new Error("iRacing fixture produced no replayable lap");
  const sourceReplay = await getLapById(sourceLap.id);
  if (!sourceReplay || sourceReplay.parseError) throw new Error("iRacing source lap did not replay");
  const sourceSessionId = importedSource.laps[0]!.sessionId;
  await drainSplitQueueUntilReady(sourceSessionId);
  const publishedLap = await db.select().from(laps).where(eq(laps.id, sourceLap.id)).get();
  if (!publishedLap?.captureChunkId) throw new Error("iRacing lap bundle was not published");
  const archive = await buildLapsZip([publishedLap.id]);
  const entryName = archive.manifest.entries[0]!.file;
  const exportedEntry = gunzipSync(Buffer.from(unzipSync(archive.bytes)[entryName]!));
  const records = [...iterateSessionCaptureRecords(exportedEntry)];
  expect(records.some((record) => record.kind === "parser-bootstrap" && record.gameId === "iracing")).toBe(true);
  expect(records.findIndex((record) => record.kind === "parser-bootstrap"))
    .toBeLessThan(records.findIndex((record) => record.kind === "frame"));
  const sourceTelemetry = sourceReplay.telemetry;
  const imported = await importLapsZip(archive.bytes);
  for (const importedSessionId of new Set(imported.laps.map(({ sessionId }) => sessionId))) sessionIds.push(importedSessionId);
  expect(imported.skipped).toBe(0);
  const importedLap = imported.laps.find(({ lapNumber }) => lapNumber === sourceLap.lapNumber);
  if (!importedLap) throw new Error("Imported iRacing lap missing");
  cacheDelete(importedLap.lapId);
  clearSessionCaptureCache();
  const coldReplay = await getLapById(importedLap.lapId);
  expect(coldReplay?.parseError).toBeUndefined();
  expect(coldReplay?.telemetry).toEqual(sourceTelemetry);
  expect(coldReplay?.lapTime).toBe(publishedLap.lapTime);
  expect(coldReplay?.isValid).toBe(publishedLap.isValid);
}, 120000);

test("partial published bundle references fail clearly instead of using rawFile", async () => {
  const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
  if (!fixture) throw new Error("Required F1 recording fixture is missing");
  const source = gunzipSync(await readFile(fixture));
  const sourcePath = join(root, "partial-refs-source.bin");
  await writeFile(sourcePath, source);
  const { lapId, sessionId } = await addLap(sourcePath, 12, 1);
  await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: null }).where(eq(sessions.id, sessionId)).run();
  const replay = await getLapById(lapId);
  expect(replay?.telemetry).toHaveLength(0);
  expect(replay?.parseError).toBeTruthy();
  const exported = await lapRoutes.request(`/api/laps/${lapId}/export-bin`);
  expect(exported.status).toBeGreaterThanOrEqual(400);
  cacheDelete(lapId);
});
