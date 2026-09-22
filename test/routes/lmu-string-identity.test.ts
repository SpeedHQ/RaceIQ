import { afterEach, describe, expect, test } from "bun:test";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { getLapStats, getReviewLaps } from "../../server/db/lap-read-queries";
import { deleteSession, insertSession } from "../../server/db/session-queries";
import { sessionRoutes } from "../../server/routes/session-routes";
import { trackRoutes } from "../../server/routes/tracks";
import { settingsRoutes } from "../../server/routes/settings-routes";
import tracksJson from "../../shared/games/lmu/tracks.json";

const sessionIds: number[] = [];

afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
});

describe("LMU string identity routes", () => {
  test("round-trips full canonical track IDs through catalog and geometry routes", async () => {
    const encoded = encodeURIComponent("spa_2023/spawec");
    const catalogResponse = await trackRoutes.request("/api/tracks?gameId=lmu");
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as Array<{ id: string; ordinal: number | null; lapCount: number }>;
    expect(catalog.find((track) => track.id === "spa_2023/spawec")).toMatchObject({ ordinal: null });

    const nameResponse = await trackRoutes.request(`/api/track-name/${encoded}?gameId=lmu`);
    expect(nameResponse.status).toBe(200);
    expect(await nameResponse.text()).toBe("Circuit de Spa-Francorchamps");

    const boundaryResponse = await trackRoutes.request(`/api/track-boundaries/${encoded}?gameId=lmu`);
    expect(boundaryResponse.status).toBe(200);
    const boundaries = await boundaryResponse.json() as { leftEdge: unknown[]; rightEdge: unknown[]; centerLine: unknown[]; coordSystem: string };
    expect(boundaries.coordSystem).toBe("lmu");
    expect(boundaries.leftEdge.length).toBeGreaterThan(10);
    expect(boundaries.rightEdge.length).toBeGreaterThan(10);
    expect(boundaries.centerLine.length).toBeGreaterThan(10);

    const outlineResponse = await trackRoutes.request(`/api/track-outline/${encoded}?gameId=lmu`);
    expect(outlineResponse.status).toBe(200);
    const outline = await outlineResponse.json() as { points: unknown[]; source: string };
    expect(outline.source).toBe("extracted");
    expect(outline.points.length).toBeGreaterThan(10);
  });

  test("counts and filters LMU laps by canonical string while preserving legacy rows", async () => {
    const stringSession = await insertSession(-1, -1, "lmu", "race", undefined, undefined, {
      carId: "ferrari_499p_2023",
      trackId: "spa_2023/spawec",
    });
    const legacySession = await insertSession(1_896_582_084, 481_869_333, "lmu");
    sessionIds.push(stringSession, legacySession);
    await insertLap(stringSession, 1, 142.2, true, null, 1);
    await insertLap(legacySession, 1, 143.2, true, null, 1);

    const catalogResponse = await trackRoutes.request("/api/tracks?gameId=lmu");
    const catalog = await catalogResponse.json() as Array<{ id: string | null; ordinal: number | null; lapCount: number }>;
    expect(catalog.find((track) => track.id === "spa_2023/spawec")?.lapCount).toBe(1);

    const lapsResponse = await trackRoutes.request(`/api/tracks/${encodeURIComponent("spa_2023/spawec")}/all-laps?gameId=lmu`);
    expect(lapsResponse.status).toBe(200);
    const trackLaps = await lapsResponse.json() as Array<{ sessionId: number; carId: string | number | null }>;
    expect(trackLaps.map((lap) => lap.sessionId)).toEqual([stringSession]);
    expect(trackLaps[0]?.carId).toBe("ferrari_499p_2023");

    const sessionsResponse = await sessionRoutes.request("/api/sessions?gameId=lmu");
    expect(sessionsResponse.status).toBe(200);
    const rows = await sessionsResponse.json() as Array<{ id: number; carOrdinal: number; carId: number | string; trackId: number | string }>;
    expect(rows.find((row) => row.id === stringSession)).toMatchObject({ carOrdinal: -1, carId: "ferrari_499p_2023", trackId: "spa_2023/spawec" });
    expect(rows.find((row) => row.id === legacySession)).toMatchObject({ carOrdinal: 1_896_582_084, carId: 1_896_582_084, trackId: 481_869_333 });
  });

  test("numeric URL identities retain legacy fallback without matching resolved rows by obsolete ordinal", async () => {
    const carOrdinal = 1_896_582_084;
    const trackOrdinal = 481_869_333;
    const legacy = await insertSession(carOrdinal, trackOrdinal, "lmu");
    const resolved = await insertSession(carOrdinal, trackOrdinal, "lmu", "race", undefined, undefined, {
      carId: "ferrari_499p_2023",
      trackId: "spa_2023/spawec",
    });
    const numericNative = await insertSession(-1, -1, "lmu", "race", undefined, undefined, {
      carId: String(carOrdinal),
      trackId: String(trackOrdinal),
    });
    const otherGame = await insertSession(carOrdinal, trackOrdinal, "fm-2023");
    sessionIds.push(legacy, resolved, numericNative, otherGame);
    const legacyLap = await insertLap(legacy, 1, 143.2, true, null, 1, null, null, null, [40, 60, 43.2]);
    await insertLap(resolved, 1, 140, true, null, 1);
    const nativeLap = await insertLap(numericNative, 1, 142, true, null, 1, null, null, null, [40, 60, 42]);
    await insertLap(otherGame, 1, 130, true, null, 1);

    const allLaps = await trackRoutes.request(`/api/tracks/${trackOrdinal}/all-laps?gameId=lmu`);
    expect(allLaps.status).toBe(200);
    expect(await allLaps.json()).toMatchObject([
      { sessionId: numericNative, carId: String(carOrdinal) },
      { sessionId: legacy, carId: carOrdinal },
    ]);

    const leaderboard = await trackRoutes.request(`/api/tracks/${trackOrdinal}/leaderboard?gameId=lmu`);
    expect(leaderboard.status).toBe(200);
    const groups = await leaderboard.json() as Record<string, Array<{ lapId: number }>>;
    expect(Object.values(groups).flat().map((lap) => lap.lapId)).toEqual([nativeLap, legacyLap]);

    const sectors = await trackRoutes.request(`/api/tracks/${trackOrdinal}/lap-sectors?gameId=lmu`);
    expect(sectors.status).toBe(200);
    expect(await sectors.json()).toEqual({
      [legacyLap]: [40, 60, 43.2],
      [nativeLap]: [40, 60, 42],
    });

    const review = await getReviewLaps("lmu", null, null, 5, undefined, String(trackOrdinal), String(carOrdinal));
    expect(review.map((lap) => lap.sessionId)).toEqual([numericNative, legacy]);
    const ordinalReview = await getReviewLaps("lmu", trackOrdinal, carOrdinal);
    expect(ordinalReview.map((lap) => lap.sessionId)).toEqual([numericNative, legacy]);
    const resolvedReview = await getReviewLaps("lmu", null, null, 5, undefined, "spa_2023/spawec", "ferrari_499p_2023");
    expect(resolvedReview.map((lap) => lap.sessionId)).toEqual([resolved]);
  });

  test("statistics count string identities, legacy identities and games separately and use LMU lengths", async () => {
    const before = await getLapStats();
    const stringSession = await insertSession(-1, -1, "lmu", "race", undefined, undefined, {
      carId: "ferrari_499p_2023",
      trackId: "spa_2023/spawec",
    });
    const secondStringSession = await insertSession(-1, -1, "lmu", "race", undefined, undefined, {
      carId: "porsche_963_2023",
      trackId: "bahrainwec_2023/bahrainwec",
    });
    const numericNative = await insertSession(-1, -1, "lmu", "race", undefined, undefined, {
      carId: "1896582084",
      trackId: "481869333",
    });
    const legacy = await insertSession(1_896_582_084, 481_869_333, "lmu");
    const otherGame = await insertSession(1_896_582_084, 481_869_333, "fm-2023");
    const others = await insertSession(-1, -1, "lmu", "race", undefined, "others", {
      carId: "other-driver-car",
      trackId: "other-driver-track",
    });
    sessionIds.push(stringSession, secondStringSession, numericNative, legacy, otherGame, others);
    await insertLap(stringSession, 1, 140, true, null, 1);
    await insertLap(stringSession, 2, 141, false, null, 1);
    await insertLap(stringSession, 3, 0, false, null, 1);
    for (const id of [secondStringSession, numericNative, legacy, otherGame, others]) {
      await insertLap(id, 1, 150, true, null, 1);
    }

    const stats = await getLapStats("lmu");
    expect(stats).toMatchObject({ totalLaps: 6, validLaps: 4, uniqueCars: 4, uniqueTracks: 4, totalTimeSec: 731 });
    expect(stats.lapsByTrack).toHaveLength(4);
    expect(stats.lapsByTrack).toEqual(expect.arrayContaining([
      { gameId: "lmu", trackId: "spa_2023/spawec", count: 2 },
      { gameId: "lmu", trackId: "bahrainwec_2023/bahrainwec", count: 1 },
      { gameId: "lmu", trackId: "481869333", count: 1 },
      { gameId: "lmu", trackId: 481_869_333, count: 1 },
    ]));
    const combined = await getLapStats();
    expect(combined.uniqueCars - before.uniqueCars).toBe(5);
    expect(combined.uniqueTracks - before.uniqueTracks).toBe(5);
    expect(combined.lapsByTrack).toContainEqual({ gameId: "fm-2023", trackId: 481_869_333, count: 1 });

    const response = await settingsRoutes.request("/api/stats?gameId=lmu");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ uniqueCars: 4, uniqueTracks: 4, totalDistanceMeters: 19_420 });
  });

  test("sector boundaries match generated track metadata and fall back only when unavailable", async () => {
    for (const track of tracksJson.tracks) {
      const response = await trackRoutes.request(`/api/track-sector-boundaries/${encodeURIComponent(track.id)}?gameId=lmu`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        s1End: track.sectorFractions[0],
        s2End: track.sectorFractions[1],
        trackLength: track.lengthKm * 1_000,
      });
    }
    const unknown = await trackRoutes.request("/api/track-sector-boundaries/unknown-native-track?gameId=lmu");
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ s1End: 1 / 3, s2End: 2 / 3, trackLength: 0 });
  });
});
