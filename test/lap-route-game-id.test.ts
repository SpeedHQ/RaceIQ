import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../server/db/index";
import { laps, sessions } from "../server/db/schema";
import { lapRoutes } from "../server/routes/laps";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";

initGameAdapters();
initServerGameAdapters();

describe("GET /api/laps/:id game context", () => {
  const sessionIds: number[] = [];

  afterEach(async () => {
    for (const sessionId of sessionIds) {
      await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
      await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    }
    sessionIds.length = 0;
  });

  async function insertLap(): Promise<number> {
    const session = await db
      .insert(sessions)
      .values({
        carOrdinal: 1,
        trackOrdinal: 1,
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
