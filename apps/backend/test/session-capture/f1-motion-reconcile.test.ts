import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { db, client } from "@raceiq/backend-core/db/index";
import { laps, sessions, sessionCaptureSplitJobs } from "@raceiq/backend-core/db/schema";
import { LAP_DETECTOR_ID } from "@raceiq/backend-core/lap-detection/detector";
import * as publication from "@raceiq/backend-core/db/lap-reprocessing-queries";
import { enqueueSessionCaptureSplit, getQueuedSessionCaptureSplitJobs, claimSessionCaptureSplitJob, validateSessionCaptureSplitRevision } from "@raceiq/backend-core/db/session-queries";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";
import { iterateSessionFrames, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame } from "@raceiq/capture-formats/session/framing";
import { SessionRecorder } from "@raceiq/capture-formats/session/recorder";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { prepareDownsampleCaptureBundles } from "@raceiq/backend-core/session-capture/downsample-bundles";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { disposeRecordingMaintenanceRuntime } from "@raceiq/backend-core/session-capture/maintenance-runtime";
import { beginRecordingStorageImport } from "@raceiq/backend-core/session-capture/storage-activity";
import { runSessionCaptureMaintenanceNow, startSessionCompressor, stopSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import * as f1Reconciliation from "@raceiq/backend-core/session-capture/f1-motion-reconcile";
import { Effect } from "effect";
import * as livePipeline from "@raceiq/backend-core/telemetry/live-pipeline";
import { storageRoutes } from "../../src/routes/system/storage-routes";

const fixture = getRecordingFixture("f1-2025-2026-04-22T11-42-43-029Z.bin.gz");
if (!fixture) throw new Error("Required F1 recording fixture missing");
const frames: Buffer[] = [];
for (const frame of iterateSessionFrames(gunzipSync(readFileSync(fixture)))) {
  frames.push(frame);
  if (frames.length === 600) break;
}
const ids: number[] = [];
const directories: string[] = [];

async function recording(gzip = false, bundle = false, bootstrap = false, omitMotionChannels = false) {
  const directory = join(resolveRecordingDirectory(), "f1-2025", "own", `motion-reconcile-test-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  directories.push(directory);
  const raw = join(directory, "historical.bin");
  const recorder = new SessionRecorder();
  const encoder = new SparseCaptureEncoder("f1-2025", omitMotionChannels);
  const game = getServerGame("f1-2025");
  const state = game.createParserState();
  recorder.start(raw);
  recorder.writeMetaFrame();
  if (bootstrap) {
    for (const frame of frames) game.tryParse(frame, state);
    const checkpoint = JSON.parse(Buffer.from(game.captureParserCheckpoint!(state)!).toString());
    expect(checkpoint.motionEx).not.toBeNull();
    checkpoint.motionEx.suspensionVelocityRL = 87;
    recorder.writeRawCaptureBytes(encodeParserBootstrapFrame("f1-2025", Buffer.from(JSON.stringify(checkpoint))));
  }
  const offsets: number[] = [];
  for (let index = 0; index < frames.length; index++) {
    if (index === 300) {
      recorder.writeSegmentBoundary();
      encoder.reset();
    }
    let frame = frames[index]!;
    if (frame[6] === 13) {
      frame = Buffer.concat([frame, Buffer.from([91, 92, 93])]);
      for (const [start, end] of [
        [16, 48],
        [132, 144],
        [156, 168],
      ]) {
        for (let offset = start!; offset < end!; offset += 4) frame.writeFloatLE(42 + index, 29 + offset);
      }
    }
    offsets.push(recorder.getCurrentByteOffset());
    recorder.writeRecord(encoder.encode(frame, recorder.getCurrentByteOffset()), 1_800_000_000_000 + index * 10);
  }
  await recorder.stop();
  const path = gzip ? `${raw}.gz` : raw;
  if (gzip) {
    writeFileSync(path, gzipSync(readFileSync(raw)));
    rmSync(raw);
  }
  const session = await db
    .insert(sessions)
    .values({
      gameId: "f1-2025",
      carId: "1",
      trackId: "1",
      rawFile: path,
      captureFormatVersion: 1,
      lapDetectorVersion: LAP_DETECTOR_ID,
      isFavorite: true,
      downsampledFrequencyHz: 60,
      notes: "Keep session",
    })
    .returning()
    .get();
  ids.push(session.id);
  const lapRows = await db
    .insert(laps)
    .values(
      [0, 300].map((start, index) => ({
        sessionId: session.id,
        lapNumber: index + 1,
        lapTime: 90,
        isValid: true,
        isFavorite: true,
        notes: "Keep lap",
        rawByteOffset: offsets[start]!,
        rawFrameCount: 300,
      })),
    )
    .returning();
  if (bundle) {
    await db.update(sessions).set({ captureLayoutVersion: 1 }).where(eq(sessions.id, session.id));
    const bundles = await prepareDownsampleCaptureBundles(
      { rawFile: path, gameId: "f1-2025", source: null, carId: "1", trackId: "1", captureFormatVersion: 1 },
      [session.id],
      lapRows.map((lap) => ({ lapId: lap.id, rawByteOffset: lap.rawByteOffset!, rawFrameCount: lap.rawFrameCount! })),
    );
    const artifact = bundles[0]!;
    await db.update(sessions).set({ captureManifestFile: artifact.manifestPath }).where(eq(sessions.id, session.id));
    for (const chunk of artifact.manifest.chunks)
      if (chunk.lapId)
        await db
          .update(laps)
          .set({ captureChunkId: chunk.id })
          .where(eq(laps.id, Number(chunk.lapId)));
  }
  const source = { rawFile: path, gameId: "f1-2025" as const, source: null, carId: "1", trackId: "1", captureFormatVersion: 1 };
  const before = await Promise.all(lapRows.map((lap) => parseRawLapFrames(source, lap.rawByteOffset!, lap.rawFrameCount!)));
  return { directory, path, source, session, lapRows, before, bytes: statSync(path).size };
}

async function compact() {
  // Real HTTP entry point, storage/DB integration and real game parser; no mocked migration.
  const server = Bun.serve({ port: 0, fetch: storageRoutes.fetch });
  try {
    const response = await fetch(`${server.url}api/storage/f1-motion-compaction`, { method: "POST" });
    return { status: response.status, body: await response.json() };
  } finally {
    await server.stop(true);
  }
}

afterEach(async () => {
  await disposeRecordingMaintenanceRuntime();
  await client.execute("DROP TRIGGER IF EXISTS f1_compaction_failure");
  if (ids.length) {
    await db.delete(laps).where(inArray(laps.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids.splice(0)));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

for (const gzip of [false, true])
  for (const bundle of [false, true]) {
    test(`HTTP compaction preserves indexed telemetry and metadata (${gzip ? "gzip" : "plain"}, bundle=${bundle})`, async () => {
      const original = await recording(gzip, bundle);
      const result = await compact();
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ convertedFiles: 1, failed: [], warnings: [] });
      expect(result.body.freedBytes).toBeGreaterThan(0);
      const session = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
      expect(session).toMatchObject({ notes: "Keep session", isFavorite: true, downsampledFrequencyHz: 60 });
      expect(existsSync(original.path)).toBe(false);
      const saved = await db.select().from(laps).where(eq(laps.sessionId, session!.id)).orderBy(laps.lapNumber).all();
      for (let index = 0; index < saved.length; index++) {
        const lap = saved[index]!;
        expect(lap).toMatchObject({ id: original.lapRows[index]!.id, notes: "Keep lap", isFavorite: true, lapTime: 90, isValid: true, rawFrameCount: 300 });
        expect(await parseRawLapFrames({ ...original.source, rawFile: session!.rawFile! }, lap.rawByteOffset!, lap.rawFrameCount!)).toEqual(original.before[index]);
      }
      let motionFrames = 0;
      for await (const record of iterateSessionCaptureRecordsFromSource({ ...original.source, rawFile: session!.rawFile! }, { strict: true })) {
        if (record.kind !== "frame" || record.frame[6] !== 13) continue;
        motionFrames++;
        expect(record.frame.subarray(-3)).toEqual(Buffer.from([91, 92, 93]));
        for (const [start, end] of [
          [16, 48],
          [132, 144],
          [156, 168],
        ])
          expect(record.frame.subarray(29 + start!, 29 + end!)).toEqual(Buffer.alloc(end! - start!));
      }
      expect(motionFrames).toBeGreaterThan(0);
      expect((await compact()).body).toMatchObject({ convertedFiles: 0, failed: [], skipped: [{ sessionIds: [session!.id], reason: "already-compact" }] });
      expect(readdirSync(original.directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    });
  }

test("checkpoint-initialized capture compacts historical checkpoint values", async () => {
  const original = await recording(true, false, true);
  expect((await compact()).body).toMatchObject({ convertedFiles: 1, failed: [] });
  const session = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  let checked = false;
  for await (const record of iterateSessionCaptureRecordsFromSource({ ...original.source, rawFile: session!.rawFile! }, { strict: true })) {
    if (record.kind !== "parser-bootstrap") continue;
    expect(JSON.parse(record.payload.toString()).motionEx.suspensionVelocityRL).toBe(0);
    checked = true;
  }
  expect(checked).toBe(true);
});

test("shared sources publish once for every referencing session, including null-index laps", async () => {
  const original = await recording(true);
  const shared = await db
    .insert(sessions)
    .values({ gameId: "f1-2025", carId: "1", trackId: "1", rawFile: original.path, captureFormatVersion: 1, lapDetectorVersion: LAP_DETECTOR_ID, notes: "Shared session" })
    .returning()
    .get();
  ids.push(shared.id);
  const lap = await db.insert(laps).values({ sessionId: shared.id, lapNumber: 1, lapTime: 91, isValid: false, notes: "Unindexed lap" }).returning().get();
  expect((await compact()).body).toMatchObject({ convertedFiles: 1, failed: [] });
  const refs = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.id, [shared.id, original.session.id]))
    .all();
  expect(refs[0]!.rawFile).toBe(refs[1]!.rawFile);
  expect(refs[0]!.rawFile).not.toBe(original.path);
  expect(await db.select().from(laps).where(eq(laps.id, lap.id)).get()).toEqual(lap);
  expect(refs.find((row) => row.id === shared.id)).toMatchObject({ notes: "Shared session", downsampledFrequencyHz: null });
});

test("native-coordinate direct manifests rebuild replay bundles and lap offsets", async () => {
  const original = await recording();
  let virtualOffset = 12;
  let recordCount = 0;
  const offsets = new Map<number, number>();
  for await (const record of iterateSessionCaptureRecordsFromSource(original.source, { strict: true })) {
    offsets.set(record.offset, virtualOffset);
    virtualOffset += record.kind === "frame" ? 12 + record.frame.length : record.endOffset - record.offset;
    recordCount++;
  }
  const manifestPath = join(original.directory, "capture-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 3,
      gameId: "f1-2025",
      sourceRevision: "test-native-coordinate-source",
      sourceCoordinates: "native-wire-v1",
      sourceByteLength: virtualOffset,
      sourceRecordCount: recordCount,
      chunks: [
        {
          id: crypto.randomUUID(),
          kind: "auxiliary",
          path: "historical.bin",
          byteLength: original.bytes,
          firstOrdinal: 0,
          recordCount,
          sourceStart: 0,
          sourceEnd: recordCount,
          sourceByteStart: 12,
          sourceByteEnd: virtualOffset,
          sourceRecordByteOffset: 12,
        },
      ],
    }),
  );
  await db.update(sessions).set({ rawFile: manifestPath, captureManifestFile: manifestPath, captureLayoutVersion: 1 }).where(eq(sessions.id, original.session.id));
  for (const lap of original.lapRows)
    await db
      .update(laps)
      .set({ rawByteOffset: offsets.get(lap.rawByteOffset!)! })
      .where(eq(laps.id, lap.id));
  const result = await compact();
  expect(result.body).toMatchObject({ convertedFiles: 1, failed: [] });
  const saved = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  const savedLaps = await db.select().from(laps).where(eq(laps.sessionId, saved!.id)).orderBy(laps.lapNumber).all();
  for (let index = 0; index < savedLaps.length; index++) {
    const lap = savedLaps[index]!;
    expect(await parseRawLapFrames({ ...original.source, rawFile: saved!.rawFile! }, lap.rawByteOffset!, lap.rawFrameCount!)).toEqual(original.before[index]);
    expect(lap.captureChunkId).not.toBeNull();
  }
  expect(existsSync(manifestPath)).toBe(false);
  expect(existsSync(original.path)).toBe(false);
  expect((await compact()).body).toMatchObject({ convertedFiles: 0, failed: [] });
});

test("shutdown waits for the current publication but does not start the next recording group", async () => {
  const original = await recording();
  const pending = await recording();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const commit = publication.commitSessionCaptureRewrite;
  const paused = spyOn(publication, "commitSessionCaptureRewrite").mockImplementation(async (input) => {
    entered.resolve();
    await release.promise;
    await commit(input);
  });
  const running = compact();
  try {
    await entered.promise;
    expect((await compact()).status).toBe(409);
    let stopped = false;
    const stopping = disposeRecordingMaintenanceRuntime().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(existsSync(original.path)).toBe(true);
    release.resolve();
    await stopping;
    await running;
    expect(stopped).toBe(true);
    const saved = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
    expect(saved!.rawFile).not.toBe(original.path);
    expect(existsSync(saved!.rawFile!)).toBe(true);
    expect(existsSync(original.path)).toBe(false);
    const untouched = await db.select().from(sessions).where(eq(sessions.id, pending.session.id)).get();
    expect(untouched!.rawFile).toBe(pending.path);
    expect(untouched!.f1MotionCompactedSource).toBeNull();
    expect(existsSync(pending.path)).toBe(true);
  } finally {
    release.resolve();
    await running;
    paused.mockRestore();
  }
});

test("retry removes only operation temporaries; unsupported shared sources remain untouched", async () => {
  const original = await recording();
  const temporary = join(original.directory, `f1-2025.motion-compact-${crypto.randomUUID()}.bin.raw.tmp`);
  const unrelated = join(original.directory, "other-operation.tmp");
  writeFileSync(temporary, "interrupted");
  writeFileSync(unrelated, "user-owned");
  expect((await compact()).body).toMatchObject({ convertedFiles: 1, failed: [] });
  expect(existsSync(temporary)).toBe(false);
  expect(readFileSync(unrelated, "utf8")).toBe("user-owned");

  const mixed = await recording();
  const other = await db.insert(sessions).values({ gameId: "acc", carId: "1", trackId: "1", rawFile: mixed.path }).returning().get();
  ids.push(other.id);
  const bytes = readFileSync(mixed.path);
  const result = await compact();
  expect(result.body.skipped).toContainEqual({ sessionIds: [mixed.session.id, other.id], reason: "unsupported-or-unowned" });
  expect(readFileSync(mixed.path)).toEqual(bytes);
});

test("publication failure preserves original paths, bytes and lap indexes; retry succeeds", async () => {
  const original = await recording();
  const bytes = readFileSync(original.path);
  await client.execute("CREATE TRIGGER f1_compaction_failure BEFORE UPDATE OF raw_file ON sessions BEGIN SELECT RAISE(ABORT, 'injected compaction publication failure'); END");
  const result = await compact();
  expect(result.body.convertedFiles).toBe(0);
  expect(result.body.failed).toHaveLength(1);
  expect(readFileSync(original.path)).toEqual(bytes);
  expect((await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get())!.rawFile).toBe(original.path);
  expect(await db.select().from(laps).where(eq(laps.sessionId, original.session.id)).all()).toEqual(original.lapRows);
  expect(readdirSync(original.directory)).toEqual(["historical.bin"]);
  await client.execute("DROP TRIGGER f1_compaction_failure");
  expect((await compact()).body).toMatchObject({ convertedFiles: 1, failed: [] });
});

test("corrupt input remains untouched and reports failure", async () => {
  const original = await recording();
  const corrupt = readFileSync(original.path).subarray(0, -1);
  writeFileSync(original.path, corrupt);
  const result = await compact();
  expect(result.body.convertedFiles).toBe(0);
  expect(result.body.failed).toHaveLength(1);
  expect(readFileSync(original.path)).toEqual(corrupt);
  expect(readdirSync(original.directory)).toEqual(["historical.bin"]);
});

test("quiescent storage is required, but no confirmation body is needed", async () => {
  const active = spyOn(livePipeline, "isSessionActive").mockReturnValue(true);
  try {
    expect((await compact()).status).toBe(409);
  } finally {
    active.mockRestore();
  }
  const release = beginRecordingStorageImport();
  try {
    expect((await compact()).status).toBe(409);
  } finally {
    release();
  }
  expect((await compact()).status).toBe(200);
});

test("startup maintenance reconciles historical recordings automatically without a request or opt-in", async () => {
  const original = await recording(true, true);
  const completed = Promise.withResolvers<f1Reconciliation.F1MotionReconcileResult>();
  const scheduled = f1Reconciliation.runScheduledF1MotionReconcileEffect;
  const observed = spyOn(f1Reconciliation, "runScheduledF1MotionReconcileEffect").mockImplementation(() =>
    scheduled().pipe(
      Effect.tap((result) => Effect.sync(() => completed.resolve(result))),
      Effect.tapError((error) => Effect.sync(() => completed.reject(error))),
    ),
  );
  try {
    startSessionCompressor();
    expect(await completed.promise).toMatchObject({ convertedFiles: 1, failed: [] });
    await stopSessionCompressor();
    const saved = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
    expect(saved!.f1MotionCompactedSource).toBe(saved!.rawFile);
    expect(existsSync(original.path)).toBe(false);
    const savedLaps = await db.select().from(laps).where(eq(laps.sessionId, saved!.id)).orderBy(laps.lapNumber).all();
    for (let index = 0; index < savedLaps.length; index++) {
      const lap = savedLaps[index]!;
      expect(await parseRawLapFrames({ ...original.source, rawFile: saved!.rawFile! }, lap.rawByteOffset!, lap.rawFrameCount!)).toEqual(original.before[index]);
    }
  } finally {
    await stopSessionCompressor();
    observed.mockRestore();
  }
});

test("completion markers survive runtime restart, skip rescanning, and invalidate when the source path changes", async () => {
  const original = await recording();
  const native = readFileSync(original.path);
  await runSessionCaptureMaintenanceNow();
  const first = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(first!.f1MotionCompactedSource).toBe(first!.rawFile);
  expect(first!.rawFile).not.toBe(original.path);
  await disposeRecordingMaintenanceRuntime();
  const open = fs.openSync;
  const noRewrite = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes(".motion-compact-") && String(args[0]).endsWith(".tmp")) throw new Error("Completed source was rescanned");
    return open(...args);
  });
  try {
    await runSessionCaptureMaintenanceNow();
    expect((await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get())!.rawFile).toBe(first!.rawFile);
  } finally {
    noRewrite.mockRestore();
  }
  const replacement = join(original.directory, "another-native-source.bin");
  writeFileSync(replacement, native);
  await db.update(sessions).set({ rawFile: replacement }).where(eq(sessions.id, original.session.id));
  for (const lap of original.lapRows) await db.update(laps).set({ rawByteOffset: lap.rawByteOffset }).where(eq(laps.id, lap.id));
  await runSessionCaptureMaintenanceNow();
  const next = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(next!.rawFile).not.toBe(first!.rawFile);
  expect(next!.rawFile).not.toBe(replacement);
  expect(next!.f1MotionCompactedSource).toBe(next!.rawFile);
  expect(existsSync(replacement)).toBe(false);
});

test("automatic publication failure remains pending and is retried on the next maintenance pass", async () => {
  const original = await recording();
  const bytes = readFileSync(original.path);
  await client.execute("CREATE TRIGGER f1_compaction_failure BEFORE UPDATE OF raw_file ON sessions BEGIN SELECT RAISE(ABORT, 'injected automatic compaction failure'); END");
  await expect(runSessionCaptureMaintenanceNow()).rejects.toThrow("Failed to reconcile 1 recording group(s)");
  expect(readFileSync(original.path)).toEqual(bytes);
  const pending = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(pending!.f1MotionCompactedSource).toBeNull();
  await client.execute("DROP TRIGGER f1_compaction_failure");
  await runSessionCaptureMaintenanceNow();
  const saved = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(saved!.f1MotionCompactedSource).toBe(saved!.rawFile);
  expect(existsSync(original.path)).toBe(false);
});

test("already-reduced recordings reconcile without spare staging space or source replacement", async () => {
  const original = await recording(false, false, false, true);
  const bytes = readFileSync(original.path);
  const open = fs.openSync;
  const noSpace = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes(".motion-compact-") && String(args[0]).endsWith(".tmp")) {
      throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    }
    return open(...args);
  });
  try {
    await runSessionCaptureMaintenanceNow();
  } finally {
    noSpace.mockRestore();
  }
  const saved = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(saved!.rawFile).toBe(original.path);
  expect(saved!.f1MotionCompactedSource).toBe(original.path);
  expect(readFileSync(original.path)).toEqual(bytes);
  expect(readdirSync(original.directory)).toEqual(["historical.bin"]);
});

test("automatic compaction waits for startup lap reconciliation before replacing the source", async () => {
  const original = await recording();
  const bytes = readFileSync(original.path);
  await db.update(sessions).set({ lapDetectorVersion: null }).where(eq(sessions.id, original.session.id));
  await runSessionCaptureMaintenanceNow();
  const pending = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(pending!.rawFile).toBe(original.path);
  expect(pending!.f1MotionCompactedSource).toBeNull();
  expect(readFileSync(original.path)).toEqual(bytes);
  await db.update(sessions).set({ lapDetectorVersion: LAP_DETECTOR_ID }).where(eq(sessions.id, original.session.id));
  await runSessionCaptureMaintenanceNow();
  const saved = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(saved!.f1MotionCompactedSource).toBe(saved!.rawFile);
  expect(existsSync(original.path)).toBe(false);
});

for (const invalid of ["unknown magic", "unsupported version"] as const) {
  test(`unsupported capture metadata preserves original bytes and path (${invalid})`, async () => {
    const original = await recording();
    const marker = encodeSegmentBoundaryFrame();
    if (invalid === "unknown magic") marker.writeUInt32LE(0x12345678, 8);
    else marker.writeUInt32LE(2, 12);
    const bytes = Buffer.concat([readFileSync(original.path), marker]);
    writeFileSync(original.path, bytes);
    const result = await compact();
    expect(result.body).toMatchObject({ convertedFiles: 0 });
    expect(result.body.failed).toHaveLength(1);
    expect(result.body.failed[0].error).toContain("Unknown capture segment marker");
    expect((await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get())!.rawFile).toBe(original.path);
    expect(readFileSync(original.path)).toEqual(bytes);
    expect(readdirSync(original.directory)).toEqual(["historical.bin"]);
  });
}

test("compaction atomically rebases pending split work without requiring split consent", async () => {
  const original = await recording();
  expect(await enqueueSessionCaptureSplit(original.session.id)).toBe(true);
  const previous = (await getQueuedSessionCaptureSplitJobs()).find((work) => work.sessionId === original.session.id)!;
  expect((await compact()).body).toMatchObject({ convertedFiles: 1, failed: [] });
  const saved = await db.select().from(sessions).where(eq(sessions.id, original.session.id)).get();
  expect(saved!.captureLayoutVersion).toBeNull();
  const work = (await getQueuedSessionCaptureSplitJobs()).find((item) => item.sessionId === original.session.id)!;
  expect(work.sourcePath).toBe(saved!.rawFile!);
  expect(await validateSessionCaptureSplitRevision(work)).toBe(true);
  expect(await claimSessionCaptureSplitJob(previous)).toBe(false);
  expect(await claimSessionCaptureSplitJob(work)).toBe(true);
  expect((await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, original.session.id)).get())!.status).toBe("splitting");
  expect(existsSync(original.path)).toBe(false);
});
