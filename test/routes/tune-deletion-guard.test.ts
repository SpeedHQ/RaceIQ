import { describe, test, expect, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../server/db/index";
import { laps, sessions, tuneAssignments, tunes } from "../../server/db/schema";
import { tuneResourceRoutes } from "../../server/routes/tunes/resource-routes";

const tuneIds: number[] = [];
const sessionIds: number[] = [];

async function createTune(name: string): Promise<number> {
  const row = await db.insert(tunes).values({
    gameId: "ac-evo", name, author: "test", carOrdinal: 1, category: "race", description: "", settings: "{}",
  }).returning({ id: tunes.id }).get();
  tuneIds.push(row!.id);
  return row!.id;
}

async function createSession(gameId = "ac-evo"): Promise<number> {
  const row = await db.insert(sessions).values({ gameId, carOrdinal: 1, trackOrdinal: 2 }).returning({ id: sessions.id }).get();
  sessionIds.push(row!.id);
  return row!.id;
}

afterEach(async () => {
  for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id)).run();
  for (const id of tuneIds) await db.delete(tunes).where(eq(tunes.id, id)).run();
  sessionIds.length = 0;
  tuneIds.length = 0;
});

describe("tune deletion guard API", () => {
  test("refuses linked deletion without explicit confirmation and returns full usage", async () => {
    const tuneId = await createTune("Referenced");
    const sessionId = await createSession();
    const inserted = await db.insert(laps).values([
      { sessionId, tuneId, lapNumber: 1, lapTime: 90, isValid: true },
      { sessionId, tuneId, lapNumber: 2, lapTime: 89, isValid: true },
    ]).returning({ id: laps.id }).all();
    await db.insert(tuneAssignments).values({ gameId: "ac-evo", carOrdinal: 1, trackOrdinal: 2, tuneId }).run();

    for (const query of ["", "?confirmInUse=false"]) {
      const response = await tuneResourceRoutes.request(`/api/tunes/${tuneId}${query}`, { method: "DELETE" });
      expect(response.status).not.toBe(200);
      if (query === "") {
        expect(response.status).toBe(409);
        expect((await response.json()).usage).toMatchObject({
          sessions: [{ sessionId, laps: [{ id: inserted[0].id, lapNumber: 1 }, { id: inserted[1].id, lapNumber: 2 }] }],
          assignments: [{ gameId: "ac-evo", carOrdinal: 1, trackOrdinal: 2 }],
        });
      } else {
        expect(response.status).toBe(400);
      }
    }
    expect(await db.select({ id: tunes.id }).from(tunes).where(eq(tunes.id, tuneId)).get()).toBeDefined();
  });

  test("confirmed linked deletion clears tune links but preserves all recordings and unrelated setups", async () => {
    const tuneId = await createTune("Referenced");
    const unrelatedTuneId = await createTune("Unrelated");
    const linkedSessionId = await createSession();
    const otherSessionId = await createSession("acc");
    const linkedLap = await db.insert(laps).values({ sessionId: linkedSessionId, tuneId, lapNumber: 7, lapTime: 91, isValid: true }).returning({ id: laps.id }).get();
    const unrelatedLap = await db.insert(laps).values({ sessionId: otherSessionId, tuneId: unrelatedTuneId, lapNumber: 8, lapTime: 92, isValid: true }).returning({ id: laps.id }).get();
    await db.insert(tuneAssignments).values({ gameId: "ac-evo", carOrdinal: 1, trackOrdinal: 2, tuneId }).run();

    const response = await tuneResourceRoutes.request(`/api/tunes/${tuneId}?confirmInUse=true`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await db.select({ id: laps.id, sessionId: laps.sessionId, tuneId: laps.tuneId }).from(laps).where(eq(laps.id, linkedLap!.id)).get()).toEqual({ id: linkedLap!.id, sessionId: linkedSessionId, tuneId: null });
    expect(await db.select({ id: laps.id, sessionId: laps.sessionId, tuneId: laps.tuneId }).from(laps).where(eq(laps.id, unrelatedLap!.id)).get()).toEqual({ id: unrelatedLap!.id, sessionId: otherSessionId, tuneId: unrelatedTuneId });
    expect(await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, linkedSessionId)).get()).toBeDefined();
    expect(await db.select({ id: tunes.id }).from(tunes).where(eq(tunes.id, unrelatedTuneId)).get()).toBeDefined();
    expect(await db.select().from(tuneAssignments).where(eq(tuneAssignments.tuneId, tuneId)).all()).toEqual([]);
  });

  test("deletes unlinked setup and reports missing usage and deletion as not found", async () => {
    const tuneId = await createTune("Unused");
    expect((await tuneResourceRoutes.request(`/api/tunes/${tuneId}`, { method: "DELETE" })).status).toBe(200);
    expect((await tuneResourceRoutes.request("/api/tunes/999999999/usage")).status).toBe(404);
    expect((await tuneResourceRoutes.request("/api/tunes/999999999?confirmInUse=true", { method: "DELETE" })).status).toBe(404);
  });
});
