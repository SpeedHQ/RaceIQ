import { expect, test } from "bun:test";
import { getOrCreateDiscoveredTrack } from "@raceiq/backend-core/db/discovered-tracks";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { deleteRecordedOutline, getRecordedOutlineByOrdinal, recordLapTrace } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { initServerGameAdapters } from "../../src/games/init";
import { trackOutlineRoutes } from "../../src/routes/tracks/outline-routes";
import { trackGeometryRoutes } from "../../src/routes/tracks/geometry-routes";
import { trackSectorBoundaryRoutes, trackSegmentRoutes } from "../../src/routes/tracks/segments-routes";

initGameAdapters();
initServerGameAdapters();

test("Tourist geometry never falls back to closed circuit maps or sectors", async () => {
  const ordinal = await getOrCreateDiscoveredTrack("ac-evo", "nurburgring", "touristenfahrten");
  const original = getRecordedOutlineByOrdinal(ordinal, "ac-evo");
  deleteRecordedOutline(ordinal, "ac-evo");
  try {
    const suffix = `${ordinal}?gameId=ac-evo`;
    const empty = await trackOutlineRoutes.request(`/api/track-outline/${suffix}`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ points: [], closed: false, source: "none", pitLines: [] });
    const boundaries = await trackGeometryRoutes.request(`/api/track-boundaries/${suffix}`);
    expect(await boundaries.json()).toBeNull();
    const emptySegments = await trackSegmentRoutes.request(`/api/track-sectors/${suffix}`);
    expect(await emptySegments.json()).toEqual({ segments: [] });
    const trace = Array.from({ length: 100 }, (_, index) => ({ x: index * 10, z: 0 }));
    recordLapTrace(ordinal, trace, null, null, "ac-evo");
    const recorded = await trackOutlineRoutes.request(`/api/track-outline/${suffix}`);
    expect(await recorded.json()).toMatchObject({ points: trace, closed: false, source: "recorded", pitLines: [] });
    const sectors = await trackSectorBoundaryRoutes.request(`/api/track-sector-boundaries/${suffix}`);
    expect(await sectors.json()).toEqual({ s1End: 1 / 3, s2End: 2 / 3, trackLength: 990 });
    const segments = await trackSegmentRoutes.request(`/api/track-sectors/${suffix}`);
    expect(await segments.json()).toEqual({ source: "auto", totalDist: 990, segments: [] });
  } finally {
    deleteRecordedOutline(ordinal, "ac-evo");
    if (original) recordLapTrace(ordinal, original, null, null, "ac-evo");
  }
});
