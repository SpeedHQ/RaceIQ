import { afterEach, describe, expect, test } from "bun:test";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { getLapStats, getReviewLaps } from "../../server/db/lap-read-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "../../server/db/session-queries";
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
    const stringSession = await insertSession("ferrari_499p_2023", "spa_2023/spawec", "lmu", "race");
    const legacySession = await insertSession("1896582084", "481869333", "lmu");
    sessionIds.push(stringSession, legacySession);
    await updateSessionRawFile(stringSession, "/tmp/lmu-string-identity.bin", "test");
    await updateSessionRawFile(legacySession, "/tmp/lmu-string-identity.bin", "test");
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
    const rows = await sessionsResponse.json() as Array<{ id: number; carId: string | null; trackId: string | null }>;
    expect(rows.find((row) => row.id === stringSession)).toMatchObject({ carId: "ferrari_499p_2023", trackId: "spa_2023/spawec" });
    expect(rows.find((row) => row.id === legacySession)).toMatchObject({ carId: "1896582084", trackId: "481869333" });
  });

  test("numeric-looking legacy identities remain strings and never alias resolved rows", async () => {
    const legacy = await insertSession("1896582084", "481869333", "lmu");
    const resolved = await insertSession("ferrari_499p_2023", "spa_2023/spawec", "lmu", "race");
    const numericNative = await insertSession("1896582084", "481869333", "lmu", "race");
    const otherGame = await insertSession("1896582084", "481869333", "fm-2023");
    sessionIds.push(legacy, resolved, numericNative, otherGame);
    for (const id of [legacy, resolved, numericNative, otherGame]) {
      await updateSessionRawFile(id, "/tmp/lmu-string-identity.bin", "test");
    }
    const legacyLap = await insertLap(legacy, 1, 143.2, true, null, 1, null, null, null, [40, 60, 43.2]);
    await insertLap(resolved, 1, 140, true, null, 1);
    const nativeLap = await insertLap(numericNative, 1, 142, true, null, 1, null, null, null, [40, 60, 42]);
    await insertLap(otherGame, 1, 130, true, null, 1);

    const allLaps = await trackRoutes.request(`/api/tracks/${encodeURIComponent("481869333")}/all-laps?gameId=lmu`);
    expect(allLaps.status).toBe(200);
    expect(await allLaps.json()).toMatchObject([
      { sessionId: numericNative, carId: "1896582084" },
      { sessionId: legacy, carId: "1896582084" },
    ]);

    const leaderboard = await trackRoutes.request(`/api/tracks/${encodeURIComponent("481869333")}/leaderboard?gameId=lmu`);
    const groups = await leaderboard.json() as Record<string, Array<{ lapId: number }>>;
    expect(Object.values(groups).flat().map((lap) => lap.lapId)).toEqual([nativeLap, legacyLap]);

    const sectors = await trackRoutes.request(`/api/tracks/${encodeURIComponent("481869333")}/lap-sectors?gameId=lmu`);
    expect(await sectors.json()).toEqual({
      [legacyLap]: [40, 60, 43.2],
      [nativeLap]: [40, 60, 42],
    });

    const review = await getReviewLaps("lmu", "481869333", "1896582084");
    expect(review.map((lap) => lap.sessionId)).toEqual([numericNative, legacy]);
    const resolvedReview = await getReviewLaps("lmu", "spa_2023/spawec", "ferrari_499p_2023");
    expect(resolvedReview.map((lap) => lap.sessionId)).toEqual([resolved]);
  });

  test("statistics count string identities, legacy identities and games separately and use LMU lengths", async () => {
    const before = await getLapStats();
    const stringSession = await insertSession("ferrari_499p_2023", "spa_2023/spawec", "lmu", "race");
    const secondStringSession = await insertSession("porsche_963_2023", "bahrainwec_2023/bahrainwec", "lmu", "race");
    const numericNative = await insertSession("1896582084", "481869333", "lmu", "race");
    const legacy = await insertSession("1896582084", "481869333", "lmu");
    const otherGame = await insertSession("1896582084", "481869333", "fm-2023");
    const others = await insertSession("other-driver-car", "other-driver-track", "lmu", "race", undefined, "others");
    sessionIds.push(stringSession, secondStringSession, numericNative, legacy, otherGame, others);
    await insertLap(stringSession, 1, 140, true, null, 1);
    await insertLap(stringSession, 2, 141, false, null, 1);
    await insertLap(stringSession, 3, 0, false, null, 1);
    for (const id of [secondStringSession, numericNative, legacy, otherGame, others]) {
      await insertLap(id, 1, 150, true, null, 1);
    }

    const stats = await getLapStats("lmu");
    expect(stats).toMatchObject({ totalLaps: 6, validLaps: 4, uniqueCars: 3, uniqueTracks: 3, totalTimeSec: 731 });
    expect(stats.lapsByTrack).toHaveLength(3);
    expect(stats.lapsByTrack).toEqual(expect.arrayContaining([
      { gameId: "lmu", trackId: "spa_2023/spawec", count: 2 },
      { gameId: "lmu", trackId: "bahrainwec_2023/bahrainwec", count: 1 },
      { gameId: "lmu", trackId: "481869333", count: 2 },
    ]));
    const combined = await getLapStats();
    expect(combined.uniqueCars - before.uniqueCars).toBe(4);
    expect(combined.uniqueTracks - before.uniqueTracks).toBe(4);
    expect(combined.lapsByTrack).toContainEqual({ gameId: "fm-2023", trackId: "481869333", count: 1 });

    const response = await settingsRoutes.request("/api/stats?gameId=lmu");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ uniqueCars: 3, uniqueTracks: 3, totalDistanceMeters: 19_420 });
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
