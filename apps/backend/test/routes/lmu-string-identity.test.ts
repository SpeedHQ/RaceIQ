import { afterEach, describe, expect, test } from "bun:test";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { getLapStats, getReviewLaps } from "@raceiq/backend-core/db/lap-read-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import { sessionRoutes } from "../../src/routes/session-routes";
import { trackRoutes } from "../../src/routes/tracks/index";
import { settingsRoutes } from "../../src/routes/settings-routes";
import tracksJson from "@raceiq/game-lmu-metadata/tracks.json";
import { loadLabelledSegments } from "@raceiq/shared/racing/tracks/storage/meta";

const sessionIds: number[] = [];

afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
});

describe("LMU string identity routes", () => {
  test("round-trips full canonical track IDs through catalog and geometry routes", async () => {
    const encoded = encodeURIComponent("spa_2023/spawec");
    const catalogResponse = await trackRoutes.request("/api/tracks?gameId=lmu");
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as Array<{ id: string; lapCount: number }>;

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

  test("keeps SVG-space LMU outlines unmirrored when rendered with segments", async () => {
    const response = await trackRoutes.request(`/api/track-outline/${encodeURIComponent("spa_2023/spaelms")}?gameId=lmu`);
    expect(response.status).toBe(200);
    const outline = await response.json() as { flipX: boolean };
    // drawTrack mirrors telemetry-space X by default; SVG-space X must be preserved.
    expect(outline.flipX).toBe(true);
  });

  test("uses common Spa corner definitions and starting percentages for LMU", async () => {
    const encoded = encodeURIComponent("spa_2023/spaelms");
    const compatibleSegments = loadLabelledSegments("spa", "acc");
    const expectedLaSource = compatibleSegments.find((segment) => segment.name === "La Source")!;
    const kemmel = compatibleSegments.find((segment) => segment.name === "Kemmel")!;
    const response = await trackRoutes.request(`/api/track-sectors/${encoded}?gameId=lmu`);
    expect(response.status).toBe(200);
    const data = await response.json() as { source: string; segments: Array<{ name: string; startFrac: number; endFrac: number }> };
    expect(data.source).toBe("shared");
    expect(data.segments.find((segment) => segment.name === "La Source")).toMatchObject({
      startFrac: expectedLaSource.startFrac,
      endFrac: expectedLaSource.endFrac,
    });
    expect(data.segments.find((segment) => segment.name === "Kemmel")).toMatchObject({
      startFrac: kemmel.startFrac,
      endFrac: kemmel.endFrac,
    });

    const outlineResponse = await trackRoutes.request(`/api/track-outline/${encoded}?gameId=lmu`);
    const { points } = await outlineResponse.json() as { points: Array<{ x: number; z: number }> };
    const totalLength = points.slice(1).reduce(
      (distance, point, index) => distance + Math.hypot(point.x - points[index].x, point.z - points[index].z),
      0,
    );
    const laSource = data.segments.find((segment) => segment.name === "La Source")!;
    expect(points.length).toBeGreaterThan(10);
    expect(laSource.startFrac).toBeGreaterThanOrEqual(0);
    expect(laSource.endFrac).toBeLessThanOrEqual(1);
    expect(laSource.startFrac).toBeLessThan(laSource.endFrac);
    expect(kemmel.startFrac).toBeGreaterThan(laSource.endFrac);
    // Segment fractions use lap-distance semantics on the LMU outline, independent of map orientation.
    expect(laSource.endFrac * totalLength).toBeGreaterThan(laSource.startFrac * totalLength);
    expect(totalLength).toBeGreaterThan(0);
  });

  test("resolves the common Spa guide using the canonical LMU track ID", async () => {
    const response = await trackRoutes.request(`/api/track-guide/${encodeURIComponent("spa_2023/spaelms")}?gameId=lmu`);
    expect(response.status).toBe(200);
    const guide = await response.json() as { id: string; corners: Array<{ numbers: number[]; label: string }> };
    expect(guide.id).toBe("spa");
    expect(guide.corners.find((corner) => corner.numbers?.includes(1))?.label).toContain("La Source");
  });

  test("places every Barcelona no-chicane turn in a separate segment", async () => {
    const encoded = encodeURIComponent("barcelona_2025/barcelonaelms");
    const response = await trackRoutes.request(`/api/track-sectors/${encoded}?gameId=lmu`);
    expect(response.status).toBe(200);
    const data = await response.json() as { source: string; segments: Array<{ type: string; number?: number; covers?: number[]; direction?: string; startFrac: number; endFrac: number }> };
    expect(data.source).toBe("shared");
    const corners = data.segments.filter((segment) => segment.type === "corner");
    expect(corners.map((segment) => segment.number)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(corners.every((segment) => !segment.covers?.length)).toBe(true);
    expect(corners[5]).toMatchObject({ number: 6, direction: "left" });
    expect(corners[10]).toMatchObject({ number: 11, direction: "left" });
    for (let index = 0; index < data.segments.length; index++) {
      const segment = data.segments[index];
      expect(segment.endFrac).toBeGreaterThan(segment.startFrac);
      expect(segment.startFrac).toBe(index === 0 ? 0 : data.segments[index - 1].endFrac);
    }
    expect(data.segments[data.segments.length - 1].endFrac).toBe(1);

    const guideResponse = await trackRoutes.request(`/api/track-guide/${encoded}?gameId=lmu`);
    const guide = await guideResponse.json() as { corners: Array<{ numbers?: number[]; priority: boolean }> };
    expect(guide.corners.every((corner) => corner.numbers?.every((number) => number >= 1 && number <= 14))).toBe(true);
    expect(guide.corners.find((corner) => corner.numbers?.includes(14))?.priority).toBe(true);
  });

  test("counts and filters LMU laps by canonical string identity", async () => {
    const stringSession = await insertSession("ferrari_499p_2023", "spa_2023/spawec", "lmu", "race");
    const legacySession = await insertSession("1896582084", "481869333", "lmu");
    sessionIds.push(stringSession, legacySession);
    await insertLap(stringSession, 1, 142.2, true, null, 1, null, null, null, null, null);
    await insertLap(legacySession, 1, 143.2, true, null, 1, null, null, null, null, null);

    const catalogResponse = await trackRoutes.request("/api/tracks?gameId=lmu");
    const catalog = await catalogResponse.json() as Array<{ id: string | null; lapCount: number }>;
    expect(catalog.find((track) => track.id === "spa_2023/spawec")?.lapCount).toBe(1);

    const lapsResponse = await trackRoutes.request(`/api/tracks/${encodeURIComponent("spa_2023/spawec")}/all-laps?gameId=lmu`);
    expect(lapsResponse.status).toBe(200);
    const trackLaps = await lapsResponse.json() as Array<{ sessionId: number; carId: string | null }>;
    expect(trackLaps.map((lap) => lap.sessionId)).toEqual([stringSession]);
    expect(trackLaps[0]?.carId).toBe("ferrari_499p_2023");

    const sessionsResponse = await sessionRoutes.request("/api/sessions?gameId=lmu");
    expect(sessionsResponse.status).toBe(200);
    const rows = await sessionsResponse.json() as Array<{ id: number; carId: string; trackId: string }>;
    expect(rows.find((row) => row.id === stringSession)).toMatchObject({ carId: "ferrari_499p_2023", trackId: "spa_2023/spawec" });
    expect(rows.find((row) => row.id === legacySession)).toMatchObject({ carId: "1896582084", trackId: "481869333" });
  });


  test("statistics count string identities and games separately and use LMU lengths", async () => {
    const before = await getLapStats("lmu");
    const beforeRouteResponse = await settingsRoutes.request("/api/stats?gameId=lmu");
    const beforeRoute = await beforeRouteResponse.json() as { totalDistanceMeters: number };
    const stringSession = await insertSession(`ferrari_499p_2023-${Date.now()}`, "spa_2023/spawec", "lmu", "race");
    const secondStringSession = await insertSession(`porsche_963_2023-${Date.now()}`, "bahrainwec_2023/bahrainwec", "lmu", "race");
    const numericNative = await insertSession(`1896582084-${Date.now()}`, "481869333", "lmu", "race");
    const otherGame = await insertSession(`1896582084-${Date.now()}`, "481869333", "fm-2023");
    const others = await insertSession(`other-driver-car-${Date.now()}`, "other-driver-track", "lmu", "race", undefined, "others");
    sessionIds.push(stringSession, secondStringSession, numericNative, otherGame, others);
    await insertLap(stringSession, 1, 140, true, null, 1, null, null, null, null, null);
    await insertLap(stringSession, 2, 141, false, null, 1, null, null, null, null, null);
    await insertLap(stringSession, 3, 0, false, null, 1, null, null, null, null, null);
    for (const id of [secondStringSession, numericNative, otherGame, others]) {
      await insertLap(id, 1, 150, true, null, 1, null, null, null, null, null);
    }

    const stats = await getLapStats("lmu");
    expect(stats.totalLaps - before.totalLaps).toBe(5);
    expect(stats.validLaps - before.validLaps).toBe(3);
    expect(stats.totalTimeSec - before.totalTimeSec).toBe(581);
    const trackCountDeltas = Object.fromEntries(stats.lapsByTrack.map((row) => [
      row.trackId,
      row.count - (before.lapsByTrack.find((prior) => prior.trackId === row.trackId)?.count ?? 0),
    ]));
    expect(trackCountDeltas["spa_2023/spawec"]).toBe(2);
    expect(trackCountDeltas["bahrainwec_2023/bahrainwec"]).toBe(1);
    expect(trackCountDeltas["481869333"]).toBe(1);

    const response = await settingsRoutes.request("/api/stats?gameId=lmu");
    expect(response.status).toBe(200);
    const afterRoute = await response.json() as { totalDistanceMeters: number };
    expect(afterRoute.totalDistanceMeters - beforeRoute.totalDistanceMeters).toBe(19_420);
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
