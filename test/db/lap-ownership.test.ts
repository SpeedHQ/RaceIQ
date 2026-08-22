import { afterEach, expect, test } from "bun:test";
import type { GameId } from "../../shared/games/ids";
import { eq, sql } from "drizzle-orm";
import { getLapById, getLapsByIds, getLapStats, getLapMetaForPitHistory, getLapMetaForProfileScope, getLaps } from "../../server/db/lap-read-queries";
import { deleteSession, getSessions, insertSession } from "../../server/db/session-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";

const sessionIds: number[] = [];
const testGameId = "lap-ownership-test" as GameId;
async function insertTestLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  analysisGenerationId?: string,
): Promise<number> {
  return insertLap({
    sessionId,
    lapNumber,
    lapTime,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 0,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    classification: {
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    },
    quality: null,
    eligibility: null,
    analysisGenerationId,
  });
}
afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
});

test("single and batch lap reads expose stored analysis generation", async () => {
  const sessionId = await insertSession(5, 6, "iracing", "race");
  sessionIds.push(sessionId);
  const analysisGenerationId = `analysis-generation:${crypto.randomUUID()}`;
  const lapId = await insertTestLap(sessionId, 1, 90, analysisGenerationId);

  expect((await getLapById(lapId))?.analysisGenerationId).toBe(analysisGenerationId);
  expect((await getLapsByIds([lapId]))[0]?.analysisGenerationId).toBe(analysisGenerationId);
});

test("owned stats and profile pool exclude others while general reads preserve ownership", async () => {
  const mine = await insertSession(1, 2, testGameId, "race", undefined, "mine");
  const others = await insertSession(1, 2, testGameId, "race", undefined, "others");
  sessionIds.push(mine, others);
  await insertTestLap(mine, 1, 90_000);
  await insertTestLap(others, 1, 80_000);

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
  await insertTestLap(id, 1, 100_000);
  expect((await getSessions(testGameId)).find((session) => session.id === id)?.ownership).toBe("mine");
  expect((await getLaps(testGameId)).find((lap) => lap.sessionId === id)?.ownership).toBe("mine");
});

test("scoped pit history applies ownership, manual exclusion, and full scope before limit", async () => {
  const owned = await insertSession(10, 20, testGameId, "race", undefined, "mine");
  const opponent = await insertSession(10, 20, testGameId, "race", undefined, "others");
  const wrongCar = await insertSession(11, 20, testGameId, "race", undefined, "mine");
  const wrongTrack = await insertSession(10, 21, testGameId, "race", undefined, "mine");
  const wrongGame = await insertSession(10, 20, "acc", "race", undefined, "mine");
  sessionIds.push(owned, opponent, wrongCar, wrongTrack, wrongGame);

  const oldest = await insertTestLap(owned, 1, 90);
  const autoExcluded = await insertTestLap(owned, 2, 91);
  const manuallyIncluded = await insertTestLap(owned, 3, 92);
  const manuallyExcluded = await insertTestLap(owned, 4, 93);
  const opponentLap = await insertTestLap(opponent, 5, 94);
  const wrongPi = await insertTestLap(owned, 6, 95);
  const wrongCarLap = await insertTestLap(wrongCar, 7, 96);
  const wrongTrackLap = await insertTestLap(wrongTrack, 8, 97);
  const wrongGameLap = await insertTestLap(wrongGame, 9, 98);

  await db.update(laps).set({ pi: 700 }).where(eq(laps.id, oldest)).run();
  await db.update(laps).set({ pi: 700, experimentExcluded: 1, experimentExcludedSource: "auto" }).where(eq(laps.id, autoExcluded)).run();
  await db.update(laps).set({ pi: 700, experimentExcluded: null, experimentExcludedSource: "manual" }).where(eq(laps.id, manuallyIncluded)).run();
  await db.update(laps).set({ pi: 700, experimentExcluded: 1, experimentExcludedSource: "manual" }).where(eq(laps.id, manuallyExcluded)).run();
  for (const id of [opponentLap, wrongCarLap, wrongTrackLap, wrongGameLap]) {
    await db.update(laps).set({ pi: 700 }).where(eq(laps.id, id)).run();
  }
  await db.update(laps).set({ pi: 701 }).where(eq(laps.id, wrongPi)).run();

  const result = await getLapMetaForPitHistory(20, 10, 700, testGameId, 2);
  expect(result.map(({ id }) => id)).toEqual([manuallyIncluded, autoExcluded]);
});

test("profile scope shares manual and ownership boundary while retaining invalid non-pace rows", async () => {
  const owned = await insertSession(30, 40, testGameId, "race", undefined, "mine");
  const opponent = await insertSession(30, 40, testGameId, "race", undefined, "others");
  sessionIds.push(owned, opponent);

  const autoExcluded = await insertTestLap(owned, 1, 90);
  const manuallyIncluded = await insertTestLap(owned, 2, 91);
  const manuallyExcluded = await insertTestLap(owned, 3, 92);
  const invalid = await insertTestLap(owned, 4, 93);
  const nonPace = await insertTestLap(owned, 5, 94);
  await insertTestLap(opponent, 6, 95);

  await db.update(laps).set({ experimentExcluded: 1, experimentExcludedSource: "auto" }).where(eq(laps.id, autoExcluded)).run();
  await db.update(laps).set({ experimentExcluded: null, experimentExcludedSource: "manual" }).where(eq(laps.id, manuallyIncluded)).run();
  await db.update(laps).set({ experimentExcluded: 1, experimentExcludedSource: "manual" }).where(eq(laps.id, manuallyExcluded)).run();
  await db.update(laps).set({ isValid: false }).where(eq(laps.id, invalid)).run();
  await db.update(laps).set({ paceEligibility: "excluded", phase: "out" }).where(eq(laps.id, nonPace)).run();

  const result = await getLapMetaForProfileScope(testGameId, 30, 40);
  expect(result.map(({ id }) => id)).toEqual([nonPace, invalid, manuallyIncluded, autoExcluded]);
  expect(result.find(({ id }) => id === invalid)?.isValid).toBe(false);
  expect(result.find(({ id }) => id === nonPace)?.paceEligibility).toBe("excluded");
});
