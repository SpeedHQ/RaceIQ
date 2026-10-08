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
    expect(result.podiums).toEqual({
      total: 3, first: 1, second: 1, third: 1, available: true,
      otherPositions: [],
    });
  });

  test("distinguishes known zero podiums from unavailable results", () => {
    expect(buildDashboardInsights([], [session({ finishingPosition: 4 })], null, now).podiums)
      .toEqual({ total: 0, first: 0, second: 0, third: 0, available: true, otherPositions: [{ position: 4, count: 1 }] });
    expect(buildDashboardInsights([], [session({ resultOutcomeStatus: "unavailable" })], null, now).podiums)
      .toEqual({ total: 0, first: 0, second: 0, third: 0, available: false, otherPositions: [] });
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
    expect(result.podiums).toEqual({
      total: 1, first: 1, second: 0, third: 0, available: true,
      otherPositions: [],
    });
  });

  test("counts sparse non-podium results once, sorted, only for finished race sessions", () => {
    const result = buildDashboardInsights([], [
      session({ id: 1, finishingPosition: 9 }),
      session({ id: 2, finishingPosition: 5 }),
      session({ id: 3, finishingPosition: 9 }),
      session({ id: 4, sessionType: "  PRACTICE-1 ", finishingPosition: 7 }),
      session({ id: 5, sessionType: "qualifying", finishingPosition: 6 }),
      session({ id: 6, resultClassification: "dnf", finishingPosition: 8 }),
      session({ id: 7, resultOutcomeStatus: "provisional", finishingPosition: 10 }),
      session({ id: 8, ownership: "others", finishingPosition: 11 }),
      session({ id: 9, gameId: "acc", finishingPosition: 12 }),
      session({ id: 10, createdAt: "bad", finishingPosition: 13 }),
      session({ id: 11, createdAt: "2026-10-05T12:00:01Z", finishingPosition: 14 }),
    ], "fm-2023", now);
    expect(result.podiums).toEqual({
      total: 0, first: 0, second: 0, third: 0, available: true,
      otherPositions: [{ position: 5, count: 1 }, { position: 9, count: 2 }],
    });
  });

  test("distributes recorded completed-lap time by track, including invalid laps and aggregating remaining tracks", () => {
    const laps = [
      lap({ id: 1, lapTime: 90, isValid: true, trackId: "track-1" }),
      lap({ id: 2, lapTime: 80, isValid: false, trackId: "track-1" }),
      ...Array.from({ length: 6 }, (_, index) => lap({ id: index + 3, lapTime: 70 - index, trackId: `track-${index + 2}` })),
      lap({ id: 20, lapTime: 60, trackId: "track-9" }),
      lap({ id: 1, lapTime: 900, trackId: "duplicate" }),
      lap({ id: 21, lapTime: 0 }),
      lap({ id: 22, lapTime: Number.NaN }),
      lap({ id: 23, lapTime: 100, ownership: "others" }),
    ];
    const distribution = buildDashboardInsights(laps, [], null, now).trackDistribution;
    expect(distribution.totalSeconds).toBe(90 + 80 + 70 + 69 + 68 + 67 + 66 + 65 + 60);
    expect(distribution.tracks).toHaveLength(5);
    expect(distribution.tracks.map(({ trackIdentity }) => trackIdentity)).toEqual([
      "track:string:track-1", "track:string:track-2", "track:string:track-3", "track:string:track-4", "track:string:track-5",
    ]);
    expect(distribution.othersCount).toBe(3);
    expect(distribution.othersSeconds).toBe(66 + 65 + 60);
    expect(distribution.tracks.reduce((total, track) => total + track.share, distribution.othersShare)).toBeCloseTo(1);
  });
  test("keeps track identity scoped to game", () => {
    const laps = [
      lap({ id: 1, gameId: "fm-2023", trackId: "shared", carId: "shared", lapTime: 90 }),
      lap({ id: 2, gameId: "acc", trackId: "shared", carId: "shared", lapTime: 80 }),
    ];
    const allGames = buildDashboardInsights(laps, [], null, now);
    const fmOnly = buildDashboardInsights(laps, [], "fm-2023", now);
    expect(allGames.trackDistribution.tracks).toHaveLength(2);
    expect(allGames.trackContext?.gameId).toBe("acc");
    expect(fmOnly.trackDistribution.totalSeconds).toBe(90);
    expect(fmOnly.trackContext?.gameId).toBe("fm-2023");
  });
  test("retains sentinel track time without treating sentinel IDs as comparable context", () => {
    const laps = [lap({
      trackId: null,
      trackOrdinal: -1,
      carId: null,
      carOrdinal: -1,
    })];
    const result = buildDashboardInsights(laps, [session({ trackOrdinal: -1, carOrdinal: -1 })], "fm-2023", now);
    expect(result.trackDistribution.totalSeconds).toBe(90);
    expect(result.trackDistribution.tracks[0]?.trackIdentity).toBe("track:unknown");
    expect(result.trackContext).toBeNull();
    expect(result.consistency.sessions).toBe(0);
  });

  test("averages consistency by each of the latest ten own sessions without backfilling insufficient sessions", () => {
    const laps: LapMeta[] = [];
    const sessions: SessionMeta[] = [];
    for (let id = 1; id <= 11; id += 1) {
      const createdAt = new Date(now.getTime() - (11 - id) * 1000).toISOString();
      sessions.push(session({ id, createdAt }));
      if (id === 11) {
        laps.push(lap({ id: 100 + id, sessionId: id, createdAt }));
        continue;
      }
      const spread = id === 1 ? 0.01 : (id - 1) * 0.125;
      laps.push(
        lap({ id: id * 2, sessionId: id, lapTime: 100 - spread, createdAt }),
        lap({ id: id * 2 + 1, sessionId: id, lapTime: 100 + spread, createdAt }),
      );
    }
    sessions.push(
      session({ id: 10, createdAt: sessions[9].createdAt }),
      session({ id: 12, ownership: "others", createdAt: "2026-10-05T11:59:59Z" }),
      session({ id: 13, gameId: "acc", createdAt: "2026-10-05T11:59:58Z" }),
    );
    laps.push(
      lap({ id: 200, sessionId: 12, ownership: "others", createdAt: "2026-10-05T11:59:59Z" }),
      lap({ id: 201, sessionId: 13, gameId: "acc", createdAt: "2026-10-05T11:59:58Z" }),
    );

    const result = buildDashboardInsights(laps, sessions, "fm-2023", now);
    expect(result.consistency.sessions).toBe(9);
    expect(result.consistency.averageStandardDeviation).toBeCloseTo(0.625);
    expect(result.consistency.deviations).toEqual([0, 1, 1, 1, 0, 1, 1, 1, 1, 2]);
  });
  test("excludes mixed game-track-car laps from session consistency", () => {
    const sessions = [session({ id: 1 }), session({ id: 2 })];
    const laps = [
      lap({ id: 1, sessionId: 1, lapTime: 90 }),
      lap({ id: 2, sessionId: 1, lapTime: 91, carId: "car-b" }),
      lap({ id: 3, sessionId: 2, lapTime: 90 }),
      lap({ id: 4, sessionId: 2, lapTime: 91 }),
    ];
    const result = buildDashboardInsights(laps, sessions, "fm-2023", now);
    expect(result.consistency.sessions).toBe(1);
    expect(result.consistency.averageStandardDeviation).toBeCloseTo(0.5);
    expect(result.consistency.deviations).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  });


  test("classifies per-track practice, qualifying, and race time while excluding unknown session types", () => {
    const laps = [
      lap({ id: 1, sessionId: 1, lapTime: 90 }),
      lap({ id: 2, sessionId: 2, lapTime: 80 }),
      lap({ id: 3, sessionId: 3, lapTime: 100, isValid: false }),
      lap({ id: 4, sessionId: 4, lapTime: 40, isValid: false }),
      lap({ id: 5, sessionId: 5, lapTime: 70, createdAt: "2026-10-05T11:59:59Z" }),
      lap({ id: 6, sessionId: 6, lapTime: 50, isValid: false }),
    ];
    const sessions = [
      session({ id: 1, sessionType: "practice" }),
      session({ id: 2, sessionType: "qualifying" }),
      session({ id: 3, sessionType: "race" }),
      session({ id: 4, sessionType: "test-day" }),
      session({ id: 5, sessionType: "race" }),
      session({ id: 6, sessionType: "unknown" }),
    ];
    const result = buildDashboardInsights(laps, sessions, "fm-2023", now);
    expect(result.trackAnalytics?.sessionTypes).toEqual([
      { kind: "practice", seconds: 130, share: 130 / 380 },
      { kind: "qualifying", seconds: 80, share: 80 / 380 },
      { kind: "race", seconds: 170, share: 170 / 380 },
    ]);
    expect(result.trackAnalytics?.sessionTypeTotalSeconds).toBe(380);
    expect(result.trackAnalytics?.trend).toEqual([
      { lapTime: 70, createdAt: "2026-10-05T11:59:59Z" },
      { lapTime: 90, createdAt: "2026-10-05T12:00:00Z" },
      { lapTime: 80, createdAt: "2026-10-05T12:00:00Z" },
    ]);
  });

  test("keeps valid-lap trend when session type is unknown", () => {
    const laps = [lap({ id: 1, sessionId: 1, lapTime: 91 }), lap({ id: 2, sessionId: 2, lapTime: 90 })];
    const sessions = [session({ id: 1, sessionType: "unknown" }), session({ id: 2, sessionType: "unknown" })];
    const analytics = buildDashboardInsights(laps, sessions, "fm-2023", now).trackAnalytics!;
    expect(analytics.sessionTypeTotalSeconds).toBe(0);
    expect(analytics.trend.map(({ lapTime }) => lapTime)).toEqual([91, 90]);
  });

  test("retains recorded-time bars for a track with only invalid laps", () => {
    const laps = [lap({ isValid: false, sessionId: 1, lapTime: 90 })];
    const sessions = [session({ sessionType: "practice" })];
    const result = buildDashboardInsights(laps, sessions, "fm-2023", now);
    expect(result.trackContext?.trackIdentity).toBe("track:string:track-a");
    expect(result.trackAnalytics?.sessionTypeTotalSeconds).toBe(90);
    expect(result.trackAnalytics?.trend).toEqual([]);
  });
  


});
