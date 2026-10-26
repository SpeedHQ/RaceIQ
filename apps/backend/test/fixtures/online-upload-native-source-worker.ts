import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { fixtureFrames } from "../benchmarks/live-lossless-release.bench";
import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
import { claimLocalAccountOwner, getLocalGameBindingSnapshot, upsertLocalGameBinding } from "@raceiq/backend-core/db/local-account-queries";
import { initDb, client, closeDb, db } from "@raceiq/backend-core/db/index";
import { laps as lapRows, sessions as sessionRows } from "@raceiq/backend-core/db/schema";
import { eq } from "drizzle-orm";
import { buildPortableCaptureIdentity, importPortableCapture, loadFullOriginalPortableCapture } from "@raceiq/backend-core/session-capture/portable-identity";
import { closeDashboardReadDatabase } from "@raceiq/backend-core/db/dashboard-queries";
import { encodeNativeDriverBinding } from "@raceiq/backend-core/lap-detection/native-attribution";
import type { NativeDriverActor } from "@raceiq/shared/driver-attribution";
import { closeBindingStorage } from "@raceiq/online/server/binding-storage";

const root = resolve(import.meta.dir, "../../../..");
const requested = resolve(process.env.DATA_DIR!);

assert.ok(process.env.RACEIQ_NATIVE_SOURCE_LAUNCH_TOKEN, "Run through online-upload-native-source.ts launcher");
const owner = "a2345678-1234-5678-9abc-def012345678";
const sources = [
  { gameId: "f1-2025" as const, path: join(root, "test/artifacts/sessions", "f1-2025-2026-04-22T11-42-43-029Z.bin.gz") },
  { gameId: "lmu" as const, path: join(root, "test/artifacts/laps", "lmu-2026-09-19T20-09-44-686Z.bin.gz") },
];
let recorder: DirectSessionRecorderAdapter | undefined;
let pipeline: LiveTelemetryPipeline | undefined;
try {
  initGameAdapters(); initServerGameAdapters();
  await initDb();
  await claimLocalAccountOwner(owner);
  recorder = new DirectSessionRecorderAdapter("mine");
  pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } }), new NullWsAdapter(), {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
  });
  let captureSources = false;
  const unsubscribe = subscribeParserSource(input => { if (captureSources) pipeline!.captureParserSource(input); });
  const summaries: { gameId: string; frames: number; sessions: number; validSelfLaps: number; candidates: number; boards: number; originalGuids: unknown[] }[] = [];
  try {
    for (const source of sources) {
      resetParserState(source.gameId);
      const frames = fixtureFrames(await readFile(source.path), source.gameId);
      let actor: NativeDriverActor | undefined;
      for (const input of frames) {
        const packet = parsePacket(Buffer.from(input.bytes), input.timestampMs ?? Date.now());
        if (!actor && packet?.driverActor?.gameId === source.gameId) actor = packet.driverActor;
      }
      assert.ok(actor, `Committed ${source.gameId} fixture yielded no native actor descriptor`);
      const prior = (await getLocalGameBindingSnapshot()).bindings.find(binding => binding.gameId === source.gameId);
      await upsertLocalGameBinding({ id: prior?.id ?? crypto.randomUUID(), gameId: source.gameId, sourceKind: actor.source,
        nativeIdentity: encodeNativeDriverBinding(actor), confirmation: "user_confirmed", revision: (prior?.revision ?? 0) + 1 });
      resetParserState(source.gameId);
      captureSources = true;
      let count = 0;
      for (const input of frames) {
        while ((recorder.capture?.queuedBytes ?? 0) > 512 * 1024) {
          if (recorder.capture?.hasFailed) throw recorder.capture.error;
          await Bun.sleep(1);
        }
        const bytes = Buffer.from(input.bytes), timestamp = input.timestampMs ?? Date.now(), packet = parsePacket(bytes, timestamp);
        if (packet) await pipeline.processPacket(packet, bytes, timestamp);
        count++;
        if ((count & 127) === 0) await new Promise(resolve => setImmediate(resolve));
      }
      captureSources = false;
      await pipeline.finalizeCurrentSession(true);
      await recorder.stop(true);
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      const closedSources = await client.execute({ sql: `SELECT s.id,s.car_id,s.track_id,s.raw_file,s.capture_manifest_file,s.original_activity_id,s.original_source_revision,
          n.original_activity_id AS closed_activity_id,n.source_revision AS closed_source_revision,
          n.lap_count AS closed_lap_count,n.gap_count AS closed_gap_count,COUNT(DISTINCT l.id) AS lap_count
        FROM sessions s JOIN laps l ON l.session_id=s.id
        JOIN native_original_source_closures n ON n.session_id=s.id
        WHERE s.native_capture_origin=1 AND s.game_id=? GROUP BY s.id`, args: [source.gameId] });
      assert.ok(closedSources.rows.length > 0, `${source.gameId} fixture produced no nonempty published recording source`);
      for (const published of closedSources.rows) {
        assert.equal(published.closed_activity_id, published.original_activity_id);
        assert.equal(published.closed_source_revision, published.original_source_revision);
        assert.equal(Number(published.closed_lap_count), Number(published.lap_count));
        assert.equal(Number(published.closed_gap_count), 0, `${source.gameId} source closure must have no gaps`);
        assert.ok(typeof published.raw_file === "string" && (await stat(published.raw_file)).isFile(),
          `${source.gameId} closed original recording must exist`);
        assert.ok(typeof published.capture_manifest_file === "string" && (await stat(published.capture_manifest_file)).isFile(),
          `${source.gameId} closed capture manifest must exist`);
      }
      if (process.env.RACEIQ_E2E_PORTABLE_FINISH_CHECK === "1" && source.gameId === "f1-2025") {
        const nativeSession = await db.select({ id: sessionRows.id, originalActivityId: sessionRows.originalActivityId,
          ownerUserId: sessionRows.ownerUserId, gameId: sessionRows.gameId, carId: sessionRows.carId, trackId: sessionRows.trackId })
          .from(sessionRows).innerJoin(lapRows, eq(lapRows.sessionId, sessionRows.id))
          .where(eq(sessionRows.gameId, source.gameId)).groupBy(sessionRows.id).get();
        assert.ok(nativeSession?.originalActivityId && nativeSession.ownerUserId);
        const nativeLaps = await db.select({ id: lapRows.id, lapGuid: lapRows.lapGuid, rawByteOffset: lapRows.rawByteOffset, rawFrameCount: lapRows.rawFrameCount })
          .from(lapRows).where(eq(lapRows.sessionId, nativeSession.id)).orderBy(lapRows.lapNumber).all();
        assert.ok(nativeLaps.length > 0 && nativeLaps.every(row => row.rawByteOffset !== null && row.rawFrameCount !== null));
        const knownFinish = "2026-04-22T12:00:00.000Z";
        await db.update(lapRows).set({ sourceFinishedAt: knownFinish }).where(eq(lapRows.id, nativeLaps[0]!.id)).run();
        const full = await loadFullOriginalPortableCapture(nativeSession.id);
        assert.ok(full, "Fixture source must be exportable as verified original");
        const identity = await buildPortableCaptureIdentity(nativeSession.id, full.bytes,
          nativeLaps.map(row => ({ lapId: row.id, ...full.windows.get(row.id)! })));
        assert.ok(identity.originalSource, "Export must retain verified original proof");
        assert.equal(identity.laps[0]!.finishedAt, knownFinish);
        const finishUnknown = structuredClone(identity);
        finishUnknown.laps[0]!.finishedAt = null;
        const imported = await importPortableCapture(full.bytes, finishUnknown, { gameId: nativeSession.gameId as "f1-2025", carId: nativeSession.carId, trackId: nativeSession.trackId });
        imported.releaseSourceMutations();
        assert.equal((await db.select({ sourceFinishedAt: lapRows.sourceFinishedAt }).from(lapRows).where(eq(lapRows.id, nativeLaps[0]!.id)).get())?.sourceFinishedAt, knownFinish,
          "Unknown portable metadata must not erase known source finish");
        const conflict = structuredClone(identity);
        conflict.laps[0]!.finishedAt = "2026-04-22T12:00:01.000Z";
        await assert.rejects(importPortableCapture(full.bytes, conflict,
          { gameId: nativeSession.gameId as "f1-2025", carId: nativeSession.carId, trackId: nativeSession.trackId }),
        /Portable original finish time conflicts with retained source timing/);
        assert.equal((await db.select({ sourceFinishedAt: lapRows.sourceFinishedAt }).from(lapRows).where(eq(lapRows.id, nativeLaps[0]!.id)).get())?.sourceFinishedAt, knownFinish,
          "Conflicting portable finish must not mutate retained source timing");
      }
      const sessions = await client.execute({ sql: "SELECT id,original_activity_id AS guid FROM sessions WHERE native_capture_origin=1 AND game_id=?", args: [source.gameId] });
      const laps = await client.execute({ sql: "SELECT l.lap_guid AS guid,l.is_valid AS valid,l.driver_attribution AS attribution,s.track_id AS track,s.car_id AS car FROM laps l JOIN sessions s ON s.id=l.session_id WHERE s.native_capture_origin=1 AND s.game_id=?", args: [source.gameId] });
      const eligible = laps.rows.filter(lap => lap.valid === 1 && lap.attribution === "Self" && typeof lap.guid === "string" && lap.track && lap.car);
      const candidates = await client.execute({ sql: "SELECT w.lap_id AS id FROM online_fastest_combo_laps w JOIN laps l ON l.id=w.lap_id JOIN sessions s ON s.id=l.session_id WHERE s.native_capture_origin=1 AND s.game_id=?", args: [source.gameId] });
      summaries.push({ gameId: source.gameId, frames: count, sessions: sessions.rows.length, validSelfLaps: eligible.length,
        candidates: candidates.rows.length, boards: new Set(eligible.map(lap => JSON.stringify([lap.track, lap.car]))).size,
        originalGuids: sessions.rows.map(row => row.guid) });
    }
    assert.ok(summaries[0]!.candidates > 0, "F1 fixture produced no current fastest-combo winner");
    assert.ok(summaries[1]!.candidates > 0 && summaries[1]!.boards > 0,
      "LMU committed native fixture did not yield an eligible current winner; see per-source summary");
    console.log(JSON.stringify({ dataDir: requested, sources: summaries }));
  } finally { unsubscribe(); }
} finally {
  await pipeline?.finalizeCurrentSession().catch(() => {});
  await recorder?.stop(true).catch(() => {});
  closeDashboardReadDatabase(); closeBindingStorage();
  await closeDb(); stopMaintenanceTasks();
}
