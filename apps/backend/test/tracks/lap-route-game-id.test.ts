import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions, sessionCaptureSplitJobs } from "@raceiq/backend-core/db/schema";
import { alignedTelemetryCacheGet, alignedTelemetryCacheSet, cacheDelete } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { lapRoutes } from "../../src/routes/laps/index";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
initServerGameAdapters();

describe("GET /api/laps/:id game context", () => {
  const sessionIds: number[] = [];

  afterEach(async () => {
    for (const sessionId of sessionIds) {
      const lapRows = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
      for (const lap of lapRows) cacheDelete(lap.id);
      await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
      await db.delete(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).run();
      await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    }
    sessionIds.length = 0;
  });

  test("blocks cached aligned telemetry after capture becomes queued", async () => {
    const lapId = await insertLap();
    alignedTelemetryCacheSet([lapId], "{\"cached\":true}");
    expect(alignedTelemetryCacheGet([lapId])).toBe("{\"cached\":true}");
    await db.insert(sessionCaptureSplitJobs).values({
      sessionId: sessionIds.at(-1)!,
      jobId: `lap-route-${lapId}`,
      pendingSourceRevision: "test-source-revision",
      sourcePath: "lap-route-capture.bin",
      status: "queued",
    });

    const response = await lapRoutes.request("/api/laps/aligned-telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [lapId], step: 1 }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "RECORDING_PROCESSING", error: "Recording is queued or processing" });
  });

  async function insertLap(): Promise<number> {
    const session = await db
      .insert(sessions)
      .values({
        carId: "1",
        trackId: "1",
        gameId: "iracing",
        rawFile: null,
      })
      .returning({ id: sessions.id })
      .get();
    sessionIds.push(session!.id);
    const lap = await db
      .insert(laps)
      .values({
        sessionId: session!.id,
        lapNumber: 1,
        lapTime: 90,
        isValid: true,
      })
      .returning({ id: laps.id })
      .get();
    return lap!.id;
  }

  test("requires X-Game-Id", async () => {
    const lapId = await insertLap();

    const response = await lapRoutes.request(`/api/laps/${lapId}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Missing or invalid X-Game-Id header",
    });
  });

  test("rejects game context that does not own the lap", async () => {
    const lapId = await insertLap();

    const response = await lapRoutes.request(`/api/laps/${lapId}`, {
      headers: { "X-Game-Id": "acc" },
    });

    expect(response.status).toBe(404);
  });

  test("loads the lap in its requested game context", async () => {
    const lapId = await insertLap();

    const response = await lapRoutes.request(`/api/laps/${lapId}`, {
      headers: { "X-Game-Id": "iracing" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: lapId,
      gameId: "iracing",
    });
  });
});
