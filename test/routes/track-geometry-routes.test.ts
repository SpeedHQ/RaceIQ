import { describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";
import { trackSectorBoundaryRoutes } from "../../server/routes/tracks/segments-routes";

initGameAdapters({ f1Experiments: false, iracingAdapter: true });

describe("track sector boundary routes", () => {
  test("requires validated gameId on GET", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1",
    );

    expect(response.status).toBe(400);
  });
  
  test("rejects invalid gameId on GET", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=unknown",
    );

    expect(response.status).toBe(400);
  });

  test("reports native ownership without RaceIQ fallback", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=iracing",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ownership: "game",
      editable: false,
      sectorStarts: null,
    });
  });

  test("reports editable RaceIQ timing boundaries for non-native games", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=fm-2023",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ownership: string;
      editable: boolean;
      sectorStarts: number[];
      s1End: number;
      s2End: number;
      trackLength: number;
    };
    expect(body.ownership).toBe("raceiq");
    expect(body.editable).toBe(true);
    expect(body.sectorStarts).toEqual([0, body.s1End, body.s2End]);
    expect(body.trackLength).toBeGreaterThanOrEqual(0);
  });

  test("rejects native PUT before parsing malformed body", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=iracing",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{ malformed",
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "native-sectors-read-only",
      message: "Native sector boundaries are supplied by the game and cannot be edited",
    });
  });

  test("keeps ordered-fraction validation for non-native PUT", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=fm-2023",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ s1End: 0.7, s2End: 0.3 }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid sector boundaries: need 0 < s1End < s2End < 1",
    });
  });
});
