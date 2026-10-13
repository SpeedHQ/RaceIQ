import { describe, expect, test } from "bun:test";
import type { DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";
import { dashboardInsights } from "../src/components/home/dashboard-insights";
import { dashboardPeriodStart } from "../src/hooks/dashboard";

test("dashboard periods use UTC boundaries independent of DST dates", () => {
  const now = new Date("2026-11-01T07:30:00.000Z");
  expect(dashboardPeriodStart(now, "today").toISOString()).toBe("2026-11-01T00:00:00.000Z");
  expect(dashboardPeriodStart(now, "week").toISOString()).toBe("2026-10-25T07:30:00.000Z");
  expect(dashboardPeriodStart(now, "month").toISOString()).toBe("2026-10-02T07:30:00.000Z");
  expect(dashboardPeriodStart(now, "year").toISOString()).toBe("2025-11-01T07:30:00.000Z");
});

const response = {
  request: { from: "2026-10-01T12:00:00.000Z", to: "2026-10-03T12:00:00.000Z" },
  revision: 1,
  coverage: { status: "complete", metadataComplete: true, mineSessions: 2, readySessions: 2, pendingSessions: 0 },
  cards: {
    "fm-2023": { laps: 0, drivenSeconds: 0 },
    "f1-2025": { laps: 0, drivenSeconds: 0 },
    acc: { laps: 0, drivenSeconds: 0 },
    "ac-evo": { laps: 0, drivenSeconds: 0 },
    iracing: { laps: 0, drivenSeconds: 0 },
    lmu: { laps: 0, drivenSeconds: 0 },
  },
  totals: { laps: 4, positiveLaps: 3, validLaps: 2, drivenSeconds: 300, validSeconds: 200, bestLapSeconds: 90, averageLapSeconds: 100, tracks: 1, cars: 1, sessions: 2 },
  calendar: [
    { day: "2026-10-01", from: "2026-10-01T12:00:00.000Z", to: "2026-10-02T00:00:00.000Z", validLaps: 1, positiveLaps: 2, cleanRate: 0.5, drivenSeconds: 200, podiums: 1 },
    { day: "2026-10-02", from: "2026-10-02T00:00:00.000Z", to: "2026-10-03T00:00:00.000Z", validLaps: 1, positiveLaps: 1, cleanRate: 1, drivenSeconds: 100, podiums: 0 },
  ],
  trackDistribution: { totalSeconds: 300, topFive: [], othersSeconds: 0, othersShare: 0, othersCount: 0 },
  favouriteTrack: null,
  favouriteCar: null,
  consistency: { sessions: 0, averageStandardDeviation: null, deviations: [] },
  sessionTypes: { shares: [], totalSeconds: 0, unknownSeconds: 0, unknownShare: 0, sessionsWithDuration: 0, sessionsWithoutDuration: 0 },
  podiums: { total: 1, first: 1, second: 0, third: 0, available: true },
  recentSessions: [],
  latestRecapSessionId: null,
} satisfies DashboardResponse;

describe("dashboard response adapter", () => {
  test("uses daily aggregates and preserves exact interval endpoints", () => {
    const result = dashboardInsights(response);
    expect(result.clean.trend.map(({ timestamp, valid, total }) => [new Date(timestamp).toISOString(), valid, total])).toEqual([
      [response.request.from, 0, 0],
      ["2026-10-02T00:00:00.000Z", 1, 2],
      ["2026-10-03T00:00:00.000Z", 2, 3],
      [response.request.to, 2, 3],
    ]);
    expect(result.podiums.trend.map(({ timestamp, podiums }) => [new Date(timestamp).toISOString(), podiums])).toEqual([
      [response.request.from, 0],
      ["2026-10-02T00:00:00.000Z", 1],
      ["2026-10-03T00:00:00.000Z", 1],
      [response.request.to, 1],
    ]);
    expect(result.clean.rate).toBe(2 / 3);
    expect(result.podiums.total).toBe(1);
  });
  test("preserves unavailable-versus-confirmed-zero podium coverage", () => {
    const result = dashboardInsights({ ...response, podiums: { total: 0, first: 0, second: 0, third: 0, available: false } });
    expect(result.podiums).toMatchObject({ total: 0, available: false });
  });
});
