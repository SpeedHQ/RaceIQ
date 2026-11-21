/** Canonical import oracle: committed captures must use index projections, never full packets. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { initServerGameAdapters } from "../../src/games/init";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { normalizeTelemetryPacket } from "@raceiq/telemetry-core/telemetry/normalization";
import {
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
  iterateSessionCaptureRecords,
  iterateSessionFrames,
} from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { ACEVO_STATUS, GRAPHICS_EVO, STATIC_EVO } from "@raceiq/capture-formats/ac-evo/structs";
import { ACEVO_PACKED_MAGIC, packTriplet, unpackTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions, laps } from "@raceiq/backend-core/db/schema";
import { enableParserInstrumentation, getParserInstrumentation, resetParserInstrumentation } from "@raceiq/backend-core/session-capture/test-instrumentation";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";

initGameAdapters();
initServerGameAdapters();

afterEach(() => {
  enableParserInstrumentation(false);
  resetParserInstrumentation();
  stopMaintenanceTasks();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const tempDirs: string[] = [];

const FIXTURES = [
  ["fm-2023-2026-04-09T21-55-03-186Z.bin.gz", "fm-2023"],
  ["f1-2025-2026-04-09T21-34-10-190Z.bin.gz", "f1-2025"],
] as const;

describe("indexed canonical import oracle", () => {
  test.each(FIXTURES)("%s keeps detector projection equal to full parser", async (name, gameId) => {
    const bytes = gunzipSync(readFileSync(`test/artifacts/sessions/${name}`));
    const game = getServerGame(gameId);
    const indexedState = game.createParserState();
    const fullState = game.createParserState();
    let compared = 0;
    for (const frame of iterateSessionFrames(bytes)) {
      const indexed = game.tryParseLapIndex(frame, indexedState);
      const full = game.tryParse(frame, fullState);
      if (indexed && full) {
        normalizeTelemetryPacket(indexed as unknown as TelemetryPacket, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
        normalizeTelemetryPacket(full, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
        const indexedFields = indexed as unknown as Record<string, unknown>;
        const fullFields = full as unknown as Record<string, unknown>;
        for (const key of ["gameId", "LapNumber", "CurrentLap", "LastLap", "DistanceTraveled", "PositionX", "PositionZ", "Yaw", "Fuel"]) {
          if (key in indexedFields && key in fullFields) expect(indexedFields[key]).toEqual(fullFields[key]);
        }
        compared++;
      }
      if (compared >= 8) break;
    }
    expect(compared).toBeGreaterThan(0);

    const directory = mkdtempSync(join(tmpdir(), "raceiq-sparse-import-"));
    tempDirs.push(directory);
    const capturePath = join(directory, "capture.bin");
    const recorder = new SparseSessionRecorder(gameId);
    recorder.start(capturePath);
    recorder.writeMetaFrame();
    for (const record of iterateSessionCaptureRecords(bytes)) {
      if (record.kind === "frame") recorder.writeRecord(record.frame, record.frameTimeMs);
      else if (record.kind === "segment-boundary") recorder.writeSegmentBoundary();
      else if (record.kind === "segment-context") recorder.writeRawCaptureBytes(encodeSegmentContextFrame());
      else recorder.writeRawCaptureBytes(encodeSegmentContextEndFrame());
    }
    await recorder.stop();
    const sparseBytes = readFileSync(capturePath);
    enableParserInstrumentation(true);
    const result = await importSessionBin(sparseBytes, gameId, { notifyDriverProfile: false });
    const counts = getParserInstrumentation();
    expect(result.packetCount).toBeGreaterThan(0);
    expect(counts.sourceFramesScanned).toBeGreaterThan(0);
    expect(counts.indexSamplesMaterialized).toBeGreaterThan(0);
    const sessionIds = [...new Set(result.laps.map((lap) => lap.sessionId))];
    for (const sid of sessionIds) {
      await db.delete(laps).where(inArray(laps.sessionId, [sid])).run();
      await db.delete(sessions).where(inArray(sessions.id, [sid])).run();
    }
  }, 180000);

  test.each([false, true])("AC EVO import corrects a late phase name unless the session was edited (%s)", async (edited) => {
    const bytes = gunzipSync(readFileSync("test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz"));
    const first = iterateSessionFrames(bytes).next().value!;
    const { carOrdinal, trackOrdinal, physics, graphics, staticData } = unpackTriplet(first)!;
    graphics.writeInt32LE(ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
    const { offset, size } = STATIC_EVO.session_name;
    staticData.fill(0, offset, offset + size);
    staticData.writeInt32LE(-1, STATIC_EVO.session.offset);
    const startup = packTriplet(ACEVO_PACKED_MAGIC, carOrdinal, trackOrdinal, physics, graphics, staticData);
    staticData.write("Practice", offset);
    const named = packTriplet(ACEVO_PACKED_MAGIC, carOrdinal, trackOrdinal, physics, graphics, staticData);
    const sessionSource = `ac-evo-phase-test-${edited}`;
    async function* frames() {
      yield startup;
      if (edited) {
        await db.update(sessions).set({ sessionType: "qualifying" }).where(eq(sessions.source, sessionSource)).run();
      }
      yield named;
    }
    const { sessionIds } = await importSessionFrames(frames(), "ac-evo", { notifyDriverProfile: false, sessionSource });
    try {
      expect(sessionIds).toHaveLength(1);
      const rows = await db.select({ sessionType: sessions.sessionType }).from(sessions)
        .where(inArray(sessions.id, sessionIds)).all();
      expect(rows).toEqual([{ sessionType: edited ? "qualifying" : "practice" }]);
    } finally {
      await db.delete(laps).where(inArray(laps.sessionId, sessionIds)).run();
      await db.delete(sessions).where(inArray(sessions.id, sessionIds)).run();
    }
  });
});
