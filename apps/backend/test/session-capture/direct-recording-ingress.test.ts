import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions, laps } from "@raceiq/backend-core/db/schema";
import { RealDbAdapter, NullWsAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { getLapsByIds } from "@raceiq/backend-core/db/lap-read-queries";
import { readOriginalActivitySourceProof } from "@raceiq/backend-core/db/original-activity-queries";
import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { iterateSessionCaptureRecords, META_FRAME_BYTES } from "@raceiq/capture-formats/session/framing";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame, IRacingSourceFrameEncoder, type IRacingValue } from "@raceiq/capture-formats/iracing/source-frame";
import { decodeLMUSourceFrame, encodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import {
  LMU_GAME_VERSION_OFFSET, LMU_SCORING_INFO_OFFSET, LMU_SCORING_VEHICLES_OFFSET,
  LMU_SESSION_EVENT_OFFSET, LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY,
  LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET,
} from "@raceiq/capture-formats/lmu/layout";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { initServerGameAdapters } from "../../src/games/init";
import { buildLapsZip, importLapsZip } from "../../src/laps/archive";
import { fixtureFrames } from "../benchmarks/live-lossless-release.bench";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { applyFrameTime } from "@raceiq/backend-core/session-capture/frame-time";
import type { GameId } from "@raceiq/shared/games/ids";

registerDriverProfileLapNotifier(() => {});
function telemetrySampleKey(packet: Pick<TelemetryPacket, "gameId" | "LapNumber" | "CurrentLap" | "LastLap" | "DistanceTraveled" | "Speed" | "TimestampMS">): string {
  return JSON.stringify([packet.gameId, packet.LapNumber, packet.CurrentLap, packet.LastLap, packet.DistanceTraveled, packet.Speed, packet.TimestampMS]);
}

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
  const adapter = new HeldTuneDb({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } });
  const finalSyncStarted = Promise.withResolvers<void>();
  const releaseFinalSync = Promise.withResolvers<void>();
  let holdFinalSync = false;
  const recorder = new ObservedDirectRecorder("mine", { writerOptions: {
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
    const retainedSessions = await db.select().from(sessions).where(inArray(sessions.id, rows.map(row => row.id))).all();
    expect(new Map(retainedSessions.map(row => [row.id, [row.ownership, row.ownerUserId]]))).toEqual(new Map(rows.map(row => [row.id, [row.ownership, row.ownerUserId]])));
    const retainedLaps = await db.select().from(laps).where(inArray(laps.id, selected.map(lap => lap.id))).all();
    expect(new Map(retainedLaps.map(lap => [lap.id, lap.lapGuid]))).toEqual(new Map(selected.map(lap => [lap.id, lap.lapGuid])));
  } finally {
    adapter.release.resolve(); unsubscribe();
    releaseFinalSync.resolve();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);

test.each(["uninterrupted", "overloaded"] as const)("native original completion during final recorder durability stays truthful when %s", async (mode) => {
  initServerGameAdapters(); resetParserState("lmu");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz")), "lmu");
  const durableEntered = Promise.withResolvers<void>(), releaseDurable = Promise.withResolvers<void>();
  let attributionClosed = false, held = false;
  const adapter = new class extends RealDbAdapter {
    override setOriginalActivitySourceRevision(...args: Parameters<RealDbAdapter["setOriginalActivitySourceRevision"]>) {
      super.setOriginalActivitySourceRevision(...args);
      attributionClosed = true;
    }
  }({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } });
  const recorder = new ObservedDirectRecorder("mine", { writerOptions: {
    onDurable: async () => {
      if (attributionClosed && !held) { held = true; durableEntered.resolve(); await releaseDurable.promise; }
    },
  } });
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter { override broadcastNotification(event: Record<string, unknown>) { if (event.type === "recording-failed") failures.push(event.error); } }();
  const pipeline = new LiveTelemetryPipeline(adapter, ws, { recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true });
  const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
  let finalization: Promise<PromiseSettledResult<void>[]> | null = null;
  const replay = async () => {
    let last: TelemetryPacket | null = null;
    for (const input of frames) {
      const bytes = Buffer.from(input.bytes), packet = parsePacket(bytes, input.timestampMs);
      if (packet) { last = packet; await pipeline.processPacket(packet, bytes, input.timestampMs); }
      while ((recorder.capture?.queuedBytes ?? 0) > 512 * 1024) {
        if (recorder.capture?.hasFailed) throw recorder.capture.error;
        await nextTurn();
      }
      if (recorder.capture?.hasFailed) throw recorder.capture.error;
    }
    if (!last) throw new Error("Genuine LMU fixture must produce native telemetry");
    return last;
  };
  try {
    const lastPacket = await replay();
    finalization = Promise.allSettled([pipeline.finalizeCurrentSession()]);
    await durableEntered.promise;
    const affected = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    expect(affected).toHaveLength(1);
    const session = affected[0]!;
    const committed = await db.select({ id: laps.id, guid: laps.lapGuid, time: laps.lapTime }).from(laps).where(eq(laps.sessionId, session.id)).all();
    expect(await readOriginalActivitySourceProof(session.id)).toBeNull();
    const waiting = mode === "overloaded"
      ? Promise.allSettled(Array.from({ length: 640 }, () => pipeline.processPacket(lastPacket)))
      : Promise.resolve([]);
    releaseDurable.resolve();
    await finalization;
    const admitted = await waiting;
    expect(admitted.every(result => result.status === "fulfilled")).toBe(true);
    expect(pipeline.isSessionActive).toBe(false);
    expect(await db.select({ id: laps.id, guid: laps.lapGuid, time: laps.lapTime }).from(laps).where(eq(laps.sessionId, session.id)).all()).toEqual(committed);
    const retained = (await db.select().from(sessions).where(eq(sessions.id, session.id)).all())[0]!;
    expect([retained.ownerUserId, retained.ownership]).toEqual([session.ownerUserId, session.ownership]);
    const proof = await readOriginalActivitySourceProof(session.id);
    const manifest = JSON.parse(await readFile(session.rawFile!, "utf8")) as { sourceClosed: boolean };
    if (mode === "uninterrupted") {
      expect(proof).not.toBeNull(); expect(manifest.sourceClosed).toBe(true); expect(failures).toEqual([]);
    } else {
      expect(proof).toBeNull(); expect(manifest.sourceClosed).toBe(false);
      expect(failures).toEqual(["Recording detector queue capacity exhausted"]);
      await replay(); await pipeline.finalizeCurrentSession();
      const recovered = (await db.select().from(sessions).all()).filter(row => !before.has(row.id) && row.id !== session.id);
      expect(recovered).toHaveLength(1);
      expect(await readOriginalActivitySourceProof(recovered[0]!.id)).not.toBeNull();
    }
  } finally {
    releaseDurable.resolve(); await finalization; unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);

test("direct LMU capture backpressures rapid context generations and replays every retired context", async () => {
  initServerGameAdapters(); resetParserState("lmu");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz")), "lmu");
  if (frames.length < 12) throw new Error(`LMU fixture yielded ${frames.length} frames; expected at least 12`);
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let durableCalls = 0;
  const recorder = new ObservedDirectRecorder("mine", { writerOptions: {
    onDurable: async () => {
      const index = durableCalls++;
      if (index < 2) { entered[index]!.resolve(); await release[index]!.promise; }
    },
  } });
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter {
    override broadcastNotification(event: Record<string, unknown>) {
      if (event.type === "recording-failed") failures.push(event.error);
    }
  }();
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } }), ws, {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
  });
  const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
  let sequence = 0;
  const submitGeneration = async (generation: number, start: number, count: number) => {
    for (let index = start; index < start + count; index++) {
      const original = decodeLMUSourceFrame(Buffer.from(frames[index]!.bytes));
      if (!original) throw new Error(`Failed to decode LMU fixture frame ${index}`);
      const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
      if (original.rawSharedMemory) original.rawSharedMemory.copy(memory);
      else {
        memory.writeInt32LE(original.gameVersion, LMU_GAME_VERSION_OFFSET);
        memory.writeUInt32LE(original.sessionEvent, LMU_SESSION_EVENT_OFFSET);
        memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
        memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
        original.telemetry.copy(memory, LMU_TELEMETRY_INFO_OFFSET);
        original.scoringInfo.copy(memory, LMU_SCORING_INFO_OFFSET);
        original.playerScoring?.copy(memory, LMU_SCORING_VEHICLES_OFFSET);
      }
      const rawFrame = encodeLMUSourceFrame(memory, original.captureTimestampMs, {
        context: {
          schemaVersion: 1,
          key: {
            sessionKey: `recording-generation-${generation}`,
            captureSequence: (++sequence).toString(),
            frameTime: { domain: "session", milliseconds: original.captureTimestampMs },
          },
          playerVehicleId: original.telemetry.readInt32LE(LMU_TELEMETRY.id),
          status: "active",
          supplemental: [],
        },
      });
      if (!rawFrame) throw new Error(`Failed to encode LMU generation ${generation}`);
      const packet = parsePacket(rawFrame, original.captureTimestampMs);
      if (!packet) throw new Error(`Failed to parse LMU generation ${generation}`);
      await pipeline.processPacket(packet, rawFrame, original.captureTimestampMs);
    }
  };
  try {
    await submitGeneration(0, 0, 3);
    await submitGeneration(1, 3, 3);
    await entered[0]!.promise;
    await submitGeneration(2, 6, 3);
    await entered[1]!.promise;
    let fourthSettled = false;
    const fourthStart = submitGeneration(3, 9, 1).finally(() => { fourthSettled = true; });
    await nextTurn();
    expect(fourthSettled).toBe(false);
    release[0]!.resolve(); release[1]!.resolve();
    await fourthStart;
    await submitGeneration(3, 10, 2);
    await pipeline.finalizeCurrentSession();
    unsubscribe();

    expect(failures).toEqual([]);
    const rows = await db.select().from(sessions).where(inArray(sessions.rawFile, [...recorder.accepted.keys()])).all();
    const generationKeys = new Set<string>();
    for (const row of rows) {
      for await (const record of iterateSessionCaptureRecordsFromSource(
        { ...row, rawFile: row.rawFile!, gameId: "lmu" }, { strict: true },
      )) {
        if (record.kind !== "frame") continue;
        const frame = decodeLMUSourceFrame(record.frame);
        if (frame?.lmuContext) {
          expect(frame.schemaVersion).toBe(3);
          generationKeys.add(frame.lmuContext.key.sessionKey);
        }
      }
    }
    expect(generationKeys).toEqual(new Set([0, 1, 2, 3].map(index => `recording-generation-${index}`)));
  } finally {
    unsubscribe();
    release[0]!.resolve(); release[1]!.resolve();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);

test("direct iRacing pipeline promotes only confirmed lap changes and conserves native source", async () => {
  initServerGameAdapters(); resetParserState("iracing");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/iracing-road-america-gt3.bin.gz")), "iracing");
  const recorder = new ObservedDirectRecorder("mine");
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter {
    override broadcastNotification(event: Record<string, unknown>) {
      if (event.type === "recording-failed") failures.push(event.error);
    }
  }();
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } }), ws, {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
  });
  const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
  const sequence = [
    ...Array.from({ length: 31 }, (_, index) => ({ LapNumber: 5, CurrentLap: 10 + index, LastLap: 0, sessionUID: "ownership-replay" })),
    { LapNumber: 2, CurrentLap: 0, LastLap: 0, sessionUID: "ownership-replay" },
    { LapNumber: 2, CurrentLap: 0.1, LastLap: 0, sessionUID: "ownership-replay" },
  ];
  let processed = 0;
  try {
    for (const input of frames) {
      if (processed === sequence.length) break;
      const bytes = Buffer.from(input.bytes);
      const packet = parsePacket(bytes, input.timestampMs);
      if (!packet) continue;
      Object.assign(packet, sequence[processed]);
      await pipeline.processPacket(packet, bytes, processed + 1);
      processed++;
    }
    if (processed !== sequence.length) throw new Error(`iRacing fixture yielded ${processed} parsed frames; expected ${sequence.length}`);
    const capture = recorder.capture;
    if (!capture) throw new Error("Direct iRacing pipeline did not start capture");
    expect(capture.rotationCount).toBe(1);
    await pipeline.finalizeCurrentSession();
    unsubscribe();
    expect(failures).toEqual([]);
    const rows = await db.select().from(sessions).where(inArray(sessions.rawFile, [...recorder.accepted.keys()])).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ captureLayoutVersion: 1, rawFile: rows[0]!.captureManifestFile });
    const manifest = JSON.parse(await readFile(rows[0]!.captureManifestFile!, "utf8"));
    let expectedOrdinal = 0;
    let expectedByteOffset = META_FRAME_BYTES;
    for (const chunk of manifest.chunks) {
      const observed = {
        id: chunk.id, firstOrdinal: chunk.firstOrdinal, recordCount: chunk.recordCount,
        sourceStart: chunk.sourceStart, sourceEnd: chunk.sourceEnd,
        sourceByteStart: chunk.sourceByteStart, sourceByteEnd: chunk.sourceByteEnd,
      };
      const expected = {
        firstOrdinal: expectedOrdinal, sourceStart: expectedOrdinal,
        sourceEnd: expectedOrdinal + chunk.recordCount, sourceByteStart: expectedByteOffset,
      };
      if (chunk.firstOrdinal !== expectedOrdinal || chunk.sourceStart !== expectedOrdinal ||
          chunk.sourceEnd !== expectedOrdinal + chunk.recordCount || chunk.sourceByteStart !== expectedByteOffset ||
          chunk.sourceByteEnd < chunk.sourceByteStart) {
        throw new Error(`Direct iRacing manifest discontinuity: ${JSON.stringify({ observed, expected })}`);
      }
      expectedOrdinal += chunk.recordCount;
      expectedByteOffset = chunk.sourceByteEnd;
    }
    expect(manifest.sourceRecordCount).toBe(expectedOrdinal);
    expect(manifest.sourceByteLength).toBe(expectedByteOffset);
    for (const row of rows) {
      const actual = new SourceDigest();
      for await (const record of iterateSessionCaptureRecordsFromSource(
        { ...row, rawFile: row.rawFile!, gameId: "iracing" }, { strict: true },
      )) if (record.kind === "frame") actual.add(record.frame, record.frameTimeMs);
      const expected = recorder.accepted.get(row.rawFile!)!;
      expect(actual.count).toBe(expected.count);
      expect(actual.value()).toBe(expected.value());
    }
    const savedLaps = await db.select().from(laps).where(eq(laps.sessionId, rows[0]!.id)).all();
    expect(savedLaps).toEqual([]);
  } finally {
    unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);

