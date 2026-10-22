import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { initServerGameAdapters } from "../../src/games/init";

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
