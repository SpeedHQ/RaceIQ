import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions, laps } from "@raceiq/backend-core/db/schema";
import { RealDbAdapter, NullWsAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { getLapsByIds } from "@raceiq/backend-core/db/lap-read-queries";
import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { initServerGameAdapters } from "../../src/games/init";
import { buildLapsZip, importLapsZip } from "../../src/laps/archive";
import { fixtureFrames } from "../benchmarks/live-lossless-release.bench";
import type { GameId } from "@raceiq/shared/games/ids";

class SourceDigest {
  readonly hash = createHash("sha256");
  private readonly prefix = Buffer.alloc(13);
  count = 0;
  add(frame: Uint8Array, timestamp?: number) {
    this.prefix.writeUInt32LE(frame.byteLength, 0);
    this.prefix[4] = timestamp === undefined ? 0 : 1;
    this.prefix.writeDoubleLE(timestamp ?? 0, 5);
    this.hash.update(this.prefix).update(frame); this.count++;
  }
  value() { return this.hash.copy().digest("hex"); }
}
class HeldTuneDb extends RealDbAdapter {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  private hold = true;
  override async getTuneAssignment(...args: Parameters<RealDbAdapter["getTuneAssignment"]>) {
    if (this.hold) { this.hold = false; this.entered.resolve(); await this.release.promise; }
    return super.getTuneAssignment(...args);
  }
}
class ObservedDirectRecorder extends DirectSessionRecorderAdapter {
  readonly accepted = new Map<string, SourceDigest>();
  override start(gameId: GameId) { super.start(gameId); this.accepted.set(this.path!, new SourceDigest()); }
  override writeRecord(frame: Buffer, timestamp?: number) { super.writeRecord(frame, timestamp); this.accepted.get(this.path!)!.add(frame, timestamp); }
  override writeRawCaptureBytes(bytes: Buffer) {
    super.writeRawCaptureBytes(bytes);
    for (const record of iterateSessionCaptureRecords(bytes, 0, { strict: true })) if (record.kind === "frame") this.accepted.get(this.path!)!.add(record.frame, record.frameTimeMs);
  }
}

test("direct recording retains queued native input across a delayed lap binding and exports without a monolith", async () => {
  initServerGameAdapters(); resetParserState("fm-2023");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/fm-2023-with-pitting.bin.gz")), "fm-2023");
  const adapter = new HeldTuneDb({ notifyDriverProfile: false });
  const finalSyncStarted = Promise.withResolvers<void>();
  const releaseFinalSync = Promise.withResolvers<void>();
  let holdFinalSync = false;
  const recorder = new ObservedDirectRecorder("others", { writerOptions: {
    onDurable: async () => {
      if (holdFinalSync) { finalSyncStarted.resolve(); await releaseFinalSync.promise; }
    },
  } });
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter { override broadcastNotification(event: Record<string, unknown>) { if (event.type === "recording-failed") failures.push(event.error); } }();
  const pipeline = new LiveTelemetryPipeline(adapter, ws, { recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true });
  const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
  let held = false;
  const submit = (index: number) => {
    const input = frames[index]!;
    const bytes = Buffer.from(input.bytes), packet = parsePacket(bytes, input.timestampMs);
    return packet ? pipeline.processPacket(packet, bytes, input.timestampMs) : Promise.resolve();
  };
  try {
    for (let index = 0; index < frames.length; index++) {
      const processing = submit(index);
      if (!held && await Promise.race([processing.then(() => false), adapter.entered.promise.then(() => true)])) {
        held = true;
        const pending: Promise<void>[] = [];
        // Future input arrives while the previous lap is still awaiting its DB lookup.
        for (let ahead = 0; ahead < 3 && index + 1 < frames.length; ahead++) pending.push(submit(++index));
        adapter.release.resolve();
        await processing; await Promise.all(pending);
      } else await processing;
      // Let real filesystem completions run during otherwise unpaced fixture replay.
      if ((index & 127) === 127) await nextTurn();
    }
    adapter.release.resolve();
    holdFinalSync = true;
    const finalizing = pipeline.finalizeCurrentSession();
    await finalSyncStarted.promise;
    expect(pipeline.isSessionActive).toBe(true);
    releaseFinalSync.resolve();
    await finalizing; unsubscribe();
    expect(pipeline.isSessionActive).toBe(false);
    expect(held).toBe(true); expect(failures).toEqual([]);
    const rows = await db.select().from(sessions).where(inArray(sessions.rawFile, [...recorder.accepted.keys()])).all();
    const storedLaps = await db.select().from(laps).where(inArray(laps.sessionId, rows.map(row => row.id))).all();
    for (const row of rows) {
      const actual = new SourceDigest();
      for await (const record of iterateSessionCaptureRecordsFromSource({ ...row, rawFile: row.rawFile!, gameId: "fm-2023" }, { strict: true })) if (record.kind === "frame") actual.add(record.frame, record.frameTimeMs);
      const expected = recorder.accepted.get(row.rawFile!)!;
      expect(actual.count).toBe(expected.count); expect(actual.value()).toBe(expected.value());
      expect(row.captureLayoutVersion).toBe(1); expect(row.rawFile).toBe(row.captureManifestFile);
    }
    const replayed = await getLapsByIds(storedLaps.map(lap => lap.id));
    expect(replayed.map(lap => [lap.id, lap.lapTime, lap.isValid, lap.parseError])).toEqual(storedLaps.map(lap => [lap.id, lap.lapTime, lap.isValid, undefined]));
    const selected = storedLaps.slice(0, 2);
    if (selected.length !== 2) throw new Error("Fixture did not produce two completed laps");
    const exported = await buildLapsZip(selected.map(lap => lap.id));
    const imported = await importLapsZip(exported.bytes, { ownership: "others" });
    expect(imported.errors).toEqual([]);
    expect(imported.laps.map(lap => lap.lapTime)).toEqual(selected.map(lap => lap.lapTime));
  } finally {
    adapter.release.resolve(); unsubscribe();
    releaseFinalSync.resolve();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);
