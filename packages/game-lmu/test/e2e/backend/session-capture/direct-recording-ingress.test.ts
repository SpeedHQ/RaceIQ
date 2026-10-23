import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { RealDbAdapter, NullWsAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { decodeLMUSourceFrame, encodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import {
  LMU_GAME_VERSION_OFFSET, LMU_SCORING_INFO_OFFSET, LMU_SCORING_VEHICLES_OFFSET,
  LMU_SESSION_EVENT_OFFSET, LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY,
  LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET,
} from "@raceiq/capture-formats/lmu/layout";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { fixtureFrames } from "@raceiq/backend/test-support/fixture-frames";
import { initServerGameAdapters } from "@raceiq/backend/test-support/games";
import type { GameId } from "@raceiq/shared/games/ids";
import { fixturePath } from "../../../support/fixtures";

registerDriverProfileLapNotifier(() => {});
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
class ObservedDirectRecorder extends DirectSessionRecorderAdapter {
  readonly accepted = new Map<string, SourceDigest>();
  override start(gameId: GameId) { super.start(gameId); this.accepted.set(this.path!, new SourceDigest()); }
  override writeRecord(frame: Buffer, timestamp?: number) { super.writeRecord(frame, timestamp); this.accepted.get(this.path!)!.add(frame, timestamp); }
  override writeRawCaptureBytes(bytes: Buffer) {
    super.writeRawCaptureBytes(bytes);
    for (const record of iterateSessionCaptureRecords(bytes, 0, { strict: true })) if (record.kind === "frame") this.accepted.get(this.path!)!.add(record.frame, record.frameTimeMs);
  }
}

test("direct LMU capture backpressures rapid context generations and replays every retired context", async () => {
  initServerGameAdapters(); resetParserState("lmu");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(row => row.id));
  const frames = fixtureFrames(await readFile(fixturePath("sessions/lmu-spa-iron-lynx-gte.bin.gz")), "lmu");
  if (frames.length < 12) throw new Error(`LMU fixture yielded ${frames.length} frames; expected at least 12`);
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let durableCalls = 0;
  const recorder = new ObservedDirectRecorder("others", { writerOptions: {
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
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false }), ws, {
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
          key: { sessionKey: `recording-generation-${generation}`, captureSequence: (++sequence).toString(), frameTime: { domain: "session", milliseconds: original.captureTimestampMs } },
          playerVehicleId: original.telemetry.readInt32LE(LMU_TELEMETRY.id), status: "active", supplemental: [],
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
      for await (const record of iterateSessionCaptureRecordsFromSource({ ...row, rawFile: row.rawFile!, gameId: "lmu" }, { strict: true })) {
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
    resetParserState("lmu");
  }
}, 60_000);
