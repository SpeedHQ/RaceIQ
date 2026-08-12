import { afterEach, expect, test } from "bun:test";
import type { GameId } from "../../shared/games/ids";
import { eq, sql } from "drizzle-orm";
import { getLapStats, getLapMetaForProfileScope, getLaps } from "../../server/db/lap-read-queries";
import { deleteSession, getSessions, insertSession } from "../../server/db/session-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { db } from "../../server/db";
import { sessions } from "../../server/db/schema";

const sessionIds: number[] = [];
const testGameId = "lap-ownership-test" as GameId;
afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
});

test("owned stats and profile pool exclude others while general reads preserve ownership", async () => {
  const mine = await insertSession(1, 2, testGameId, "race", undefined, "mine");
  const others = await insertSession(1, 2, testGameId, "race", undefined, "others");
  sessionIds.push(mine, others);
  await insertLap(mine, 1, 90_000, true, null, 0);
  await insertLap(others, 1, 80_000, true, null, 0);

  const stats = await getLapStats(testGameId);
  expect(stats.totalLaps).toBe(1);
  expect(stats.totalTimeSec).toBe(90_000);
  const profile = await getLapMetaForProfileScope(testGameId);
  expect(profile.map((lap) => lap.sessionId)).toEqual([mine]);
  expect(profile[0]?.ownership).toBe("mine");

  const laps = await getLaps(testGameId);
  expect(laps.map((lap) => lap.ownership).sort()).toEqual(["mine", "others"]);
  const sessionsRead = await getSessions(testGameId);
  expect(sessionsRead.map((session) => session.ownership).sort()).toEqual(["mine", "others"]);
});

test("legacy null ownership normalizes to mine at read boundary", async () => {
  const id = await insertSession(3, 4, testGameId);
  sessionIds.push(id);
  await db.update(sessions).set({ ownership: sql`'legacy'` }).where(eq(sessions.id, id)).run();
  await insertLap(id, 1, 100_000, true, null, 0);
  expect((await getSessions(testGameId)).find((session) => session.id === id)?.ownership).toBe("mine");
  expect((await getLaps(testGameId)).find((lap) => lap.sessionId === id)?.ownership).toBe("mine");
});
