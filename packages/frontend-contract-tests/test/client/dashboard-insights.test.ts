import { describe, expect, test } from "bun:test";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { buildDashboardInsights } from "client/src/components/home/dashboard-insights";

function lap(overrides: Partial<LapMeta> = {}): LapMeta {
  return {
    id: 1, sessionId: 1, lapNumber: 1, lapTime: 90, isValid: true,
    createdAt: "2026-10-05T12:00:00Z", ownership: "mine", gameId: "fm-2023",
    carId: "car-a", trackId: "track-a", ...overrides,
  };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 1, carOrdinal: 1, trackOrdinal: 1, carId: "car-a", trackId: "track-a",
    createdAt: "2026-10-05T12:00:00Z", gameId: "fm-2023", ownership: "mine",
    sessionType: "race", resultClassification: "finished", resultOutcomeStatus: "confirmed",
    finishingPosition: 1, ...overrides,
  };
}

const now = new Date("2026-10-05T12:00:00Z");

describe("buildDashboardInsights", () => {
  test("counts latest 20 timed own laps and excludes nonpositive, nonfinite and others", () => {
    const laps = Array.from({ length: 21 }, (_, id) => lap({ id, isValid: id % 2 === 0 }));
    laps.push(lap({ id: 30, lapTime: 0 }), lap({ id: 31, lapTime: Number.NaN }), lap({ id: 32, ownership: "others" }));
    expect(buildDashboardInsights(laps, [], null, now).clean).toEqual({ valid: 10, total: 20, rate: 0.5 });
  });

  test("ignores invalid and future lap timestamps", () => {
    const result = buildDashboardInsights([
      lap({ id: 1, createdAt: "invalid" }),
      lap({ id: 2, createdAt: "2026-10-05T12:00:01Z", lapTime: 70 }),
      lap({ id: 3, createdAt: "2026-10-05T11:00:00Z", lapTime: 80 }),
    ], [], null, now);
    expect(result.clean).toEqual({ valid: 1, total: 1, rate: 1 });
  });

  test("counts confirmed race podium places once and filters owner and game", () => {
    const result = buildDashboardInsights([], [
      session({ id: 1, finishingPosition: 1 }),
      session({ id: 2, finishingPosition: 2 }),
      session({ id: 3, finishingPosition: 3 }),
      session({ id: 4, ownership: "others" }),
      session({ id: 5, gameId: "acc" }),
    ], "fm-2023", now);
    expect(result.podiums).toEqual({ total: 3, first: 1, second: 1, third: 1, available: true });
  });

  test("distinguishes known zero podiums from unavailable results", () => {
    expect(buildDashboardInsights([], [session({ finishingPosition: 4 })], null, now).podiums)
      .toEqual({ total: 0, first: 0, second: 0, third: 0, available: true });
    expect(buildDashboardInsights([], [session({ resultOutcomeStatus: "unavailable" })], null, now).podiums)
      .toEqual({ total: 0, first: 0, second: 0, third: 0, available: false });
  });

  test("excludes provisional, non-race, unfinished, malformed, duplicate and future sessions", () => {
    const result = buildDashboardInsights([], [
      session({ id: 1, resultOutcomeStatus: "provisional" }),
      session({ id: 2, sessionType: "practice" }),
      session({ id: 3, sessionType: "test-day" }),
      session({ id: 4, resultClassification: "dnf" }),
      session({ id: 5, finishingPosition: 0 }),
      session({ id: 6, finishingPosition: 1.5 }),
      session({ id: 7, finishingPosition: Number.POSITIVE_INFINITY }),
      session({ id: 8, finishingPosition: Number.NaN }),
      session({ id: 9, finishingPosition: 1, createdAt: "2026-10-05T12:00:01Z" }),
      session({ id: 10, finishingPosition: 1 }),
      session({ id: 10, finishingPosition: 2 }),
    ], null, now);
    expect(result.podiums).toEqual({ total: 1, first: 1, second: 0, third: 0, available: true });
  });
});
