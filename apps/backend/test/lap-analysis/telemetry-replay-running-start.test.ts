import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { registerGame } from "@raceiq/shared/games/registry";
import { decompressIfGzipSync, iterateSessionCaptureRecords, SESSION_SEGMENT_BOUNDARY, SESSION_SEGMENT_CONTEXT, SESSION_SEGMENT_CONTEXT_END } from "@raceiq/capture-formats/session/framing";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { forzaServerAdapter } from "@raceiq/game-fm-2023";
import { db } from "@raceiq/backend-core/db/index";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { cacheDelete, parseRawLapFramesFromBuffer, parseSessionLapsBatchedForTest } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";

describe("FM running-start lap replay", () => {
  test("imported first lap replays trimmed across single, buffer, and batched paths", async () => {
    const recording = new URL("../../../../test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz", import.meta.url);
    registerGame(forzaServerAdapter);
    registerServerGame(forzaServerAdapter);
    const source = decompressIfGzipSync(readFileSync(recording));
    const converted = await convertSeedFramesToSparse("fm-2023", (function* () {
      for (const record of iterateSessionCaptureRecords(source)) {
        if (record.kind === "frame") {
          yield record.frameTimeMs === undefined
            ? record.frame
            : { frame: record.frame, frameTimeMs: record.frameTimeMs };
        } else if (record.kind === "segment-boundary") {
          yield SESSION_SEGMENT_BOUNDARY;
        } else if (record.kind === "segment-context") {
          yield SESSION_SEGMENT_CONTEXT;
        } else if (record.kind === "segment-context-end") {
          yield SESSION_SEGMENT_CONTEXT_END;
        }
      }
    })());
    const imported = await importSessionBin(readFileSync(converted.path), "fm-2023", {
      requireLaps: true,
      notifyDriverProfile: false,
    });
    const ownedSessionIds = [...new Set(imported.laps.map((lap) => lap.sessionId))];
    try {
      const firstLap = imported.laps.find((lap) => lap.lapNumber === 0 && lap.isValid && lap.lapTime > 10);
      expect(firstLap).toBeDefined();
      const row = await db.select({
        id: laps.id,
        rawFile: sessions.rawFile,
        sessionId: laps.sessionId,
        rawByteOffset: laps.rawByteOffset,
        rawFrameCount: laps.rawFrameCount,
      }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).where(eq(laps.id, firstLap!.lapId)).get();
      expect(row).toBeDefined();
      const rawFrameCount = row!.rawFrameCount;
      if (rawFrameCount === null) throw new Error("Imported lap has no raw frame count");
      if (!row!.rawFile) throw new Error("Imported lap has no owned raw capture");
      const capture = decompressIfGzipSync(readFileSync(row!.rawFile));
      cacheDelete(row!.id);

      const lap = await getLapById(row!.id);
      expect(lap).toBeDefined();
      expect(lap!.parseError).toBeUndefined();
      const telemetry = lap!.telemetry;
      expect(telemetry.length).toBeGreaterThan(3200);
      expect(telemetry.length).toBeLessThan(3300);
      expect(telemetry[0]!.CurrentLap).toBeGreaterThanOrEqual(0);
      expect(telemetry[0]!.CurrentLap).toBeLessThan(0.1);
      expect(telemetry[0]!.DistanceTraveled).toBeGreaterThan(-100);
      expect(telemetry.at(-1)!.CurrentLap).toBeCloseTo(lap!.lapTime, 0);
      for (let i = 1; i < telemetry.length; i++) {
        expect(telemetry[i]!.CurrentLap).toBeGreaterThanOrEqual(telemetry[i - 1]!.CurrentLap - 0.05);
      }
      const distanceSpan = telemetry.at(-1)!.DistanceTraveled - telemetry[0]!.DistanceTraveled;
      expect(distanceSpan).toBeGreaterThan(3400);
      expect(distanceSpan).toBeLessThan(3700);

      const buffered = parseRawLapFramesFromBuffer(
        capture,
        row!.rawByteOffset!,
        rawFrameCount,
        "fm-2023",
        row!.rawFile,
      );
      const batched = await parseSessionLapsBatchedForTest({
        rawFile: row!.rawFile,
        source: null,
        gameId: "fm-2023",
        carId: lap!.carId,
        trackId: lap!.trackId,
      }, [{ id: row!.id, rawByteOffset: row!.rawByteOffset!, rawFrameCount }]);
      expect(buffered.length).toBe(telemetry.length);
      expect(batched.get(row!.id)?.length).toBe(telemetry.length);
      for (let index = 0; index < telemetry.length; index++) {
        expect(buffered[index]).toEqual(telemetry[index]);
        expect(batched.get(row!.id)![index]).toEqual(telemetry[index]);
      }
    } finally {
      for (const sessionId of ownedSessionIds) {
        await deleteSession(sessionId);
      }
      converted.cleanup();
    }
  }, { timeout: 180_000 });
});
