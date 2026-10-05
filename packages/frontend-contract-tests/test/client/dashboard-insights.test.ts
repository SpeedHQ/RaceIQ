import { describe, expect, test } from "bun:test";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { buildDashboardInsights } from "client/src/components/home/dashboard-insights";

function lap(overrides: Partial<LapMeta> = {}): LapMeta {
  return {
    id: 1,
    sessionId: 1,
    lapNumber: 1,
    lapTime: 90,
    isValid: true,
    createdAt: "2026-10-05T12:00:00Z",
    ownership: "mine",
    gameId: "fm-2023",
    carId: "car-a",
    trackId: "track-a",
    ...overrides,
  };
}

const now = new Date("2026-10-05T12:00:00Z");

describe("buildDashboardInsights", () => {
  test("counts latest 20 timed own laps and excludes nonpositive, nonfinite and others", () => {
    const laps = Array.from({ length: 21 }, (_, id) => lap({ id, isValid: id % 2 === 0 }));
    laps.push(lap({ id: 30, lapTime: 0 }), lap({ id: 31, lapTime: Number.NaN }), lap({ id: 32, ownership: "others" }));
    const result = buildDashboardInsights(laps, null, now);
    expect(result.clean).toEqual({ valid: 10, total: 20, rate: 0.5 });
  });

  test("ignores invalid timestamps and future laps across all metrics", () => {
    const result = buildDashboardInsights([
      lap({ id: 1, createdAt: "invalid" }),
      lap({ id: 2, createdAt: "2026-10-05T12:00:01Z", lapTime: 70 }),
      lap({ id: 3, createdAt: "2026-10-05T11:00:00Z", lapTime: 80 }),
    ], null, now);
    expect(result.clean).toEqual({ valid: 1, total: 1, rate: 1 });
    expect(result.pace?.latest.id).toBe(3);
    expect(result.practice.totalSeconds).toBe(80);
  });

  test("compares valid session bests only within canonical game/car/track identity", () => {
    const laps = [
      lap({ id: 1, sessionId: 1, createdAt: "2026-10-03T12:00:00Z", lapTime: 80 }),
      lap({ id: 2, sessionId: 1, lapTime: 0, isValid: true }),
      lap({ id: 3, sessionId: 2, createdAt: "2026-10-04T12:00:00Z", lapTime: 79, isValid: false }),
      lap({ id: 4, sessionId: 3, createdAt: "2026-10-05T11:00:00Z", lapTime: 77, carId: 7 }),
      lap({ id: 5, sessionId: 4, createdAt: "2026-10-05T12:00:00Z", lapTime: 75 }),
      lap({ id: 6, sessionId: 4, createdAt: "2026-10-05T12:00:00Z", lapTime: 76, gameId: "acc" }),
    ];
    const result = buildDashboardInsights(laps, "fm-2023", now);
    expect(result.pace).toEqual({ latest: laps[4], best: 75, previousBest: 80, delta: -5 });
  });

  test("latest eligible lap controls pace even when its combo has no valid timed laps", () => {
    const laps = [
      lap({ id: 1, sessionId: 1, createdAt: "2026-10-04T12:00:00Z" }),
      lap({ id: 2, sessionId: 2, createdAt: "2026-10-05T12:00:00Z", lapTime: 0, isValid: true }),
    ];
    expect(buildDashboardInsights(laps, null, now).pace).toBeNull();
  });

  test("practice sums positive own laps across seven local days, including invalid laps", () => {
    const laps = [
      lap({ id: 1, createdAt: new Date(2026, 8, 29, 12).toISOString(), lapTime: 90, isValid: false }),
      lap({ id: 2, createdAt: new Date(2026, 9, 5, 12).toISOString(), lapTime: 80 }),
      lap({ id: 3, createdAt: new Date(2026, 9, 6, 12).toISOString(), lapTime: 70 }),
      lap({ id: 4, createdAt: "invalid", lapTime: 60 }),
      lap({ id: 5, createdAt: new Date(2026, 9, 4, 12).toISOString(), lapTime: 50, ownership: "others" }),
    ];
    const result = buildDashboardInsights(laps, null, new Date(2026, 9, 5, 12));
    expect(result.practice.days.map((day) => day.date)).toEqual([
      "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
    ]);
    expect(result.practice).toMatchObject({ activeDays: 2, totalSeconds: 170 });
    expect(result.practice.days[0]).toMatchObject({ seconds: 90, laps: 1 });
    expect(result.practice.days[6]).toMatchObject({ seconds: 80, laps: 1 });
  });
});
