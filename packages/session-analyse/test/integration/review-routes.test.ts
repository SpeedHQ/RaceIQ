import { afterEach, expect, test } from "bun:test";
import { createSessionAnalyseRoutes } from "@raceiq/session-analyse/server";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { cacheDelete, cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { deleteSession, insertSession, updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";

const routes = createSessionAnalyseRoutes(async () => []);
const sessions: number[] = [];
const cachedLaps: number[] = [];
afterEach(async () => {
  for (const id of cachedLaps.splice(0)) cacheDelete(id);
  for (const id of sessions.splice(0)) await deleteSession(id);
});

test("review route returns top valid metadata laps and excludes captures without raw recording", async () => {
  const sessionId = await insertSession("10", "20", "acc");
  const withoutCapture = await insertSession("10", "20", "acc");
  sessions.push(sessionId, withoutCapture);
  await updateSessionRawFile(sessionId, "review-capture.bin", "test");
  await insertLap(withoutCapture, 1, 50, true, null, 0, null, null, null, null, null);
  const ids = await Promise.all([61, 59, 62, 58, 60, 57, 57].map((time, index) => insertLap(sessionId, index + 1, time, true, null, 0, null, null, null, null, null)));

  const response = await routes.request("/api/laps/review?gameId=acc&trackId=20&carId=10");
  expect(response.status).toBe(200);
  const body = await response.json() as { id: number; lapTime: number }[];
  expect(body.map((lap) => lap.lapTime)).toEqual([57, 57, 58, 59, 60]);
  expect(body.map((lap) => lap.id)).toEqual([ids[6], ids[5], ids[3], ids[1], ids[4]]);
});

test("review line-spread fallback handles empty, insufficient, and non-resampleable telemetry", async () => {
  const sessionId = await insertSession("10", "20", "acc");
  sessions.push(sessionId);
  await updateSessionRawFile(sessionId, "/virtual/review-line-spread.bin", "test");
  const empty = await insertLap(sessionId, 1, 61, true, null, 0, null, null, null, null, null);
  const short = await insertLap(sessionId, 2, 62, true, 12, 29, null, null, null, null, null);
  const noDistance = await insertLap(sessionId, 3, 63, true, 41, 30, null, null, null, null, null);
  const moving = await insertLap(sessionId, 4, 64, true, 71, 30, null, null, null, null, null);
  cachedLaps.push(short, noDistance, moving);
  const makePackets = (count: number, movingDistance: boolean) => Array.from({ length: count }, (_, index) => packet("acc", {
    DistanceTraveled: movingDistance ? index : 0,
    CurrentLap: index,
    TimestampMS: index * 1_000,
    PositionX: 0,
    PositionZ: 0,
  }));
  cacheSet(short, makePackets(29, true));
  cacheSet(noDistance, makePackets(30, false));
  cacheSet(moving, makePackets(30, true));

  const emptyResponse = await routes.request(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=${empty}`);
  expect(await emptyResponse.json()).toMatchObject({ fracs: [], spreadM: [], perCorner: [], consistencyScore: 0, overallSpreadM: 0, lapCount: 0 });
  const shortResponse = await routes.request(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=${short}`);
  expect(await shortResponse.json()).toMatchObject({ fracs: [], spreadM: [], perCorner: [], consistencyScore: 0, overallSpreadM: 0, lapCount: 0 });
  const noTraceResponse = await routes.request(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=${noDistance},${moving}`);
  expect(await noTraceResponse.json()).toMatchObject({ fracs: [], spreadM: [], perCorner: [], consistencyScore: 0, overallSpreadM: 0, lapCount: 2 });
});
