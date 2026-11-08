import { describe, expect, test } from "bun:test";
import { getAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { getTrackBoundariesById } from "@raceiq/game-catalogs/racing/tracks/geometry/extracted";
import { getTrackOutlineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";

describe("AC Evo native track geometry", () => {
  test("resolves curated geometry by native identity and safely misses unknown layouts", () => {
    const tracks = [...getAcEvoTracks().values()];
    const curated = tracks.find((track) =>
      track.commonTrackName
      && getTrackOutlineById(track.id, "ac-evo", track.commonTrackName)
      && getTrackBoundariesById(track.id, "ac-evo"));
    expect(curated).toBeDefined();
    expect(getTrackOutlineById(curated!.id, "ac-evo", curated!.commonTrackName)).not.toBeNull();
    expect(getTrackBoundariesById(curated!.id, "ac-evo")).not.toBeNull();
    const unknownId = JSON.stringify(["Definitely Unknown Track", "Unknown Layout"]);
    expect(getTrackOutlineById(unknownId, "ac-evo")).toBeNull();
    expect(getTrackBoundariesById(unknownId, "ac-evo")).toBeNull();
  });
});
