import { expect, test } from "bun:test";
import { deriveIRacingVenueMetadata } from "../../scripts/iracing/seed-venue-metadata";
import type { IRacingCatalogTrack } from "../../shared/racing/tracks/catalogs/iracing";
import { TRACK_REGISTRY_SOURCE_VERSION, type TrackRegistrySource } from "../../shared/racing/tracks/registry-source";

function catalogTrack(
  ordinal: number,
  overrides: Partial<IRacingCatalogTrack> = {},
): IRacingCatalogTrack {
  return {
    ordinal,
    name: `Track ${ordinal}`,
    location: "Town, Region",
    country: "Country",
    variant: "Main",
    lengthKm: 1,
    commonTrackName: "",
    category: "road",
    path: `tracks\\${ordinal}`,
    mapUrl: "",
    pitMapUrl: "",
    startFinishMapUrl: "",
    turnsMapUrl: "",
    cornersPerLap: 1,
    pitRoadSpeedLimitMph: null,
    numberPitStalls: 1,
    maxCars: 1,
    nightLighting: false,
    rainEnabled: false,
    latitude: 1,
    longitude: 2,
    timeZone: "Etc/UTC",
    ...overrides,
  };
}

const source: TrackRegistrySource = {
  configurations: {
    version: TRACK_REGISTRY_SOURCE_VERSION,
    venues: [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
      { id: "missing", name: "Missing" },
    ],
    layouts: [],
    assignments: [
      { gameId: "iracing", trackOrdinal: 1, layoutId: "alpha/legacy", confirmation: null },
      { gameId: "iracing", trackOrdinal: 2, layoutId: "alpha/main-a", confirmation: null },
      { gameId: "iracing", trackOrdinal: 3, layoutId: "alpha/main-b", confirmation: null },
      { gameId: "iracing", trackOrdinal: 4, layoutId: "alpha/outlier", confirmation: null },
      { gameId: "iracing", trackOrdinal: 5, layoutId: "beta/legacy", confirmation: null },
      { gameId: "iracing", trackOrdinal: 6, layoutId: "beta/main", confirmation: null },
      { gameId: "iracing", trackOrdinal: 7, layoutId: "missing/main", confirmation: null },
    ],
  },
  facts: { version: TRACK_REGISTRY_SOURCE_VERSION, facts: [] },
  geometry: { version: TRACK_REGISTRY_SOURCE_VERSION, geometry: [] },
  verification: { version: TRACK_REGISTRY_SOURCE_VERSION, entries: {} },
};

test("selects stable non-legacy iRacing location metadata per root venue", () => {
  const tracks = [
    catalogTrack(1, { name: "[Legacy] Alpha", latitude: 90, longitude: 90 }),
    catalogTrack(2),
    catalogTrack(3),
    catalogTrack(4, { latitude: 10, longitude: 20 }),
    catalogTrack(5, { name: "[Legacy] Beta", latitude: 30, longitude: 40 }),
    catalogTrack(6, { name: "Beta", latitude: 50, longitude: 60 }),
    catalogTrack(7, { location: "" }),
  ];

  const seeded = deriveIRacingVenueMetadata(source, tracks);

  expect(seeded.metadataByVenue.get("alpha")).toEqual({
    location: "Town, Region",
    country: "Country",
    latitude: 1,
    longitude: 2,
    timeZone: "Etc/UTC",
    source: { gameId: "iracing", trackOrdinal: 3 },
  });
  expect(seeded.metadataByVenue.get("beta")).toMatchObject({
    latitude: 50,
    longitude: 60,
    source: { gameId: "iracing", trackOrdinal: 6 },
  });
  expect(seeded.unavailableVenueIds).toEqual(["missing"]);
});
