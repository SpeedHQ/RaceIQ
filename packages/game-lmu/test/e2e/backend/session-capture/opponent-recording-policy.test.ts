import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { iterateSessionCaptureRecordsFromSource, loadCaptureManifest } from "@raceiq/backend-core/session-capture/source-loader";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { isLMUPartitionCompanion } from "@raceiq/capture-formats/lmu/partition";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { initServerGameAdapters } from "@raceiq/backend/test-support/games";
import { fixturePath } from "../../../support/fixtures";

for (const enabled of [true, false]) {
  test(`LMU live ingress snapshots opponent retention ${enabled} across a mid-session preference change`, async () => {
    initServerGameAdapters();
    resetParserState("lmu");
    const original = loadSettings({ syncLaunchOnLogin: false });
    const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map((row) => row.id));
    saveSettings({ ...original, recordLmuOpponents: enabled });
    const recorder = new DirectSessionRecorderAdapter("others");
    const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false }), new NullWsAdapter(), {
      recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
    });
    const unsubscribe = subscribeParserSource((input) => pipeline.captureParserSource(input));
    const submitted = createHash("sha256");
    const expectedPlayer = createHash("sha256");
    const submittedTimestamps: Array<number | undefined> = [];
    const restoredTimestamps: Array<number | undefined> = [];
    let liveOpponentObserved = false;
    let inputFrames = 0;
    try {
      for (const record of iterateSessionCaptureRecords(gunzipSync(makeLmuOpponentCapture()), 0, { strict: true })) {
        if (record.kind !== "frame") continue;
        const native = decodeLMUSourceFrame(record.frame)!;
        const packet = parsePacket(record.frame, record.frameTimeMs);
        if (!packet) throw new Error("Controlled native frame did not enter the production parser");
        liveOpponentObserved ||= packet.lmuContext?.competitors?.some((competitor) => !competitor.isPlayer) === true;
        submittedTimestamps.push(record.frameTimeMs);
        submitted.update(record.frame);
        expectedPlayer.update(native.telemetry);
        await pipeline.processPacket(packet, record.frame, record.frameTimeMs);
        await pipeline.drainSessionRecorderWrites();
        if (++inputFrames === 200) saveSettings({ ...original, recordLmuOpponents: !enabled });
      }
      await pipeline.finalizeCurrentSession();
      const created = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id));
      expect(created).toHaveLength(1);
      expect(liveOpponentObserved).toBe(true);
      const session = created[0]!;
      if (!session.rawFile) throw new Error("Live recording did not publish a source");
      expect(await readLmuOpponentRetention(session.rawFile)).toMatchObject(enabled
        ? { opponentRetention: "retained", opponentAvailability: "complete" }
        : { opponentRetention: "not-recorded", opponentAvailability: null });
      const restored = createHash("sha256");
      const player = createHash("sha256");
      let restoredFrames = 0;
      for await (const record of iterateSessionCaptureRecordsFromSource({
        rawFile: session.rawFile, source: session.source, gameId: "lmu", carId: session.carId, trackId: session.trackId,
        captureFormatVersion: session.captureFormatVersion,
      }, { strict: true })) {
        if (record.kind !== "frame") continue;
        restoredTimestamps.push(record.frameTimeMs);
        const native = decodeLMUSourceFrame(record.frame)!;
        player.update(native.telemetry);
        restored.update(record.frame);
        if (!enabled) {
          expect(record.frame.includes(Buffer.from("Controlled opponent"))).toBe(false);
          expect(native.lmuContext?.competitors?.some((competitor) => !competitor.isPlayer) ?? false).toBe(false);
        }
        restoredFrames++;
      }
      expect(restoredFrames).toBe(inputFrames);
      expect(restoredTimestamps).toEqual(submittedTimestamps);
      expect(player.digest("hex")).toBe(expectedPlayer.digest("hex"));
      const nextSetting = !enabled;
      saveSettings({ ...original, recordLmuOpponents: nextSetting });
      const nextRecorder = new DirectSessionRecorderAdapter("others");
      const nextPipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false }), new NullWsAdapter(), {
        recorder: nextRecorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
      });
      const nextUnsubscribe = subscribeParserSource((input) => nextPipeline.captureParserSource(input));
      try {
        resetParserState("lmu");
        for (const record of iterateSessionCaptureRecords(gunzipSync(makeLmuOpponentCapture()), 0, { strict: true })) {
          if (record.kind !== "frame") continue;
          const packet = parsePacket(record.frame, record.frameTimeMs);
          if (!packet) continue;
          await nextPipeline.processPacket(packet, record.frame, record.frameTimeMs);
          await nextPipeline.drainSessionRecorderWrites();
        }
        await nextPipeline.finalizeCurrentSession();
        const nextCreated = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id) && row.id !== session.id);
        expect(nextCreated).toHaveLength(1);
        if (!nextCreated[0]!.rawFile) throw new Error("Next live session did not publish a source");
        expect(await readLmuOpponentRetention(nextCreated[0]!.rawFile)).toMatchObject(nextSetting
          ? { opponentRetention: "retained", opponentAvailability: "complete" }
          : { opponentRetention: "not-recorded", opponentAvailability: null });
      } finally {
        nextUnsubscribe();
        await nextPipeline.finalizeCurrentSession().catch(() => {});
      }
    } finally {
      unsubscribe();
      await pipeline.finalizeCurrentSession().catch(() => {});
      saveSettings(original);
      const created = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id));
      if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map((row) => row.id))).run();
      for (const row of created) if (row.rawFile) await rm(dirname(row.rawFile), { recursive: true, force: true });
      resetParserState("lmu");
    }
  }, 120_000);
}

