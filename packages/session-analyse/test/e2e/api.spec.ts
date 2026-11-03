import { expect, test } from "@playwright/test";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { isPaceLap } from "@raceiq/shared/racing/lap-classification";
import { getSeededLapMeta } from "../../../../playwright/tests/support/seeded/laps";

// These requests use Playwright's compiled application fixture and its real seeded DB.
test("review APIs validate boundaries, preserve ordering, and isolate sessions", async ({ request }) => {
  const lapsResponse = await request.get("/api/laps?gameId=acc");
  expect(lapsResponse.ok()).toBe(true);
  const laps = (await lapsResponse.json()) as LapMeta[];
  const sessions = [...new Set(laps.map((lap) => lap.sessionId).filter((id): id is number => id != null))];
  let sessionId: number | undefined;
  let review: LapMeta[] = [];
  for (const candidate of sessions) {
    const response = await request.get(`/api/laps/review?gameId=acc&sessionId=${candidate}&limit=5`);
    if (response.ok()) {
      const candidateLaps = (await response.json()) as LapMeta[];
      if (candidateLaps.length) {
        sessionId = candidate;
        review = candidateLaps;
        break;
      }
    }
  }
  expect(sessionId, "seeded DB needs reviewable ACC session").toBeDefined();
  expect(review.every((lap) => lap.sessionId === sessionId && lap.gameId === "acc" && lap.isValid && isPaceLap(lap.classification) && lap.lapTime > 0)).toBe(true);
  expect(review.map((lap) => lap.id)).toEqual([...review].sort((a, b) => a.lapTime - b.lapTime || b.id - a.id).map((lap) => lap.id));
  expect(review.length).toBeLessThanOrEqual(5);
  const precedence = await request.get(`/api/laps/review?gameId=acc&sessionId=${sessionId}&trackId=missing-track&carId=missing-car`);
  expect(precedence.status()).toBe(200);
  expect(await precedence.json()).toEqual(review);
  const single = await request.get(`/api/laps/review?gameId=acc&sessionId=${sessionId}&limit=1`);
  expect(single.status()).toBe(200);
  expect(await single.json()).toEqual(review.slice(0, 1));
  const maximum = await request.get(`/api/laps/review?gameId=acc&sessionId=${sessionId}&limit=20`);
  expect(maximum.status()).toBe(200);
  const maximumLaps = await maximum.json() as LapMeta[];
  expect(maximumLaps.length).toBeLessThanOrEqual(20);
  expect(maximumLaps.slice(0, review.length)).toEqual(review);
  expect(await (await request.get("/api/laps/review?gameId=invalid")).status()).toBe(400);
  expect(await (await request.get(`/api/laps/review?gameId=acc&sessionId=999999999`)).json()).toEqual([]);
  for (const url of [
    "/api/laps/review?sessionId=1",
    "/api/laps/review?gameId=acc",
    "/api/laps/review?gameId=acc&sessionId=0",
    `/api/laps/review?gameId=acc&sessionId=${sessionId}&limit=21`,
    `/api/laps/review?gameId=acc&sessionId=${sessionId}&limit=0`,
  ]) expect((await request.get(url)).status()).toBe(400);

  const foreignLap = await getSeededLapMeta(request, "ac-evo");
  expect(foreignLap.id).toBeGreaterThan(0);
  const chosen = review.slice(0, Math.min(2, review.length)).map((lap) => lap.id);
  const validSpread = await request.get(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=${chosen.join(",")}`);
  expect(validSpread.status()).toBe(200);
  const spread = await validSpread.json() as Record<string, unknown>;
  expect(spread).toMatchObject({ fracs: expect.any(Array), spreadM: expect.any(Array), perCorner: expect.any(Array), lapCount: expect.any(Number) });
  expect(spread).not.toHaveProperty("lapLines");
  expect(spread.lapCount).toBe(chosen.length);
  expect((await request.get(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=${review[0]!.id},${review[0]!.id}`)).status()).toBe(400);
  expect((await request.get(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=1,2,3,4,5,6`)).status()).toBe(400);
  expect((await request.get(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=999999999`)).status()).toBe(400);
  const foreignResponse = await request.get(`/api/laps/review-line-spread?gameId=acc&sessionId=${sessionId}&lapIds=${foreignLap.id}`);
  expect(foreignResponse.status()).toBe(400);
  expect(await foreignResponse.json()).toEqual({ error: "Selected laps must belong to session." });

});
