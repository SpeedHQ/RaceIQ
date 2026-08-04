/**
 * GET /api/laps/:id/issues — per-lap tune issue feed route. Uses the real
 * (test) SQLite DB directly, same convention as lap-legacy-detection.test.ts,
 * since getLapById reads through the raw session file rather than a mockable
 * layer.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { tuneRoutes } from "../../server/routes/tune-routes";

initGameAdapters();
initServerGameAdapters();

const TRACK_ORDINAL = 434343;

async function insertSession(rawFile: string | null): Promise<number> {
  const row = await db
    .insert(sessions)
    .values({ carOrdinal: 1, trackOrdinal: TRACK_ORDINAL, gameId: "fm-2023", rawFile })
    .returning({ id: sessions.id })
    .get();
  return row!.id;
}

async function insertLap(sessionId: number, lapNumber: number): Promise<number> {
  const row = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime: 90.0,
      isValid: true,
      rawByteOffset: null,
      rawFrameCount: null,
    })
    .returning({ id: laps.id })
    .get();
  return row!.id;
}

describe("GET /api/laps/:id/issues", () => {
  const sessionIds: number[] = [];

  afterEach(async () => {
    for (const sid of sessionIds) {
      await db.delete(laps).where(eq(laps.sessionId, sid)).run();
      await db.delete(sessions).where(eq(sessions.id, sid)).run();
    }
    sessionIds.length = 0;
  });

  test("legacy lap with no stored telemetry returns an empty feed", async () => {
    const sid = await insertSession(null); // no rawFile → legacy, telemetry === []
    sessionIds.push(sid);
    const lapId = await insertLap(sid, 1);

    const res = await tuneRoutes.request(`/api/laps/${lapId}/issues`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("unknown lap id returns 404", async () => {
    const res = await tuneRoutes.request("/api/laps/999999999/issues");
    expect(res.status).toBe(404);
  });
});
