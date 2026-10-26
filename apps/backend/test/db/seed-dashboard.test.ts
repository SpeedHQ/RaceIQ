import { afterEach, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { getDashboard } from "@raceiq/backend-core/db/dashboard-queries";
import { prepareDashboardPublicationCandidate, publishDashboardSession } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { repairDemoDashboardAttribution } from "@raceiq/tooling-data/data/seed-db-demo";
import { SEED_MARKER } from "@raceiq/tooling-data/data/seed-db-options";

const sessionIds: number[] = [];
afterEach(async () => {
  for (const id of sessionIds.splice(0)) {
    await deleteSession(id);
    const candidate = await prepareDashboardPublicationCandidate(id);
    if (candidate) await publishDashboardSession(candidate);
  }
});

test("existing demo laps populate the dashboard without crediting real or native activity", async () => {
  const createdAt = "2026-10-25 12:00:00";
  const add = async (values: Partial<typeof sessions.$inferInsert>) => {
    const session = await db.insert(sessions).values({
      gameId: "fm-2023", carId: "7", trackId: "8", ownership: "mine", createdAt, ...values,
    }).returning().get();
    sessionIds.push(session.id);
    return session;
  };
  const demo = await add({ notes: SEED_MARKER });
  const real = await add({ notes: null });
  const native = await add({ notes: SEED_MARKER, nativeCaptureOrigin: true });
  const borrowed = await add({ notes: SEED_MARKER, ownership: "others" });
  await db.insert(laps).values([
    { sessionId: demo.id, lapNumber: 1, lapTime: 90, isValid: true, createdAt },
    { sessionId: demo.id, lapNumber: 2, lapTime: 60, isValid: false, createdAt },
    { sessionId: demo.id, lapNumber: 3, lapTime: 0, isValid: false, createdAt },
    { sessionId: demo.id, lapNumber: 4, lapTime: 80, isValid: true, driverAttribution: "Other", createdAt },
    ...[real, native, borrowed].map((session) => ({ sessionId: session.id, lapNumber: 1, lapTime: 45, isValid: true, createdAt })),
  ]).run();
  const request = { from: "2026-10-19T00:00:00Z", to: "2026-10-27T00:00:00Z" };
  expect((await getDashboard(request)).recentSessions.some((session) => session.id === demo.id)).toBe(false);
  expect(await repairDemoDashboardAttribution()).toBe(2);
  const dashboard = await getDashboard(request);
  const recent = dashboard.recentSessions.find((session) => session.id === demo.id);
  expect(recent?.lapCount).toBe(2);
  expect(dashboard.cards["fm-2023"].drivenSeconds).toBe(150);
  expect(dashboard.recentSessions.some((session) => [real.id, native.id, borrowed.id].includes(session.id))).toBe(false);
  const before = await db.select().from(laps).where(inArray(laps.sessionId, sessionIds)).all();
  expect(before.find((lap) => lap.sessionId === demo.id && lap.lapNumber === 4)?.driverAttribution).toBe("Other");
  expect(before.filter((lap) => lap.sessionId !== demo.id).every((lap) => lap.driverAttributionStints == null)).toBe(true);
  expect(await repairDemoDashboardAttribution()).toBe(0);
  expect(await db.select().from(laps).where(inArray(laps.sessionId, sessionIds)).all()).toEqual(before);
  const unchanged = await db.select().from(sessions).where(eq(sessions.id, demo.id)).get();
  expect(unchanged?.originalActivityId).toBeNull();
  expect(unchanged?.ownerUserId).toBeNull();
  expect(unchanged?.nativeCaptureOrigin).toBe(false);
});