test("direct iRacing pipeline rejects transient lap candidate without a false lap or split", async () => {
  initServerGameAdapters(); resetParserState("iracing");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/iracing-road-america-gt3.bin.gz")), "iracing");
  const recorder = new ObservedDirectRecorder("mine");
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter {
    override broadcastNotification(event: Record<string, unknown>) {
      if (event.type === "recording-failed") failures.push(event.error);
    }
  }();
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } }), ws, {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
  });
  const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
  const sequence = [
    ...Array.from({ length: 31 }, (_, index) => ({ LapNumber: 5, CurrentLap: 10 + index / 10, LastLap: 0, sessionUID: "transient-replay" })),
    { LapNumber: 2, CurrentLap: 0, LastLap: 0, sessionUID: "transient-replay" },
    { LapNumber: 5, CurrentLap: 14, LastLap: 0, sessionUID: "transient-replay" },
  ];
  let processed = 0;
  try {
    for (const input of frames) {
      if (processed === sequence.length) break;
      const bytes = Buffer.from(input.bytes);
      const packet = parsePacket(bytes, input.timestampMs);
      if (!packet) continue;
      Object.assign(packet, sequence[processed]);
      await pipeline.processPacket(packet, bytes, processed + 1);
      processed++;
    }
    if (processed !== sequence.length) throw new Error(`iRacing fixture yielded ${processed} parsed frames; expected ${sequence.length}`);
    const capture = recorder.capture;
    if (!capture) throw new Error("Direct iRacing pipeline did not start capture");
    expect(capture.rotationCount).toBe(0);
    await pipeline.finalizeCurrentSession();
    unsubscribe();
    expect(failures).toEqual([]);
    const rows = await db.select().from(sessions).where(inArray(sessions.rawFile, [...recorder.accepted.keys()])).all();
    expect(rows).toHaveLength(1);
    const actual = new SourceDigest();
    for await (const record of iterateSessionCaptureRecordsFromSource(
      { ...rows[0]!, rawFile: rows[0]!.rawFile!, gameId: "iracing" }, { strict: true },
    )) if (record.kind === "frame") actual.add(record.frame, record.frameTimeMs);
    const expected = recorder.accepted.get(rows[0]!.rawFile!)!;
    expect(actual.count).toBe(expected.count);
    expect(actual.value()).toBe(expected.value());
    const savedLaps = await db.select().from(laps).where(eq(laps.sessionId, rows[0]!.id)).all();
    expect(savedLaps.every(lap => lap.lapNumber === 5)).toBe(true);
  } finally {
    unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);

