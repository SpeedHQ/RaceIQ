import { describe, test, expect } from "bun:test";
import {
  getAcEvoTrackByName,
  getAcEvoTrackBySetupFolder,
  getAcEvoTracks,
  injectDiscoveredAcEvoTracks,
} from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { acEvoTrackId, isAcEvoTouristLayout, parseAcEvoTrackId } from "@raceiq/game-ac-evo-metadata/identity";

describe("AC Evo native track lookup", () => {
  test("restricts Tourist geometry exceptions to the native venue and layout", () => {
    expect(isAcEvoTouristLayout(parseAcEvoTrackId(acEvoTrackId(" NURBURGRING ", " Touristenfahrten ")))).toBe(true);
    for (const [venue, layout] of [
      ["Nurburgring", "Grand Prix"],
      ["Nurburgring", "Nordschleife"],
      ["Spa-Francorchamps", "Touristenfahrten"],
      ["Nurburgring", "Tourist"],
    ]) {
      expect(isAcEvoTouristLayout(parseAcEvoTrackId(acEvoTrackId(venue, layout)))).toBe(false);
    }
    expect(isAcEvoTouristLayout(parseAcEvoTrackId("invalid"))).toBe(false);
  });

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

  test("keeps curated geometry and setup metadata when a known track is discovered", () => {
    const id = acEvoTrackId("Spa-Francorchamps", "GP");
    injectDiscoveredAcEvoTracks([
      { id, name: "Spa-Francorchamps", trackName: "Spa-Francorchamps", trackConfiguration: "GP" },
    ]);

    expect(getAcEvoTracks().get(id)).toMatchObject({ commonTrackName: "spa", setupFolder: "spa" });
    expect(getAcEvoTrackByName("Spa-Francorchamps", "GP")).toMatchObject({ commonTrackName: "spa", setupFolder: "spa" });
    expect(getAcEvoTrackBySetupFolder("spa")?.id).toBe(id);
  });
});
