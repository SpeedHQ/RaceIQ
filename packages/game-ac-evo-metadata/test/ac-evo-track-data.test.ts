import { describe, test, expect } from "bun:test";
import {
  getAcEvoTrackByName,
  getAcEvoTrackBySetupFolder,
  getAcEvoTracks,
  injectDiscoveredAcEvoTracks,
} from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { acEvoTrackId, parseAcEvoTrackId } from "@raceiq/game-ac-evo-metadata/identity";

describe("AC Evo native track lookup", () => {
  test("uses native name and configuration to distinguish layouts", () => {
    const trackName = "RaceIQ Identity Test Circuit";
    const gpId = acEvoTrackId(trackName, "Grand Prix");
    const touristId = acEvoTrackId(trackName, "Tourist");
    injectDiscoveredAcEvoTracks([
      { id: gpId, name: trackName, trackName, trackConfiguration: "Grand Prix" },
      { id: touristId, name: trackName, trackName, trackConfiguration: "Tourist" },
    ]);

    expect(getAcEvoTrackByName(trackName, "Grand Prix")?.id).toBe(gpId);
    expect(getAcEvoTrackByName(trackName, "Tourist")?.id).toBe(touristId);
    expect(parseAcEvoTrackId(gpId)).toEqual({ trackName, trackConfiguration: "Grand Prix" });
    expect(getAcEvoTrackBySetupFolder(trackName)).toBeUndefined();
    expect(getAcEvoTracks().get(gpId)?.id).toBe(gpId);
  });
});
