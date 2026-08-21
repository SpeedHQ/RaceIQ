import { expect, test } from "bun:test";
import {
  deriveVenueMetadata,
  type VenueMetadataCatalogTrack,
} from "../../scripts/tracks/seed-venue-metadata";
import { TRACK_REGISTRY_SOURCE_VERSION, type TrackRegistrySource } from "../../shared/racing/tracks/registry-source";

function catalogTrack(
  gameId: VenueMetadataCatalogTrack["gameId"],
  ordinal: number,
  overrides: Partial<VenueMetadataCatalogTrack> = {},
): VenueMetadataCatalogTrack {
  return {
    gameId,
    ordinal,
    name: `Track ${ordinal}`,
    location: "Town, Region",
    country: "Country",
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
      { id: "maple-valley", name: "Maple Valley" },
      { id: "manual", name: "Manual" },
      { id: "iracing-superspeedway", name: "iRacing Superspeedway" },
      { id: "bahrain-international-circuit", name: "Bahrain International Circuit" },
    ],
    layouts: [],
    assignments: [
      { gameId: "iracing", trackOrdinal: 1, layoutId: "alpha/legacy", confirmation: null },
      { gameId: "iracing", trackOrdinal: 2, layoutId: "alpha/main-a", confirmation: null },
      { gameId: "iracing", trackOrdinal: 3, layoutId: "alpha/main-b", confirmation: null },
      { gameId: "iracing", trackOrdinal: 4, layoutId: "alpha/outlier", confirmation: null },
      { gameId: "iracing", trackOrdinal: 5, layoutId: "beta/legacy", confirmation: null },
      { gameId: "iracing", trackOrdinal: 6, layoutId: "beta/main", confirmation: null },
      { gameId: "fm-2023", trackOrdinal: 7, layoutId: "maple-valley/main", confirmation: null },
      { gameId: "iracing", trackOrdinal: 8, layoutId: "iracing-superspeedway/main", confirmation: null },
      { gameId: "f1-2025", trackOrdinal: 9, layoutId: "bahrain-international-circuit/main", confirmation: null },
    ],
  },
  facts: { version: TRACK_REGISTRY_SOURCE_VERSION, facts: [] },
  geometry: { version: TRACK_REGISTRY_SOURCE_VERSION, geometry: [] },
  verification: { version: TRACK_REGISTRY_SOURCE_VERSION, entries: {} },
};

test("selects authoritative metadata and preserves honest partial locations", () => {
  const tracks = [
    catalogTrack("iracing", 1, { name: "[Legacy] Alpha", latitude: 90, longitude: 90 }),
    catalogTrack("iracing", 2),
    catalogTrack("iracing", 3),
    catalogTrack("iracing", 4, { latitude: 10, longitude: 20 }),
    catalogTrack("iracing", 5, { name: "[Legacy] Beta", latitude: 30, longitude: 40 }),
    catalogTrack("iracing", 6, { name: "Beta", latitude: 50, longitude: 60 }),
    catalogTrack("fm-2023", 7, {
      location: "Iowa",
      country: "usa",
      latitude: undefined,
      longitude: undefined,
      timeZone: undefined,
    }),
    catalogTrack("iracing", 8, { location: "Chelmsford, Massachusetts", country: "USA" }),
    catalogTrack("f1-2025", 9, {
      location: "Sakhir",
      country: "BHR",
      latitude: undefined,
      longitude: undefined,
      timeZone: undefined,
    }),
  ];
  const manual = {
    manual: {
      venueType: "real",
      location: "Manual City",
      country: "Manual Country",
      source: { name: "Official venue", url: "https://example.com/venue" },
    },
  } as const;

  const seeded = deriveVenueMetadata(source, tracks, manual);

  expect(seeded.metadataByVenue.get("alpha")).toEqual({
    venueType: "real",
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
  expect(seeded.metadataByVenue.get("maple-valley")).toEqual({
    venueType: "fictional",
    location: "Iowa",
    country: "USA",
    source: { gameId: "fm-2023", trackOrdinal: 7 },
  });
  expect(seeded.metadataByVenue.get("manual")).toEqual(manual.manual);
  expect(seeded.metadataByVenue.get("iracing-superspeedway")).toEqual({
    venueType: "fictional",
    location: "Chelmsford, Massachusetts",
    country: "USA",
    source: { gameId: "iracing", trackOrdinal: 8 },
  });
  expect(seeded.metadataByVenue.get("bahrain-international-circuit")).toMatchObject({
    venueType: "real",
    location: "Sakhir",
    country: "Bahrain",
    latitude: 26.0311459,
    longitude: 50.5143663,
    timeZone: "Asia/Bahrain",
    coordinatesSource: { url: "https://www.openstreetmap.org/way/156351878" },
  });
  expect(seeded.unavailableVenueIds).toEqual([]);
});