test("real LMU multiplayer frames enter live ingress and split losslessly into player and opponent files", async () => {
  initServerGameAdapters();
  resetParserState("lmu");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map((row) => row.id));
  const fixture = await readFile(fixturePath("sessions/lmu-real-opponents-grid-2026-10-22.bin.gz"));
  const recorder = new DirectSessionRecorderAdapter("others", { recordLmuOpponents: true });
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false }), new NullWsAdapter(), {
    recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
  });
  const unsubscribe = subscribeParserSource((input) => pipeline.captureParserSource(input));
  const submitted = createHash("sha256");
  const expectedPlayer = createHash("sha256");
  const timestamps: Array<number | undefined> = [];
  const opponentIds = [16, 17, 18, 20, 22, 24, 30, 32, 34, 35, 37, 47, 50, 51, 53];
  const opponentNames = new Set<string>();
  try {
    for (const record of iterateSessionCaptureRecords(gunzipSync(fixture), 0, { strict: true })) {
      if (record.kind !== "frame") continue;
      const native = decodeLMUSourceFrame(record.frame)!;
      for (const competitor of native.lmuContext?.competitors ?? []) {
        const name = competitor.channels["identity.competitor.driver-name"]?.value;
        if (!competitor.isPlayer && typeof name === "string") opponentNames.add(name);
      }
      const packet = parsePacket(record.frame, record.frameTimeMs);
      if (!packet) throw new Error("Real native frame did not enter the production parser");
      submitted.update(record.frame);
      expectedPlayer.update(native.telemetry);
      timestamps.push(record.frameTimeMs);
      await pipeline.processPacket(packet, record.frame, record.frameTimeMs);
      await pipeline.drainSessionRecorderWrites();
    }
    await pipeline.finalizeCurrentSession();
    const created = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id));
    expect(created).toHaveLength(1);
    expect(timestamps).toHaveLength(51);
    expect(opponentNames.size).toBe(opponentIds.length);
    const session = created[0]!;
    if (!session.rawFile) throw new Error("Real live recording did not publish a source");
    expect(await readLmuOpponentRetention(session.rawFile)).toMatchObject({
      opponentRetention: "retained", opponentAvailability: "complete",
    });
    const manifest = await loadCaptureManifest(session.rawFile);
    if (manifest.version !== 3 || !manifest.opponentCompanion) throw new Error("Live recorder did not publish a primary/companion manifest");
    expect(manifest.sourceRecordCount).toBe(timestamps.length);
    const directory = dirname(session.rawFile);
    const primaryPlayer = createHash("sha256");
    let primaryFrames = 0;
    for (const chunk of manifest.chunks) {
      const bytes = await readFile(resolve(directory, chunk.path));
      for (const name of opponentNames) expect(bytes.includes(Buffer.from(name))).toBe(false);
      for (const record of iterateSessionCaptureRecords(bytes, 0, { strict: true })) {
        if (record.kind !== "frame") continue;
        const native = decodeLMUSourceFrame(record.frame)!;
        expect(native.schemaVersion).toBe(5);
        expect(native.lmuContext?.competitors?.some((competitor) => !competitor.isPlayer) ?? false).toBe(false);
        if (record.offset >= (chunk.sourceRecordByteOffset ?? 0)) {
          primaryFrames++;
          primaryPlayer.update(native.telemetry);
        }
      }
    }
    expect(primaryFrames).toBe(timestamps.length);
    expect(primaryPlayer.digest("hex")).toBe(expectedPlayer.digest("hex"));
    const companion = manifest.opponentCompanion;
    const companionBytes = await readFile(resolve(directory, companion.file));
    let companionFrames = 0;
    for (const record of iterateSessionCaptureRecords(companionBytes, 0, { strict: true })) {
      if (record.kind !== "frame") continue;
      expect(isLMUPartitionCompanion(record.frame)).toBe(true);
      companionFrames++;
    }
    expect(companionFrames).toBe(companion.committedPrefix.recordCount);
    const restored = createHash("sha256");
    const restoredTimestamps: Array<number | undefined> = [];
    const restoredIds = new Set<number>();
    for await (const record of iterateSessionCaptureRecordsFromSource({ ...session, rawFile: session.rawFile, gameId: "lmu" }, { strict: true })) {
      if (record.kind !== "frame") continue;
      restored.update(record.frame);
      restoredTimestamps.push(record.frameTimeMs);
      const native = decodeLMUSourceFrame(record.frame)!;
      for (const competitor of native.lmuContext?.competitors ?? []) if (!competitor.isPlayer) restoredIds.add(competitor.vehicleId);
    }
    expect(restoredTimestamps).toEqual(timestamps);
    expect(restored.digest("hex")).toBe(submitted.digest("hex"));
    expect([...restoredIds].sort((a, b) => a - b)).toEqual(opponentIds);
    expect(restoredIds.has(54)).toBe(false);
  } finally {
    unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map((row) => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(dirname(row.rawFile), { recursive: true, force: true });
    resetParserState("lmu");
  }
}, 120_000);
