import { afterEach, expect, test } from "bun:test";
import { createSessionAnalyseRoutes } from "@raceiq/session-analyse/server";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { db } from "@raceiq/backend-core/db/index";
import { sessionCaptureSplitJobs } from "@raceiq/backend-core/db/schema";
import { cacheDelete, cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { deleteSession, insertSession, updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import { eq } from "drizzle-orm";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";

const routes = createSessionAnalyseRoutes(async () => []);
const sessions: number[] = [];
const cachedLaps: number[] = [];
afterEach(async () => {
  for (const id of cachedLaps.splice(0)) cacheDelete(id);
  for (const id of sessions.splice(0)) await deleteSession(id);
});

async function setCaptureStatus(sessionId: number, status: "queued" | "failed") {
  await db.insert(sessionCaptureSplitJobs).values({
    sessionId,
    jobId: `review-route-${sessionId}`,
    pendingSourceRevision: "test-source-revision",
    sourcePath: "review-capture.bin",
    status,
    errorMessage: status === "failed" ? "Internal worker detail" : null,
  });
}

test("review route returns top valid metadata laps and excludes captures without raw recording", async () => {
  const sessionId = await insertSession("10", "20", "acc");
  const withoutCapture = await insertSession("10", "20", "acc");
  sessions.push(sessionId, withoutCapture);
  await updateSessionRawFile(sessionId, "review-capture.bin", "test");
  await setCaptureStatus(sessionId, "queued");
  await insertLap(withoutCapture, 1, 50, true, null, 0, null, null, null, null, null);
  const ids = await Promise.all([61, 59, 62, 58, 60, 57, 57].map((time, index) => insertLap(sessionId, index + 1, time, true, null, 0, null, null, null, null, null)));

  const response = await routes.request("/api/laps/review?gameId=acc&trackId=20&carId=10");
  expect(response.status).toBe(200);
  const body = await response.json() as { id: number; lapTime: number; processing: { state: string; stage: string | null; error: string | null } }[];
  expect(body.map((lap) => lap.lapTime)).toEqual([57, 57, 58, 59, 60]);
  expect(body.map((lap) => lap.id)).toEqual([ids[6], ids[5], ids[3], ids[1], ids[4]]);
  expect(body.every((lap) => lap.processing.state === "queued" && lap.processing.stage === "capture" && lap.processing.error === null)).toBe(true);
});

test("review metadata reports ready for completed non-LMU recordings", async () => {
  const sessionId = await insertSession("10", "21", "acc");
  sessions.push(sessionId);
  await updateSessionRawFile(sessionId, "review-ready-capture.bin", "test");
  await insertLap(sessionId, 1, 60, true, null, 0, null, null, null, null, null);

  const response = await routes.request(`/api/laps/review?gameId=acc&sessionId=${sessionId}`);
  expect(response.status).toBe(200);
  const [lap] = await response.json() as { processing: { state: string; stage: string | null; error: string | null } }[];
  expect(lap?.processing).toEqual({ state: "ready", stage: null, error: null });
});


test("review line-spread validates lap ownership before processing readiness and blocks heavy reads", async () => {
  const sessionId = await insertSession("10", "20", "acc");
  const foreignSessionId = await insertSession("10", "20", "acc");
  sessions.push(sessionId, foreignSessionId);
  await insertLap(sessionId, 1, 61, true, null, 0, null, null, null, null, null);
  await updateSessionRawFile(foreignSessionId, "review-capture.bin", "test");
  const queuedLap = await insertLap(foreignSessionId, 1, 62, true, null, 0, null, null, null, null, null);
  await setCaptureStatus(foreignSessionId, "queued");

  const foreignResponse = await routes.request(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=${queuedLap}`);
  expect(foreignResponse.status).toBe(400);
  expect(await foreignResponse.json()).toEqual({ error: "Selected laps must belong to session." });

  const queuedResponse = await routes.request(`/api/laps/review-line-spread?gameId=acc&sessionId=${foreignSessionId}&lapIds=${queuedLap}`);
  expect(queuedResponse.status).toBe(409);
  expect(await queuedResponse.json()).toEqual({ code: "RECORDING_PROCESSING", error: "Recording is queued or processing" });

  await db.update(sessionCaptureSplitJobs)
    .set({ status: "failed", errorMessage: "Internal worker detail" })
    .where(eq(sessionCaptureSplitJobs.sessionId, foreignSessionId))
    .run();
  const failedResponse = await routes.request(`/api/laps/review-line-spread?gameId=acc&sessionId=${foreignSessionId}&lapIds=${queuedLap}`);
  expect(failedResponse.status).toBe(422);
  const failedBody = await failedResponse.json() as { code: string; error: string };
  expect(failedBody.code).toBe("RECORDING_PROCESSING_FAILED");
  expect(failedBody.error.trim().length).toBeGreaterThan(0);
  expect(failedBody.error).not.toContain("Internal worker detail");

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
