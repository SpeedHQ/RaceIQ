import type { GameId } from "../../shared/games/ids";
import { getF1Tracks } from "../../shared/racing/tracks/catalogs/f1";
import { fmTrackCatalog } from "../../shared/racing/tracks/catalogs/fm";
import { getAllIRacingTracks } from "../../shared/racing/tracks/catalogs/iracing";
import {
  parseCanonicalTrackId,
  parseVenueRevisionPath,
  TrackVenueMetadataSchema,
  type TrackVenueMetadata,
} from "../../shared/racing/tracks/configuration";
import {
  loadTrackRegistrySource,
  type TrackRegistrySource,
  updateTrackRegistrySource,
} from "../../shared/racing/tracks/registry-source";

export interface VenueMetadataCatalogTrack {
  gameId: GameId;
  ordinal: number;
  name: string;
  location: string;
  country: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
}

interface VenueCandidate {
  metadata: TrackVenueMetadata;
  trackName: string;
}

export interface VenueMetadataSeed {
  metadataByVenue: ReadonlyMap<string, TrackVenueMetadata>;
  unavailableVenueIds: readonly string[];
}

const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  ARE: "United Arab Emirates",
  AUS: "Australia",
  AZE: "Azerbaijan",
  BHR: "Bahrain",
  CHN: "China",
  FRA: "France",
  JP: "Japan",
  JPN: "Japan",
  MCO: "Monaco",
  QAT: "Qatar",
  RSA: "South Africa",
  RUS: "Russia",
  SAU: "Saudi Arabia",
  SGP: "Singapore",
  UAE: "United Arab Emirates",
  USA: "USA",
  VNM: "Vietnam",
};

const GAME_PRIORITY: Readonly<Record<GameId, number>> = {
  iracing: 0,
  "f1-2025": 1,
  "fm-2023": 2,
  acc: 3,
  "ac-evo": 4,
};

interface CuratedGeography {
  latitude: number;
  longitude: number;
  timeZone: string;
  coordinatesSource: {
    name: string;
    url: string;
  };
}

const CURATED_FALLBACKS: Readonly<Record<string, TrackVenueMetadata>> = {
  "circuit-ricardo-tormo": {
    venueType: "real",
    location: "Cheste, Valencia",
    country: "Spain",
    source: {
      name: "Circuit Ricardo Tormo",
      url: "https://www.circuitricardotormo.com/en/contact/",
    },
  },
  sepang: {
    venueType: "real",
    location: "Sepang, Selangor",
    country: "Malaysia",
    source: {
      name: "Sepang International Circuit",
      url: "https://www.sepangcircuit.com/contact-details",
    },
  },
};

const FICTIONAL_VENUES: Readonly<Record<string, true>> = {
  "centripetal-circuit": true,
  "eaglerock-speedway": true,
  "fujimi-kaido": true,
  "grand-oak-raceway": true,
  hakone: true,
  "iracing-superspeedway": true,
  "maple-valley": true,
  "sunset-peninsula": true,
};

const CURATED_GEOGRAPHY: Readonly<Record<string, CuratedGeography>> = {
  "bahrain-international-circuit": {
    latitude: 26.0311459,
    longitude: 50.5143663,
    timeZone: "Asia/Bahrain",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/156351878" },
  },
  "baku-city-circuit": {
    latitude: 40.372926,
    longitude: 49.8529715,
    timeZone: "Asia/Baku",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/822375068" },
  },
  "circuit-de-monaco": {
    latitude: 43.7333314,
    longitude: 7.422466,
    timeZone: "Europe/Monaco",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/1081401615" },
  },
  "circuit-paul-ricard": {
    latitude: 43.2524963,
    longitude: 5.7943002,
    timeZone: "Europe/Paris",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/242942298" },
  },
  "circuit-ricardo-tormo": {
    latitude: 39.4858132,
    longitude: -0.6286386,
    timeZone: "Europe/Madrid",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/556951684" },
  },
  "hanoi-street-circuit": {
    latitude: 21.0156892,
    longitude: 105.7629208,
    timeZone: "Asia/Ho_Chi_Minh",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/560585104" },
  },
  "jeddah-corniche-circuit": {
    latitude: 21.6389166,
    longitude: 39.1021111,
    timeZone: "Asia/Riyadh",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/1359884763" },
  },
  "kyalami-grand-prix-circuit": {
    latitude: -25.9972974,
    longitude: 28.0666476,
    timeZone: "Africa/Johannesburg",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/1359379882" },
  },
  "las-vegas-street-circuit": {
    latitude: 36.1089743,
    longitude: -115.1622208,
    timeZone: "America/Los_Angeles",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/1456078470" },
  },
  "lusail-international-circuit": {
    latitude: 25.4896575,
    longitude: 51.4528849,
    timeZone: "Asia/Qatar",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/152483594" },
  },
  "marina-bay-street-circuit": {
    latitude: 1.2912718,
    longitude: 103.8642605,
    timeZone: "Asia/Singapore",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/686335807" },
  },
  "melbourne-grand-prix-circuit": {
    latitude: -37.8452062,
    longitude: 144.957105,
    timeZone: "Australia/Melbourne",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/relation/2397461" },
  },
  sepang: {
    latitude: 2.7602187,
    longitude: 101.7368758,
    timeZone: "Asia/Kuala_Lumpur",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/144292569" },
  },
  "shanghai-international-circuit": {
    latitude: 31.3399793,
    longitude: 121.2195976,
    timeZone: "Asia/Shanghai",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/156311798" },
  },
  "sochi-autodrom": {
    latitude: 43.402979,
    longitude: 39.9508718,
    timeZone: "Europe/Moscow",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/way/234329382" },
  },
  "yas-marina-circuit": {
    latitude: 24.471847,
    longitude: 54.6058021,
    timeZone: "Asia/Dubai",
    coordinatesSource: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/relation/6941673" },
  },
};

