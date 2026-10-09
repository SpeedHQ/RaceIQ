import { afterEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { GameId } from "@raceiq/shared/games/ids";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { prepareDashboardPublicationCandidate, publishDashboardSession } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { getDashboardSessionRecap } from "@raceiq/backend-core/db/dashboard-recap-queries";

const ids: number[] = [];
const gameId = "fm-2023" as GameId;
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteSession(id);
});

async function addSession(ownership: "mine" | "others", carOrdinal = 7, trackOrdinal = 8): Promise<number> {
  const row = await db.insert(sessions).values({
    gameId, ownership, carOrdinal, trackOrdinal, createdAt: "2026-06-01T12:00:00.000Z",
  }).returning({ id: sessions.id }).get();
  ids.push(row.id);
  return row.id;
}

async function addLap(sessionId: number, lapNumber: number, lapTime: number, sectorTimes: number[] | null = null): Promise<void> {
  await db.insert(laps).values({ sessionId, lapNumber, lapTime, isValid: true, sectorTimes, createdAt: "2026-06-01T12:00:00.000Z" }).run();
}
async function publishSectors(sessionId: number, layoutKey: string): Promise<void> {
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  if (!candidate) throw new Error("Missing dashboard publication candidate");
  const starts = [0, 1 / 3, 2 / 3];
  const published = await publishDashboardSession(candidate, {
    sourceRevision: candidate.sourceRevision,
    captureRevision: `test-${sessionId}`,
    duration: { status: "unavailable", elapsedSeconds: null },
    sectorLayout: { status: "available", key: layoutKey, sectorCount: 3, starts },
    weather: { status: "unavailable", revision: null, conditions: null },
    trackLengthMeters: null,
    sourceSectorStarts: starts,
  });
  if (!published) throw new Error("Dashboard recap fixture publication failed");
}


test("dashboard recap compares against mine sessions only and excludes current session", async () => {
  const priorMine = await addSession("mine");
  const fasterOthers = await addSession("others");
  const current = await addSession("mine");
  await db.update(sessions).set({ carId: "7", trackId: "8" }).where(eq(sessions.id, priorMine)).run();
  await addLap(priorMine, 1, 90, [30, 30, 30]);
  await addLap(fasterOthers, 1, 50, [10, 20, 20]);
  await addLap(current, 1, 80, [25, 30, 25]);
  const conflictingNativeId = await addSession("mine");
  await db.update(sessions).set({ carId: "9", trackId: "8" }).where(eq(sessions.id, conflictingNativeId)).run();
  await addLap(conflictingNativeId, 1, 40, [5, 15, 20]);
  await publishSectors(conflictingNativeId, "test-layout");
  await db.update(laps).set({ lapTime: 39 }).where(eq(laps.sessionId, conflictingNativeId)).run();
  const incompatibleLayout = await addSession("mine");
  await addLap(incompatibleLayout, 1, 100, [12, 25, 23]);
  await publishSectors(incompatibleLayout, "different-layout-same-count");
  await publishSectors(priorMine, "test-layout");
  await publishSectors(current, "test-layout");

  const recap = await getDashboardSessionRecap(current, gameId);
  expect(recap?.personalBest).toEqual({ isNew: true, previousBestSec: 90 });
  expect(recap?.sectors?.map((sector) => sector.allTimeBestSec)).toEqual([30, 30, 30]);
  await db.update(laps).set({ isValid: false }).where(eq(laps.sessionId, priorMine));
  const afterWinnerInvalidation = await getDashboardSessionRecap(current, gameId);
  expect(afterWinnerInvalidation?.personalBest).toEqual({ isNew: true, previousBestSec: 100 });
  expect(afterWinnerInvalidation?.sectors?.map((sector) => sector.allTimeBestSec)).toEqual([null, null, null]);
});

test("dashboard recap returns null for others, unknown ownership, and deleted sessions", async () => {
  const others = await addSession("others");
  const unknown = await addSession("mine");
  await db.update(sessions).set({ ownership: sql`'unrecognized'` }).where(eq(sessions.id, unknown)).run();
  const missing = await addSession("mine");
  await addLap(others, 1, 70);
  await addLap(unknown, 1, 60);
  await addLap(missing, 1, 80);
  await deleteSession(missing);
  ids.splice(ids.indexOf(missing), 1);

  expect(await getDashboardSessionRecap(others, gameId)).toBeNull();
  expect(await getDashboardSessionRecap(unknown, gameId)).toBeNull();
  expect(await getDashboardSessionRecap(missing, gameId)).toBeNull();
});

test("ordinal zero remains known while unknown ordinal does not become zero", async () => {
  const current = await addSession("mine", 0, 0);
  const unknown = await addSession("mine", -1, -1);
  await addLap(current, 1, 80);
  await addLap(unknown, 1, 20);
  const recap = await getDashboardSessionRecap(current, gameId);
  expect(recap?.personalBest).toEqual({ isNew: true, previousBestSec: null });
});

test("dashboard recap preserves zero lap times in sparkline without treating them as valid", async () => {
  const current = await addSession("mine");
  await addLap(current, 1, 0);
  const recap = await getDashboardSessionRecap(current, gameId);
  expect(recap?.lapsTotal).toBe(1);
  expect(recap?.lapsValid).toBe(0);
  expect(recap?.bestLapSec).toBeNull();
});