test("direct iRacing session stop keeps unresolved deferred frames auxiliary to prior lap", async () => {
  initServerGameAdapters(); resetParserState("iracing");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/iracing-road-america-gt3.bin.gz")), "iracing");
  const recorder = new ObservedDirectRecorder("mine");
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter {
    override broadcastNotification(event: Record<string, unknown>) {
      if (event.type === "recording-failed") failures.push(event.error);
    }
  }();
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } }), ws, {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
  });
  const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
  const sourceDecoder = createIRacingSourceDecoderState();
  const sourceEncoder = new IRacingSourceFrameEncoder();
  const samples: Array<{ lap: number; currentLap: number; lastLap: number; fraction: number; sessionTime: number }> = [
    { lap: 4, currentLap: 0.5, lastLap: 0, fraction: 0.98, sessionTime: 100.5 },
    ...Array.from({ length: 31 }, (_, index) => {
      const currentLap = index + 1;
      return { lap: 5, currentLap, lastLap: index === 0 ? 0 : 60, fraction: currentLap / 32, sessionTime: 101 + currentLap };
    }),
    { lap: 6, currentLap: 31.1, lastLap: 60, fraction: 31.1 / 32, sessionTime: 132.1 },
    { lap: 6, currentLap: 31.2, lastLap: 60, fraction: 31.2 / 32, sessionTime: 132.2 },
  ];
  const recordingFrames: Array<{ bytes: Buffer; timestampMs: number | undefined }> = [];
  for (const input of frames) {
    const decoded = decodeIRacingSourceFrame(Buffer.from(input.bytes), sourceDecoder);
    if (!decoded) continue;
    const sample = samples[recordingFrames.length];
    if (!sample) break;
    const values: Record<string, IRacingValue> = {
      ...decoded.values,
      Lap: sample.lap,
      LapCurrentLapTime: sample.currentLap,
      LapLastLapTime: sample.lastLap,
      SessionTime: sample.sessionTime,
      SessionTick: Math.round(sample.sessionTime * 60),
      LapDistPct: sample.fraction,
      LapDist: sample.fraction * decoded.session.trackLengthM,
    };
    recordingFrames.push({
      bytes: sourceEncoder.encode({ ...decoded, values }),
      timestampMs: input.timestampMs,
    });
  }
  if (recordingFrames.length !== samples.length) throw new Error(`iRacing fixture yielded ${recordingFrames.length} source frames; expected ${samples.length}`);
  let processed = 0;
  try {
    for (const input of recordingFrames) {
      if (processed === 32) {
        const capture = recorder.capture;
        if (!capture) throw new Error("Direct iRacing pipeline did not start capture");
        while (!capture.standbyReady) {
          if (capture.hasFailed) throw capture.error ?? new Error("Direct iRacing capture failed");
          await nextTurn();
        }
      }
      const bytes = Buffer.from(input.bytes);
      const packet = parsePacket(bytes, input.timestampMs);
      if (!packet) continue;
      expect(packet.LapNumber).toBe(samples[processed]!.lap);
      expect(packet.iracing?.sdkCurrentLapTime).toBeCloseTo(samples[processed]!.currentLap);
      await pipeline.processPacket(packet, bytes, input.timestampMs);
      processed++;
    }
    if (processed !== samples.length) throw new Error(`iRacing fixture yielded ${processed} parsed frames; expected ${samples.length}`);
    await pipeline.finalizeCurrentSession();
    unsubscribe();
    expect(failures).toEqual([]);
    const rows = await db.select().from(sessions).where(inArray(sessions.rawFile, [...recorder.accepted.keys()])).all();
    expect(rows).toHaveLength(1);
    const savedLaps = await db.select().from(laps).where(eq(laps.sessionId, rows[0]!.id)).all();
    expect(savedLaps.map(lap => [lap.lapNumber, lap.rawFrameCount])).toEqual([[5, 31]]);
    const manifest = JSON.parse(await readFile(rows[0]!.captureManifestFile!, "utf8"));
    const ownedChunk = manifest.chunks.find((chunk: { id: string }) => chunk.id === savedLaps[0]?.captureChunkId);
    expect(ownedChunk).toMatchObject({ kind: "lap", ownedFrameCount: 31, trailingContextFrameCount: 1 });
    expect(ownedChunk.recordCount).toBeGreaterThanOrEqual(31);
    const replayed = await getLapsByIds(savedLaps.map(lap => lap.id));
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.lapNumber).toBe(savedLaps[0]?.lapNumber);
    expect(replayed[0]?.telemetry).toHaveLength(31);
    const actual = new SourceDigest();
    for await (const record of iterateSessionCaptureRecordsFromSource(
      { ...rows[0]!, rawFile: rows[0]!.rawFile!, gameId: "iracing" }, { strict: true },
    )) if (record.kind === "frame") actual.add(record.frame, record.frameTimeMs);
    const expected = recorder.accepted.get(rows[0]!.rawFile!)!;
    expect(actual.count).toBe(expected.count);
    expect(actual.value()).toBe(expected.value());
  } finally {
    unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);