function candidate(track: VenueMetadataCatalogTrack): VenueCandidate | null {
  const rawCountry = track.country.trim();
  const country = COUNTRY_NAMES[rawCountry.toUpperCase()] ?? rawCountry;
  if (!country) return null;

  const explicitLocation = track.location.trim();
  const hasCoordinates = explicitLocation.length > 0
    && track.latitude !== undefined
    && track.longitude !== undefined;
  const parsed = TrackVenueMetadataSchema.safeParse({
    venueType: "real",
    location: explicitLocation || country,
    country,
    ...(hasCoordinates ? { latitude: track.latitude, longitude: track.longitude } : {}),
    ...(explicitLocation && track.timeZone?.trim() ? { timeZone: track.timeZone.trim() } : {}),
    source: { gameId: track.gameId, trackOrdinal: track.ordinal },
  });
  return parsed.success ? { metadata: parsed.data, trackName: track.name } : null;
}

function selectVenueMetadata(candidates: readonly VenueCandidate[]): TrackVenueMetadata {
  const selectedGame = candidates.reduce((best, entry) => {
    const gameId = "gameId" in entry.metadata.source ? entry.metadata.source.gameId : null;
    if (!gameId) return best;
    return best === null || GAME_PRIORITY[gameId] < GAME_PRIORITY[best] ? gameId : best;
  }, null as GameId | null);
  if (!selectedGame) throw new Error("Cannot select venue metadata without a game source");

  const sameGame = candidates.filter(({ metadata }) =>
    "gameId" in metadata.source && metadata.source.gameId === selectedGame);
  const nonLegacy = sameGame.filter(({ trackName }) => !trackName.startsWith("[Legacy]"));
  const preferred = nonLegacy.length > 0 ? nonLegacy : sameGame;
  const bySignature = new Map<string, VenueCandidate[]>();
  for (const entry of preferred) {
    const { source: _source, ...fields } = entry.metadata;
    const key = JSON.stringify(fields);
    const entries = bySignature.get(key) ?? [];
    entries.push(entry);
    bySignature.set(key, entries);
  }

  const selected = [...bySignature.entries()]
    .sort(([aKey, a], [bKey, b]) => {
      const byCount = b.length - a.length;
      if (byCount !== 0) return byCount;
      const latestA = a.reduce((latest, { metadata }) =>
        Math.max(latest, "trackOrdinal" in metadata.source ? metadata.source.trackOrdinal : -1), -1);
      const latestB = b.reduce((latest, { metadata }) =>
        Math.max(latest, "trackOrdinal" in metadata.source ? metadata.source.trackOrdinal : -1), -1);
      return latestB - latestA || aKey.localeCompare(bKey);
    })[0]?.[1];
  if (!selected) throw new Error("Cannot select venue metadata without candidates");

  return selected.reduce((latest, entry) => {
    const latestOrdinal = "trackOrdinal" in latest.metadata.source ? latest.metadata.source.trackOrdinal : -1;
    const entryOrdinal = "trackOrdinal" in entry.metadata.source ? entry.metadata.source.trackOrdinal : -1;
    return entryOrdinal > latestOrdinal ? entry : latest;
  }).metadata;
}

