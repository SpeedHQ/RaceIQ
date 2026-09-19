import { afterEach, describe, expect, test } from "bun:test";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { deleteSession, insertSession } from "../../server/db/session-queries";
import { sessionRoutes } from "../../server/routes/session-routes";
import { trackRoutes } from "../../server/routes/tracks";

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
});
