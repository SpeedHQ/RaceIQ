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
    sessionType: "race", elapsedSeconds: 90, resultClassification: "finished", resultOutcomeStatus: "confirmed",
    finishingPosition: 1, ...overrides,
  };
}

const now = new Date("2026-10-05T12:00:00Z");

describe("buildDashboardInsights", () => {
  test("counts all timed own laps in the supplied period and excludes nonpositive, nonfinite and others", () => {
    const laps = Array.from({ length: 21 }, (_, id) => lap({ id, isValid: id % 2 === 0 }));
    laps.push(lap({ id: 30, lapTime: 0 }), lap({ id: 31, lapTime: Number.NaN }), lap({ id: 32, ownership: "others" }));
    expect(buildDashboardInsights(laps, [], null, now).clean).toMatchObject({ valid: 11, total: 21, rate: 11 / 21 });
  });

  test("ignores invalid and future lap timestamps", () => {
    const result = buildDashboardInsights([
      lap({ id: 1, createdAt: "invalid" }),
      lap({ id: 2, createdAt: "2026-10-05T12:00:01Z", lapTime: 70 }),
      lap({ id: 3, createdAt: "2026-10-05T11:00:00Z", lapTime: 80 }),
    ], [], null, now);
    expect(result.clean).toMatchObject({ valid: 1, total: 1, rate: 1 });
  });

  test("plots chronological cumulative clean rates across the full supplied period", () => {
    const laps = Array.from({ length: 22 }, (_, index) => lap({
      id: index + 1,
      createdAt: new Date(now.getTime() - (22 - index) * 60_000).toISOString(),
      isValid: index !== 0 && index !== 21,
    }));
    const clean = buildDashboardInsights(laps.reverse(), [], "fm-2023", now).clean;
    expect(clean.trend.map(({ lapId }) => lapId)).toEqual(Array.from({ length: 22 }, (_, index) => index + 1));
    expect(clean.trend.map(({ rate }) => rate)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index / (index + 1)), 20 / 21, 20 / 22,
    ]);
    expect(clean).toMatchObject({ valid: 20, total: 22, rate: 20 / 22 });
    expect(clean.trend[21]).toMatchObject({ timestamp: now.getTime() - 60_000, valid: 20, total: 22 });
  });

  test("excludes ineligible laps from both trend points and period denominator", () => {
    const clean = buildDashboardInsights([
      lap({ id: 2, isValid: false }),
      lap({ id: 1 }),
      lap({ id: 3, gameId: "acc" }),
      lap({ id: 4, ownership: "others" }),
      lap({ id: 5, lapTime: 0 }),
      lap({ id: 6, lapTime: Number.POSITIVE_INFINITY }),
      lap({ id: 7, createdAt: "invalid" }),
      lap({ id: 8, createdAt: "2026-10-06T12:00:00Z" }),
    ], [], "fm-2023", now).clean;
    expect(clean.trend.map(({ lapId, rate, total }) => ({ lapId, rate, total }))).toEqual([
      { lapId: 1, rate: 1, total: 1 }, { lapId: 2, rate: 0.5, total: 2 },
    ]);
    expect(buildDashboardInsights([], [], null, now).clean).toEqual({ valid: 0, total: 0, rate: null, trend: [] });
    expect(buildDashboardInsights([lap({ isValid: false })], [], null, now).clean.trend[0])
      .toMatchObject({ valid: 0, total: 1, rate: 0 });
  });

  test("counts confirmed race podium places once and filters owner and game", () => {
    const result = buildDashboardInsights([], [
      session({ id: 1, finishingPosition: 1 }),
      session({ id: 2, finishingPosition: 2 }),
      session({ id: 3, finishingPosition: 3 }),
      session({ id: 4, ownership: "others" }),
      session({ id: 5, gameId: "acc" }),
    ], "fm-2023", now);
    expect(result.podiums).toMatchObject({
      total: 3, first: 1, second: 1, third: 1, available: true,
      otherPositions: [],
    });
  });

  test("distinguishes known zero podiums from unavailable results", () => {
    expect(buildDashboardInsights([], [session({ finishingPosition: 4 })], null, now).podiums)
      .toMatchObject({ total: 0, first: 0, second: 0, third: 0, available: true, rate: 0, otherPositions: [{ position: 4, count: 1 }] });
    expect(buildDashboardInsights([], [session({ resultOutcomeStatus: "unavailable" })], null, now).podiums)
      .toEqual({ total: 0, first: 0, second: 0, third: 0, available: false, rate: null, trend: [], otherPositions: [] });
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
    expect(result.podiums).toMatchObject({
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
    expect(result.podiums).toMatchObject({
      total: 0, first: 0, second: 0, third: 0, available: true,
      otherPositions: [{ position: 5, count: 1 }, { position: 9, count: 2 }],
    });
  });

  test("plots chronological cumulative podium rates across the full supplied period", () => {
    const races = Array.from({ length: 22 }, (_, index) => session({
      id: index + 1,
      finishingPosition: index === 0 || index === 21 ? 4 : index % 3 + 1,
      createdAt: new Date(now.getTime() - (22 - index) * 60_000).toISOString(),
    }));
    const podiums = buildDashboardInsights([], races.reverse(), "fm-2023", now).podiums;
    expect(podiums.trend.map(({ sessionId }) => sessionId)).toEqual(Array.from({ length: 22 }, (_, index) => index + 1));
    expect(podiums.trend.map(({ rate }) => rate)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index / (index + 1)), 20 / 21, 20 / 22,
    ]);
    expect(podiums.rate).toBe(20 / 22);
    expect(podiums.total).toBe(20);
    expect(podiums.trend[21]).toMatchObject({ podiums: 20, first: 6, second: 7, third: 7, total: 22, timestamp: now.getTime() - 60_000 });
  });

  test("uses exactly the counted race set for podium rates and resets within supplied period", () => {
    const races = [
      session({ id: 2, finishingPosition: 4 }),
      session({ id: 1, finishingPosition: 3 }),
      session({ id: 1, finishingPosition: 1 }),
      session({ id: 3, gameId: "acc" }),
      session({ id: 4, ownership: "others" }),
      session({ id: 5, sessionType: "practice" }),
      session({ id: 6, sessionType: "qualifying" }),
      session({ id: 7, resultClassification: "dnf" }),
      session({ id: 8, resultOutcomeStatus: "provisional" }),
      session({ id: 9, finishingPosition: null }),
      session({ id: 10, finishingPosition: 1.5 }),
      session({ id: 11, createdAt: "bad" }),
      session({ id: 12, createdAt: "2026-10-06T12:00:00Z" }),
    ];
    const podiums = buildDashboardInsights([], races, "fm-2023", now).podiums;
    expect(podiums.trend.map(({ sessionId, rate, total }) => ({ sessionId, rate, total }))).toEqual([
      { sessionId: 1, rate: 1, total: 1 }, { sessionId: 2, rate: 0.5, total: 2 },
    ]);
    expect(podiums).toMatchObject({ total: 1, third: 1, rate: 0.5 });
    expect(buildDashboardInsights([], [races[0]!], "fm-2023", now).podiums.trend)
      .toEqual([{ sessionId: 2, timestamp: now.getTime(), podiums: 0, first: 0, second: 0, third: 0, total: 1, rate: 0 }]);
  });

  test("retains every podium position in cumulative period shares beyond twenty races", () => {
    const positions = [1, 2, 3, ...Array.from({ length: 17 }, () => 4), 2, 3, 1];
    const races = positions.map((finishingPosition, index) => session({ id: index + 1, finishingPosition }));
    const trend = buildDashboardInsights([], races, null, now).podiums.trend;
    expect(trend.slice(19).map(({ first, second, third, total, rate }) => ({ first, second, third, total, rate })))
      .toEqual([
        { first: 1, second: 1, third: 1, total: 20, rate: 0.15 },
        { first: 1, second: 2, third: 1, total: 21, rate: 4 / 21 },
        { first: 1, second: 2, third: 2, total: 22, rate: 5 / 22 },
        { first: 2, second: 2, third: 2, total: 23, rate: 6 / 23 },
      ]);
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
    expect(fmOnly.trackDistribution.totalSeconds).toBe(90);
  });
  test("retains sentinel track time without treating sentinel IDs as comparable context", () => {
    const laps = [lap({ trackId: null, trackOrdinal: -1, carId: null, carOrdinal: -1 })];
    const result = buildDashboardInsights(laps, [], "fm-2023", now);
    expect(result.trackDistribution.totalSeconds).toBe(90);
    expect(result.trackDistribution.tracks[0]?.trackIdentity).toBe("track:unknown");
    expect(result.consistency.sessions).toBe(0);
  });

  test("averages consistency across all comparable own sessions in the supplied period", () => {
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
    expect(result.consistency.sessions).toBe(10);
    expect(result.consistency.averageStandardDeviation).toBeCloseTo(0.5635);
    expect(result.consistency.deviations).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1, 2]);
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


  test("aggregates elapsed session duration across tracks and cars without laps", () => {
    const result = buildDashboardInsights([], [
      session({ id: 1, sessionType: "practice", elapsedSeconds: 120, trackId: "track-a", carId: "car-a" }),
      session({ id: 2, sessionType: "Practice 2", elapsedSeconds: 60, trackId: "track-b", carId: "car-b" }),
      session({ id: 3, sessionType: "qualifying", elapsedSeconds: 80 }),
      session({ id: 4, sessionType: "race", elapsedSeconds: 170 }),
      session({ id: 5, sessionType: "unknown", elapsedSeconds: 300 }),
    ], "fm-2023", now);
    expect(result.sessionStats.sessionTypes).toEqual([
      { kind: "practice", seconds: 180, share: 180 / 730 },
      { kind: "qualifying", seconds: 80, share: 80 / 730 },
      { kind: "race", seconds: 170, share: 170 / 730 },
    ]);
    expect(result.sessionStats.sessionTypeTotalSeconds).toBe(730);
    expect(result.sessionStats.unclassifiedSeconds).toBe(300);
    expect(result.sessionStats.unclassifiedShare).toBe(300 / 730);
  });

  test("filters session duration by owner, game, period and deduplicates IDs", () => {
    const result = buildDashboardInsights([], [
      session({ id: 1, elapsedSeconds: 40 }),
      session({ id: 1, elapsedSeconds: 90 }),
      session({ id: 2, ownership: "others", elapsedSeconds: 50 }),
      session({ id: 3, gameId: "acc", elapsedSeconds: 70 }),
      session({ id: 4, createdAt: "2026-10-05T12:00:01Z", elapsedSeconds: 80 }),
    ], "fm-2023", now);
    expect(result.sessionStats.sessionTypeTotalSeconds).toBe(40);
  });

  test("discloses unavailable timing and unknown types instead of claiming total coverage", () => {
    const result = buildDashboardInsights([], [
      session({ id: 1, sessionType: "practice", elapsedSeconds: null }),
      session({ id: 2, sessionType: "race", elapsedSeconds: Number.NaN }),
      session({ id: 3, sessionType: "unknown", elapsedSeconds: 120 }),
      session({ id: 4, sessionType: "qualifying", elapsedSeconds: -1 }),
    ], "fm-2023", now);
    expect(result.sessionStats).toMatchObject({
      sessionTypeTotalSeconds: 120, unclassifiedSeconds: 120, unclassifiedShare: 1,
    });
    expect(result.sessionStats.sessionTypes.every(({ share }) => share === 0)).toBe(true);
  });
  
  test("ranks favourites by deduplicated completed-lap time and isolates game identities", () => {
    const insights = buildDashboardInsights([
      lap({ id: 1, sessionId: 10, trackId: 0, carId: 0, lapTime: 100 }),
      lap({ id: 1, sessionId: 10, trackId: 0, carId: 0, lapTime: 100 }),
      lap({ id: 2, sessionId: 10, trackId: 0, carId: 0, lapTime: 80 }),
      lap({ id: 3, sessionId: 11, gameId: "acc", trackId: 0, carId: 0, lapTime: 500 }),
      lap({ id: 4, sessionId: 12, trackId: 1, carId: 1, lapTime: 300, invalidReason: "incomplete" }),
      lap({ id: 5, sessionId: 13, trackId: 1, carId: 1, lapTime: 200, ownership: "others" }),
      lap({ id: 6, sessionId: 14, trackId: 1, carId: 1, lapTime: 200, createdAt: "2026-10-06T12:00:00Z" }),
    ], [
      session({ id: 10, trackId: 0, carId: 0, finishingPosition: 2 }),
      session({ id: 11, gameId: "acc", trackId: 0, carId: 0 }),
    ], "fm-2023", now);

    expect(insights.favouriteTrack).toMatchObject({
      gameId: "fm-2023", identity: 0, seconds: 180, laps: 2, sessions: 1, podiums: 1,
    });
    expect(insights.favouriteCar).toMatchObject({
      gameId: "fm-2023", identity: 0, seconds: 180, laps: 2,
    });
  });

  test("reports covered distance laps and unavailable distance or podium evidence honestly", () => {
    const insights = buildDashboardInsights([
      lap({ id: 1, sessionId: 1, trackId: "unknown", trackOrdinal: -1, carId: "car-x", carOrdinal: 2 }),
      lap({ id: 2, sessionId: 2, trackId: "unknown", trackOrdinal: -1, carId: "car-x", carOrdinal: 2 }),
    ], [session({
      id: 1, trackId: "unknown", trackOrdinal: -1, carId: "car-x", carOrdinal: 2,
      sessionType: "practice", finishingPosition: 1,
    })], "fm-2023", now);

    expect(insights.favouriteTrack).toMatchObject({
      identity: "unknown", laps: 2, sessions: 2, distanceMeters: null, distanceLaps: 0, podiums: null,
    });
    expect(insights.favouriteCar).toMatchObject({
      identity: "car-x", laps: 2, sessions: 2, distanceMeters: null, distanceLaps: 0, podiums: null,
    });
  });

  test("uses stable identity ordering for equal favourite time and returns null when empty", () => {
    const tied = buildDashboardInsights([
      lap({ id: 1, trackId: "z", carId: "z" }),
      lap({ id: 2, trackId: "a", carId: "a" }),
    ], [], "fm-2023", now);
    expect(tied.favouriteTrack?.identity).toBe("a");
    expect(tied.favouriteCar?.identity).toBe("a");
    expect(buildDashboardInsights([], [], "fm-2023", now).favouriteTrack).toBeNull();
    expect(buildDashboardInsights([], [], "fm-2023", now).favouriteCar).toBeNull();
  });

  test("estimates favourite-car distance across distinct known tracks with partial coverage", () => {
    const trackLengths = { "acc:1": 5, "acc:2": 4.2 };
    const insights = buildDashboardInsights([
      lap({ id: 1, gameId: "acc", carId: "car-x", trackId: 1, trackOrdinal: 1 }),
      lap({ id: 2, gameId: "acc", carId: "car-x", trackId: 2, trackOrdinal: 2 }),
      lap({ id: 3, gameId: "acc", carId: "car-x", trackId: "unknown", trackOrdinal: -1 }),
    ], [], "acc", now, trackLengths);
    expect(insights.favouriteCar?.identity).toBe("car-x");
    expect(insights.favouriteCar?.distanceLaps).toBe(2);
    expect(insights.favouriteCar?.distanceMeters).toBe(9_200);
  });
  test("accepts legacy missing ownership and resolves native numeric track IDs for distance", () => {
    const insights = buildDashboardInsights([
      lap({ id: 1, ownership: undefined, gameId: "acc", trackId: 1, trackOrdinal: -1, carId: "legacy-car" }),
    ], [session({ id: 1, ownership: undefined, gameId: "acc", trackId: 1, trackOrdinal: -1, carId: "legacy-car" })], "acc", now, { "acc:1": 5 });
    expect(insights.favouriteTrack?.distanceMeters).toBe(5_000);
    expect(insights.favouriteTrack?.sessions).toBe(1);
  });

  test("counts only deduplicated confirmed finished race podium evidence for favourites", () => {
    const insights = buildDashboardInsights([
      lap({ id: 1, sessionId: 1, gameId: "acc", trackId: 1, carId: 1 }),
    ], [
      session({ id: 1, gameId: "acc", trackId: 1, carId: 1, finishingPosition: 2 }),
      session({ id: 1, gameId: "acc", trackId: 1, carId: 1, finishingPosition: 2 }),
      session({ id: 2, gameId: "acc", trackId: 1, carId: 1, finishingPosition: 5 }),
      session({ id: 3, gameId: "acc", trackId: 1, carId: 1, finishingPosition: 1, resultOutcomeStatus: "provisional" }),
      session({ id: 4, gameId: "acc", trackId: 1, carId: 1, finishingPosition: 1, resultClassification: "dnf" }),
      session({ id: 5, gameId: "acc", trackId: 1, carId: 1, finishingPosition: 1, sessionType: "practice" }),
    ], "acc", now);
    expect(insights.favouriteTrack?.podiums).toBe(1);

    const knownZero = buildDashboardInsights([
      lap({ id: 1, sessionId: 1, gameId: "acc", trackId: 1, carId: 1 }),
    ], [session({ id: 1, gameId: "acc", trackId: 1, carId: 1, finishingPosition: 5 })], "acc", now);
    const unknown = buildDashboardInsights([
      lap({ id: 1, sessionId: 1, gameId: "acc", trackId: 1, carId: 1 }),
    ], [], "acc", now);
    expect(knownZero.favouriteTrack?.podiums).toBe(0);
    expect(unknown.favouriteTrack?.podiums).toBeNull();
  });

});
