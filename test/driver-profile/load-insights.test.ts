import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deleteSession, insertSession } from "@raceiq/backend-core/db/session-queries";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { db } from "@raceiq/backend-core/db/index";
import { lapMetrics } from "@raceiq/backend-core/db/schema";
import { loadDriverProfile } from "@raceiq/backend-core/driver-profile/load";
import { driverRoutes } from "@raceiq/backend-core/routes/driver-routes";
import { STATIC_LAP_ANALYSIS_VERSION } from "@raceiq/backend-core/lap-analysis/insights";
import { getOrComputeLapMetrics, getOrComputeLapMetricsBatch, getOrComputeLapInsightsBatch, recomputeLapInsights } from "@raceiq/backend-core/lap-analysis/metrics-store";
import { initServerGameAdapters } from "@raceiq/backend-core/games/init";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

const sessions: number[] = [];
afterEach(async () => {
  for (const id of sessions.splice(0)) await deleteSession(id);
});

test("explicit profile request restores missing and stale detector evidence without computing during background refresh", async () => {
  initServerGameAdapters();
  const sessionId = await insertSession(1, 2, "fm-2023");
  sessions.push(sessionId);
  const lapId = await insertLap(sessionId, 1, 90, true, null, 0);
  cacheSet(lapId, Array.from({ length: 60 }, (_, i) => ({
    gameId: "fm-2023", TimestampMS: i * 1000 / 30, IsRaceOn: 1,
    Speed: 25, Steer: 0, Accel: 0, Brake: 0, Clutch: 0, HandBrake: 0,
    Gear: 3, AccelerationX: 0, AngularVelocityY: 0,
  } as TelemetryPacket)));

  const background = await loadDriverProfile({ gameId: "fm-2023" });
  expect(background.detectors.some((detector) => detector.id === "driving-coasting")).toBe(false);
  expect(await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get()).toBeUndefined();

  const response = await driverRoutes.request("/api/drivers/profile", { headers: { "X-Game-Id": "fm-2023" } });
  expect(response.status).toBe(200);
  const result = await response.json() as { fingerprint: { detectors: { id: string }[] } };
  expect(result.fingerprint.detectors.some((detector) => detector.id === "driving-coasting")).toBe(true);
  const current = await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get();
  expect(current?.insightVersion).toBe(STATIC_LAP_ANALYSIS_VERSION);

  await db.update(lapMetrics).set({ insightVersion: STATIC_LAP_ANALYSIS_VERSION - 1, insights: "[]" }).where(eq(lapMetrics.lapId, lapId));
  const refreshed = await loadDriverProfile({ gameId: "fm-2023", computeMissingInsights: true });
  expect(refreshed.detectors.some((detector) => detector.id === "driving-coasting")).toBe(true);
  expect((await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get())?.insightVersion).toBe(STATIC_LAP_ANALYSIS_VERSION);
});

test("concurrent metric reads and forced insight reruns leave current evidence persisted", async () => {
  initServerGameAdapters();
  const sessionId = await insertSession(1, 2, "fm-2023");
  sessions.push(sessionId);
  const lapId = await insertLap(sessionId, 1, 90, true, null, 0);
  cacheSet(lapId, Array.from({ length: 60 }, (_, i) => ({
    gameId: "fm-2023", TimestampMS: i * 1000 / 30, IsRaceOn: 1,
    Speed: 25, Steer: 0, Accel: 0, Brake: 0, Clutch: 0, HandBrake: 0,
    Gear: 3, AccelerationX: 0, AngularVelocityY: 0,
  } as TelemetryPacket)));

  const [metrics, rerun, batchMetrics, batchInsights] = await Promise.all([
    getOrComputeLapMetrics(lapId),
    recomputeLapInsights(lapId),
    getOrComputeLapMetricsBatch([lapId]),
    getOrComputeLapInsightsBatch([lapId]),
  ]);
  expect(metrics?.insights.some((item) => item.id === "driving-coasting")).toBe(true);
  expect(rerun?.some((item) => item.id === "driving-coasting")).toBe(true);
  expect(batchMetrics.get(lapId)?.insights.some((item) => item.id === "driving-coasting")).toBe(true);
  expect(batchInsights.get(lapId)?.some((item) => item.id === "driving-coasting")).toBe(true);
  const row = await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get();
  expect(row?.insightVersion).toBe(STATIC_LAP_ANALYSIS_VERSION);
  expect(JSON.parse(row!.insights).some((item: { id: string }) => item.id === "driving-coasting")).toBe(true);
});
