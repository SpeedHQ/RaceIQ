import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { discoveredTracks } from "@raceiq/backend-core/db/schema";
import { registerAcEvoTrack } from "@raceiq/backend-core/db/discovered-tracks";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { deleteRecordedOutlineById, getRecordedOutlineById, recordOpenLapTraceById, recordLapTraceById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { initServerGameAdapters } from "../../src/games/init";
import { trackOutlineRoutes } from "../../src/routes/tracks/outline-routes";
import { trackGeometryRoutes } from "../../src/routes/tracks/geometry-routes";
import { trackSectorBoundaryRoutes, trackSegmentRoutes } from "../../src/routes/tracks/segments-routes";

initGameAdapters();
initServerGameAdapters();

test("Tourist geometry never falls back to closed circuit maps or sectors", async () => {
  const trackId = await registerAcEvoTrack("Nurburgring", "Touristenfahrten");
  const original = getRecordedOutlineById(trackId, "ac-evo");
  deleteRecordedOutlineById(trackId, "ac-evo");
  try {
    const suffix = `${encodeURIComponent(trackId)}?gameId=ac-evo`;
    const empty = await trackOutlineRoutes.request(`/api/track-outline/${suffix}`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ points: [], closed: false, source: "none", pitLines: [] });
    const boundaries = await trackGeometryRoutes.request(`/api/track-boundaries/${suffix}`);
    expect(await boundaries.json()).toBeNull();
    const emptySegments = await trackSegmentRoutes.request(`/api/track-sectors/${suffix}`);
    expect(await emptySegments.json()).toEqual({ segments: [] });
    const trace = Array.from({ length: 100 }, (_, index) => ({ x: index * 10, z: 0 }));
    recordOpenLapTraceById(trackId, trace, "ac-evo");
    const recorded = await trackOutlineRoutes.request(`/api/track-outline/${suffix}`);
    const recordedData = await recorded.json() as { points: { x: number; z: number }[]; closed: boolean; source: string; pitLines: unknown[] };
    expect(recordedData).toMatchObject({ closed: false, source: "recorded", pitLines: [] });
    // Applying the replay display flip must recover the recorded telemetry positions.
    for (let index = 0; index < trace.length; index++) {
      expect(Math.hypot(-recordedData.points[index].x - trace[index].x, recordedData.points[index].z - trace[index].z)).toBeLessThan(1e-6);
    }
    const unrelatedBoundaries = await trackGeometryRoutes.request(`/api/track-boundaries/${suffix}`);
    expect(await unrelatedBoundaries.json()).toBeNull();
    const sectors = await trackSectorBoundaryRoutes.request(`/api/track-sector-boundaries/${suffix}`);
    expect(await sectors.json()).toEqual({ s1End: 1 / 3, s2End: 2 / 3, trackLength: 990 });
    const segments = await trackSegmentRoutes.request(`/api/track-sectors/${suffix}`);
    expect(await segments.json()).toEqual({ source: "auto", totalDist: 990, segments: [] });
  } finally {
    deleteRecordedOutlineById(trackId, "ac-evo");
    if (original) recordLapTraceById(trackId, original, null, null, "ac-evo");
    await db.delete(discoveredTracks).where(and(eq(discoveredTracks.gameId, "ac-evo"), eq(discoveredTracks.trackId, trackId))).run();
  }
});
