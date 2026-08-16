import { afterEach, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/db";
import { experimentActions, experiments, laps, sessions } from "../../server/db/schema";
import { lapRoutes } from "../../server/routes/laps";

const createdExperimentIds: number[] = [];
const createdSessionIds: number[] = [];

afterEach(async () => {
  if (createdExperimentIds.length > 0) {
    await db.delete(experimentActions).where(inArray(experimentActions.experimentId, createdExperimentIds)).run();
  }
  if (createdSessionIds.length > 0) {
    await db.delete(laps).where(inArray(laps.sessionId, createdSessionIds)).run();
    await db.delete(sessions).where(inArray(sessions.id, createdSessionIds)).run();
    createdSessionIds.length = 0;
  }
  if (createdExperimentIds.length > 0) {
    await db.delete(experiments).where(inArray(experiments.id, createdExperimentIds)).run();
    createdExperimentIds.length = 0;
  }
});

async function postExclusion(lapId: number, body: unknown): Promise<Response> {
  return lapRoutes.request(`/api/laps/${lapId}/experiment-excluded`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("manual exclusion mutates and logs only owned laps in supplied experiment scope", async () => {
  const insertedExperiments = await db
    .insert(experiments)
    .values([
      { gameId: "iracing", name: "owned scope", trackOrdinal: 9_301_001 },
      { gameId: "iracing", name: "wrong experiment", trackOrdinal: 9_301_001 },
      { gameId: "acc", name: "wrong game", trackOrdinal: 9_301_001 },
      { gameId: "iracing", name: "wrong track", trackOrdinal: 9_301_002 },
    ])
    .returning({ id: experiments.id })
    .all();
  const [ownedExperiment, wrongExperiment, wrongGameExperiment, wrongTrackExperiment] = insertedExperiments;
  createdExperimentIds.push(...insertedExperiments.map((row) => row.id));

  const insertedSessions = await db
    .insert(sessions)
    .values([
      { gameId: "iracing", carOrdinal: 9_301_000, trackOrdinal: 9_301_001, ownership: "mine" },
      { gameId: "iracing", carOrdinal: 9_301_000, trackOrdinal: 9_301_001, ownership: "others" },
    ])
    .returning({ id: sessions.id })
    .all();
  const [ownedSession, otherSession] = insertedSessions;
  createdSessionIds.push(...insertedSessions.map((row) => row.id));

  const insertedLaps = await db
    .insert(laps)
    .values([
      { sessionId: ownedSession!.id, experimentId: ownedExperiment!.id, lapNumber: 1, lapTime: 90_000 },
      { sessionId: ownedSession!.id, experimentId: ownedExperiment!.id, lapNumber: 2, lapTime: 90_100 },
      { sessionId: ownedSession!.id, experimentId: wrongGameExperiment!.id, lapNumber: 3, lapTime: 90_200 },
      { sessionId: ownedSession!.id, experimentId: wrongTrackExperiment!.id, lapNumber: 4, lapTime: 90_300 },
      { sessionId: otherSession!.id, experimentId: ownedExperiment!.id, lapNumber: 5, lapTime: 90_400 },
      { sessionId: ownedSession!.id, experimentId: ownedExperiment!.id, lapNumber: 6, lapTime: 90_500 },
      { sessionId: ownedSession!.id, experimentId: ownedExperiment!.id, lapNumber: 7, lapTime: 90_600 },
    ])
    .returning({ id: laps.id })
    .all();
  const [validLap, wrongExperimentLap, wrongGameLap, wrongTrackLap, otherOwnedLap, missingScopeLap, changedMembershipLap] = insertedLaps;

  expect((await postExclusion(validLap!.id, { experimentId: ownedExperiment!.id, excluded: true })).status).toBe(200);
  expect(await db.select({ excluded: laps.experimentExcluded, source: laps.experimentExcludedSource }).from(laps).where(eq(laps.id, validLap!.id)).get()).toEqual({
    excluded: 1,
    source: "manual",
  });
  expect(
    await db.select({ experimentId: experimentActions.experimentId, kind: experimentActions.kind }).from(experimentActions).where(eq(experimentActions.experimentId, ownedExperiment!.id)).all(),
  ).toEqual([{ experimentId: ownedExperiment!.id, kind: "set-lap-excluded" }]);

  expect((await postExclusion(wrongExperimentLap!.id, { experimentId: wrongExperiment!.id, excluded: true })).status).toBe(404);
  expect((await postExclusion(wrongGameLap!.id, { experimentId: wrongGameExperiment!.id, excluded: true })).status).toBe(404);
  expect((await postExclusion(wrongTrackLap!.id, { experimentId: wrongTrackExperiment!.id, excluded: true })).status).toBe(404);
  expect((await postExclusion(otherOwnedLap!.id, { experimentId: ownedExperiment!.id, excluded: true })).status).toBe(404);
  expect((await postExclusion(missingScopeLap!.id, { excluded: true })).status).toBe(400);

  await db.update(laps).set({ experimentId: wrongExperiment!.id }).where(eq(laps.id, changedMembershipLap!.id)).run();
  expect((await postExclusion(changedMembershipLap!.id, { experimentId: ownedExperiment!.id, excluded: true })).status).toBe(404);

  const rejectedIds = insertedLaps.slice(1).map((row) => row.id);
  expect(await db.select({ id: laps.id, excluded: laps.experimentExcluded, source: laps.experimentExcludedSource }).from(laps).where(inArray(laps.id, rejectedIds)).orderBy(laps.id).all()).toEqual(
    rejectedIds.map((id) => ({ id, excluded: null, source: null })),
  );
  expect((await db.select({ id: experimentActions.id }).from(experimentActions).all()).length).toBe(1);
});
