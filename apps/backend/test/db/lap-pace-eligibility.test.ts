import { afterEach, expect, test } from "bun:test";
import { client, db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { getLapsByIds, getReviewLaps, getSessionLaps } from "@raceiq/backend-core/db/lap-read-queries";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";

const sessionIds: number[] = [];
afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
});

test("review SQL ranks only valid positive pace laps while inventory retains all categories", async () => {
  const session = await db.insert(sessions).values({
    gameId: "acc", carId: "pace-regression", trackId: "pace-regression",
    ownership: "mine", rawFile: "pace-regression.capture",
  }).returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const rows = await db.insert(laps).values([
    { sessionId: session.id, lapNumber: 1, lapTime: 90, isValid: true, classification: "pace" },
    { sessionId: session.id, lapNumber: 2, lapTime: 80, isValid: true, classification: "caution" },
    { sessionId: session.id, lapNumber: 3, lapTime: 81, isValid: true, classification: "pit_lap" },
    { sessionId: session.id, lapNumber: 4, lapTime: 82, isValid: true, classification: "grid_start" },
    { sessionId: session.id, lapNumber: 5, lapTime: 91, isValid: true, classification: null },
    { sessionId: session.id, lapNumber: 6, lapTime: 0, isValid: true, classification: "pace" },
    { sessionId: session.id, lapNumber: 7, lapTime: 1, isValid: true, classification: "pace" },
    { sessionId: session.id, lapNumber: 8, lapTime: -1, isValid: true, classification: "pace" },
    { sessionId: session.id, lapNumber: 9, lapTime: 70, isValid: false, classification: "pace" },
    { sessionId: session.id, lapNumber: 10, lapTime: Number.MAX_VALUE, isValid: true, classification: "pace" },
  ]).returning({ id: laps.id, classification: laps.classification }).all();
  const infinite = rows[6]!;
  await client.execute({ sql: "UPDATE laps SET lap_time=1e999 WHERE id=?", args: [infinite.id] });

  const best = await getReviewLaps("acc", null, null, 1, session.id);
  expect(best.map((lap) => lap.id)).toEqual([rows[0]!.id]);
  const candidates = await getReviewLaps("acc", null, null, 20, session.id);
  expect(candidates.map((lap) => lap.id)).toEqual([rows[0]!.id, rows[4]!.id, rows[9]!.id]);

  const inventory = await getSessionLaps("acc", session.id);
  expect(inventory).toHaveLength(rows.length);
  expect(new Set(inventory.map((lap) => lap.id))).toEqual(new Set(rows.map((row) => row.id)));
  const byIds = await getLapsByIds(rows.map((row) => row.id));
  expect(new Set(byIds.map((lap) => lap.id))).toEqual(new Set(rows.map((row) => row.id)));
});
