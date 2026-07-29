import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  getAllIRacingTracks,
  getIRacingSharedTrackName,
  getIRacingTrackName,
  getIRacingTrackOrdinalByName,
} from "../shared/iracing-track-data";
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { registerDiscoveredTrack } from "../server/db/discovered-tracks";
import { db } from "../server/db/index";
import { discoveredTracks } from "../server/db/schema";
import { trackRoutes } from "../server/routes/track-routes";

const FUTURE_TRACK_ID = 987_654_322;

async function cleanup(): Promise<void> {
  await db
    .delete(discoveredTracks)
    .where(
      and(
        eq(discoveredTracks.ordinal, FUTURE_TRACK_ID),
        eq(discoveredTracks.gameId, "iracing"),
      ),
    )
    .run();
}

beforeEach(cleanup);
afterEach(cleanup);

describe("iRacing track catalog", () => {
  test("contains every non-retired native layout and its public SVG map", () => {
    const tracks = getAllIRacingTracks();

    expect(tracks).toHaveLength(425);
    expect(new Set(tracks.map((track) => track.ordinal)).size).toBe(
      tracks.length,
    );
    expect(new Set(tracks.map((track) => track.path)).size).toBe(
      tracks.length,
    );
    expect(
      tracks.every((track) =>
        track.mapUrl.startsWith(
          "https://members-assets.iracing.com/public/track-maps/",
        ),
      ),
    ).toBe(true);
    expect(tracks.some((track) => track.name.startsWith("[Retired]"))).toBe(
      false,
    );
  });

  test("uses native configuration IDs and only aliases exact shared layouts", () => {
    expect(getIRacingTrackName(18)).toBe(
      "Road America - Full Course",
    );
    expect(getIRacingSharedTrackName(18)).toBe("road-america");
    expect(getIRacingTrackOrdinalByName("tracks\\roadamerica\\full")).toBe(
      18,
    );
    expect(getTrackOutlineByOrdinal(18, "iracing")).not.toBeNull();

    // Summit Point's native ID collides with another game's ordinal. It must
    // not inherit that unrelated centerline merely because the number matches.
    expect(getIRacingSharedTrackName(8)).toBeUndefined();
    expect(getTrackOutlineByOrdinal(8, "iracing")).toBeNull();
  });

  test("serves every official SVG as a renderable outline source", async () => {
    await registerDiscoveredTrack(
      "iracing",
      FUTURE_TRACK_ID,
      "Future Test Circuit",
    );
    const response = await trackRoutes.request(
      "/api/tracks?gameId=iracing",
    );

    expect(response.status).toBe(200);
    const tracks = (await response.json()) as Array<{
      ordinal: number;
      hasOutline: boolean;
      hasMap: boolean;
      mapUrl: string | null;
      commonTrackName: string | null;
    }>;
    expect(tracks).toHaveLength(426);
    expect(tracks.find((track) => track.ordinal === 18)).toMatchObject({
      hasOutline: true,
      hasMap: true,
      commonTrackName: "road-america",
    });
    expect(tracks.find((track) => track.ordinal === 8)).toMatchObject({
      hasOutline: true,
      hasMap: true,
      commonTrackName: null,
    });
    expect(
      tracks.find((track) => track.ordinal === FUTURE_TRACK_ID),
    ).toMatchObject({
      hasOutline: false,
      hasMap: false,
      mapUrl: null,
    });
  });
});
