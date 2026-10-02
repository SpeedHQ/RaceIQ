/** Canonical import oracle: committed captures must use index projections, never full packets. */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { normalizeTelemetryPacket } from "../../server/telemetry/normalization";
import { iterateSessionFrames } from "../../server/session-capture/framing";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { inArray } from "drizzle-orm";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { enableParserInstrumentation, getParserInstrumentation, resetParserInstrumentation } from "../../server/session-capture/test-instrumentation";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";

initGameAdapters();
initServerGameAdapters();

afterEach(() => { enableParserInstrumentation(false); resetParserInstrumentation(); stopMaintenanceTasks(); });

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

    enableParserInstrumentation(true);
    const result = await importSessionBin(bytes, gameId, { notifyDriverProfile: false });
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
});