test("direct ACC pipeline retains replacement start and exports completed lap artifacts", async () => {
  initServerGameAdapters(); resetParserState("acc");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz")), "acc");
  const recorder = new ObservedDirectRecorder("mine");
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter {
    override broadcastNotification(event: Record<string, unknown>) {
      if (event.type === "recording-failed") failures.push(event.error);
    }
  }();
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false, sourceOrigin: { kind: "native_capture" } }), ws, {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
  });
  const unsubscribe = subscribeParserSource(input => pipeline.captureParserSource(input));
  const sourceTelemetry = new Map<number, TelemetryPacket>();
  try {
    for (let index = 0; index < frames.length; index++) {
      const input = frames[index]!;
      const timestampMs = input.timestampMs ?? 1_700_000_000_000 + index * 10;
      const bytes = Buffer.from(input.bytes);
      const packet = parsePacket(bytes, timestampMs);
      if (packet) {
        applyFrameTime(packet, timestampMs);
        sourceTelemetry.set(packet.TimestampMS, { ...packet });
        await pipeline.processPacket(packet, bytes, timestampMs);
      }
      if ((index & 127) === 127) await nextTurn();
    }
    const capture = recorder.capture;
    if (!capture) throw new Error("Direct ACC pipeline did not start capture");
    expect(capture.rotationCount).toBeGreaterThan(0);
    await pipeline.finalizeCurrentSession();
    unsubscribe();
    expect(failures).toEqual([]);
    const rows = await db.select().from(sessions).where(inArray(sessions.rawFile, [...recorder.accepted.keys()])).all();
    expect(rows).toHaveLength(1);
    const storedLaps = await db.select().from(laps).where(eq(laps.sessionId, rows[0]!.id)).all();
    expect(storedLaps.length).toBeGreaterThan(0);
    for (const row of rows) {
      const actual = new SourceDigest();
      for await (const record of iterateSessionCaptureRecordsFromSource(
        { ...row, rawFile: row.rawFile!, gameId: "acc" }, { strict: true },
      )) if (record.kind === "frame") actual.add(record.frame, record.frameTimeMs);
      const expected = recorder.accepted.get(row.rawFile!)!;
      expect(actual.count).toBe(expected.count);
      expect(actual.value()).toBe(expected.value());
    }
    const replayed = await getLapsByIds(storedLaps.map(lap => lap.id));
    expect(replayed.map(lap => [lap.id, lap.lapNumber, lap.lapTime]))
      .toEqual(storedLaps.map(lap => [lap.id, lap.lapNumber, lap.lapTime]));
    const replayedPackets = replayed.flatMap(lap => lap.telemetry);
    expect(replayedPackets.length).toBeGreaterThan(0);
    expect(replayed.every(lap => !lap.parseError)).toBe(true);
    for (const lap of replayed) {
      for (let index = 0; index < lap.telemetry.length; index++) {
        const packet = lap.telemetry[index]!;
        const source = sourceTelemetry.get(packet.TimestampMS);
        if (!source) throw new Error(`Replay has no native source sample at ${packet.TimestampMS}`);
        const previous = lap.telemetry[index - 1];
        // Replay aligns a next-lap completion sample with the lap it finishes.
        const expected = index === lap.telemetry.length - 1 && previous &&
          source.LapNumber > previous.LapNumber && source.LastLap > previous.CurrentLap
          ? {
            ...source,
            CurrentLap: source.LastLap,
            LapNumber: previous.LapNumber,
            DistanceTraveled: Math.max(source.DistanceTraveled, previous.DistanceTraveled),
          }
          : source;
        expect(telemetrySampleKey(packet)).toBe(telemetrySampleKey(expected));
      }
    }
    const selected = storedLaps.slice(0, 1);
    const exported = await buildLapsZip(selected.map(lap => lap.id));
    const imported = await importLapsZip(exported.bytes, { ownership: "others" });
    expect(imported.errors).toEqual([]);
    expect(imported.laps.map(lap => lap.lapTime)).toEqual(selected.map(lap => lap.lapTime));
  } finally {
    unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(row => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(row => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 60_000);