export function deriveVenueMetadata(
  source: TrackRegistrySource,
  tracks: readonly VenueMetadataCatalogTrack[],
  curatedFallbacks: Readonly<Record<string, TrackVenueMetadata>> = CURATED_FALLBACKS,
): VenueMetadataSeed {
  const tracksByKey = new Map(tracks.map((track) => [`${track.gameId}\0${track.ordinal}`, track]));
  const candidatesByVenue = new Map<string, VenueCandidate[]>();

  for (const assignment of source.configurations.assignments) {
    const track = tracksByKey.get(`${assignment.gameId}\0${assignment.trackOrdinal}`);
    if (!track) continue;
    const venueCandidate = candidate(track);
    if (!venueCandidate) continue;

    const { venuePath } = parseCanonicalTrackId(assignment.layoutId);
    const { rootVenuePath } = parseVenueRevisionPath(venuePath);
    const entries = candidatesByVenue.get(rootVenuePath) ?? [];
    entries.push(venueCandidate);
    candidatesByVenue.set(rootVenuePath, entries);
  }

  const metadataByVenue = new Map<string, TrackVenueMetadata>();
  for (const [venueId, candidates] of candidatesByVenue) {
    metadataByVenue.set(venueId, selectVenueMetadata(candidates));
  }
  for (const [venueId, metadata] of Object.entries(curatedFallbacks)) {
    if (!metadataByVenue.has(venueId)) metadataByVenue.set(venueId, TrackVenueMetadataSchema.parse(metadata));
  }

  for (const [venueId, metadata] of metadataByVenue) {
    if (FICTIONAL_VENUES[venueId]) {
      metadataByVenue.set(venueId, TrackVenueMetadataSchema.parse({
        venueType: "fictional",
        location: metadata.location,
        country: metadata.country,
        source: metadata.source,
      }));
      continue;
    }
    metadataByVenue.set(venueId, TrackVenueMetadataSchema.parse({
      ...metadata,
      venueType: "real",
      ...(CURATED_GEOGRAPHY[venueId] ?? {}),
    }));
  }

  const rootVenueIds = source.configurations.venues
    .filter(({ id }) => parseVenueRevisionPath(id).rootVenuePath === id)
    .map(({ id }) => id)
    .sort();
  return {
    metadataByVenue,
    unavailableVenueIds: rootVenueIds.filter((venueId) => !metadataByVenue.has(venueId)),
  };
}

function metadataChanges(source: TrackRegistrySource, seed: VenueMetadataSeed): number {
  let changes = 0;
  for (const venue of source.configurations.venues) {
    if (parseVenueRevisionPath(venue.id).rootVenuePath !== venue.id) continue;
    const next = seed.metadataByVenue.get(venue.id);
    if (next && JSON.stringify(venue.metadata) !== JSON.stringify(next)) changes += 1;
  }
  return changes;
}

function applyMetadata(source: TrackRegistrySource, seed: VenueMetadataSeed): void {
  for (const venue of source.configurations.venues) {
    if (parseVenueRevisionPath(venue.id).rootVenuePath !== venue.id) continue;
    const metadata = seed.metadataByVenue.get(venue.id);
    if (metadata) venue.metadata = metadata;
  }
}

function catalogTracks(): VenueMetadataCatalogTrack[] {
  const tracks: VenueMetadataCatalogTrack[] = getAllIRacingTracks().map((track) => ({
    gameId: "iracing",
    ordinal: track.ordinal,
    name: track.name,
    location: track.location,
    country: track.country,
    latitude: track.latitude,
    longitude: track.longitude,
    timeZone: track.timeZone,
  }));
  for (const [ordinal, track] of getF1Tracks()) {
    tracks.push({
      gameId: "f1-2025",
      ordinal,
      name: track.name,
      location: track.location,
      country: track.country,
    });
  }
  for (const [ordinal, track] of fmTrackCatalog) {
    tracks.push({
      gameId: "fm-2023",
      ordinal,
      name: track.name,
      location: track.location,
      country: track.country,
    });
  }
  return tracks;
}

function main(): void {
  const check = process.argv.includes("--check");
  const source = loadTrackRegistrySource();
  const seed = deriveVenueMetadata(source, catalogTracks());
  const changes = metadataChanges(source, seed);

  if (check) {
    if (changes > 0) {
      throw new Error(`${changes} venue metadata records are stale; run bun run tracks:venue-metadata:seed`);
    }
  } else if (changes > 0) {
    updateTrackRegistrySource((draft) => applyMetadata(draft, seed));
  }

  console.log(
    `[Venue Metadata] ${seed.metadataByVenue.size} populated, `
      + `${seed.unavailableVenueIds.length} unavailable, ${changes} ${check ? "stale" : "updated"}`,
  );
}

if (import.meta.main) main();
