import { describe, test, expect } from "bun:test";
import {
  getAcEvoTrackByName,
  getAcEvoTrackBySetupFolder,
  injectDiscoveredAcEvoTracks,
} from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";

describe("AC Evo discovered track lookup", () => {
  test("resolves exact source layouts and refuses ambiguous setup-folder names", () => {
    const trackName = "RaceIQ Identity Test Circuit";
    injectDiscoveredAcEvoTracks([
      { ordinal: 199900, name: trackName, trackName, trackConfiguration: "Grand Prix" },
      { ordinal: 199901, name: trackName, trackName, trackConfiguration: "Tourist" },
    ]);

    expect(getAcEvoTrackByName(trackName, "Grand Prix")?.id).toBe(199900);
    expect(getAcEvoTrackByName(trackName, "Tourist")?.id).toBe(199901);
    expect(getAcEvoTrackBySetupFolder(trackName)).toBeUndefined();
  });
});
