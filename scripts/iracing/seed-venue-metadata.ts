import { getAllIRacingTracks, type IRacingCatalogTrack } from "../../shared/racing/tracks/catalogs/iracing";
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

interface VenueCandidate {
  metadata: Omit<TrackVenueMetadata, "source">;
  track: IRacingCatalogTrack;
}

const IRACING_VENUE_FIELDS_SCHEMA = TrackVenueMetadataSchema.omit({ source: true });

export interface IRacingVenueMetadataSeed {
  metadataByVenue: ReadonlyMap<string, TrackVenueMetadata>;
  unavailableVenueIds: readonly string[];
}

function candidate(track: IRacingCatalogTrack): VenueCandidate | null {
  const metadata = {
    location: track.location.trim(),
    country: track.country.trim(),
    latitude: track.latitude,
    longitude: track.longitude,
    timeZone: track.timeZone.trim(),
  };
  if (!metadata.location || !metadata.country || !metadata.timeZone) return null;

  const parsed = IRACING_VENUE_FIELDS_SCHEMA.safeParse(metadata);
  return parsed.success ? { metadata: parsed.data, track } : null;
}


function selectVenueMetadata(candidates: readonly VenueCandidate[]): TrackVenueMetadata {
  const nonLegacy = candidates.filter(({ track }) => !track.name.startsWith("[Legacy]"));
  const preferred = nonLegacy.length > 0 ? nonLegacy : candidates;
  const bySignature = new Map<string, VenueCandidate[]>();
  for (const entry of preferred) {
    const key = JSON.stringify(entry.metadata);
    const entries = bySignature.get(key) ?? [];
    entries.push(entry);
    bySignature.set(key, entries);
  }

  const selected = [...bySignature.entries()]
    .sort(([aKey, a], [bKey, b]) => {
      const byCount = b.length - a.length;
      if (byCount !== 0) return byCount;
      const byLatestTrack = Math.max(...b.map(({ track }) => track.ordinal))
        - Math.max(...a.map(({ track }) => track.ordinal));
      return byLatestTrack || aKey.localeCompare(bKey);
    })[0]?.[1];
  if (!selected) throw new Error("Cannot select iRacing venue metadata without candidates");

  const representative = selected.reduce((latest, entry) =>
    entry.track.ordinal > latest.track.ordinal ? entry : latest);
  return TrackVenueMetadataSchema.parse({
    ...representative.metadata,
    source: {
      gameId: "iracing",
      trackOrdinal: representative.track.ordinal,
    },
  });
}

export function deriveIRacingVenueMetadata(
  source: TrackRegistrySource,
  tracks: readonly IRacingCatalogTrack[],
): IRacingVenueMetadataSeed {
  const tracksByOrdinal = new Map(tracks.map((track) => [track.ordinal, track]));
  const candidatesByVenue = new Map<string, VenueCandidate[]>();

  for (const assignment of source.configurations.assignments) {
    if (assignment.gameId !== "iracing") continue;
    const track = tracksByOrdinal.get(assignment.trackOrdinal);
    if (!track) throw new Error(`Missing iRacing catalog track ${assignment.trackOrdinal}`);
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

  const rootVenueIds = source.configurations.venues
    .filter(({ id }) => parseVenueRevisionPath(id).rootVenuePath === id)
    .map(({ id }) => id)
    .sort();
  return {
    metadataByVenue,
    unavailableVenueIds: rootVenueIds.filter((venueId) => !metadataByVenue.has(venueId)),
  };
}

function metadataChanges(source: TrackRegistrySource, seed: IRacingVenueMetadataSeed): number {
  let changes = 0;
  for (const venue of source.configurations.venues) {
    if (parseVenueRevisionPath(venue.id).rootVenuePath !== venue.id) continue;
    const next = seed.metadataByVenue.get(venue.id);
    if (next) {
      if (JSON.stringify(venue.metadata) !== JSON.stringify(next)) changes += 1;
    } else if (venue.metadata?.source.gameId === "iracing") {
      changes += 1;
    }
  }
  return changes;
}

function applyMetadata(source: TrackRegistrySource, seed: IRacingVenueMetadataSeed): void {
  for (const venue of source.configurations.venues) {
    if (parseVenueRevisionPath(venue.id).rootVenuePath !== venue.id) continue;
    const metadata = seed.metadataByVenue.get(venue.id);
    if (metadata) venue.metadata = metadata;
    else if (venue.metadata?.source.gameId === "iracing") delete venue.metadata;
  }
}

function main(): void {
  const check = process.argv.includes("--check");
  const source = loadTrackRegistrySource();
  const seed = deriveIRacingVenueMetadata(source, getAllIRacingTracks());
  const changes = metadataChanges(source, seed);

  if (check) {
    if (changes > 0) {
      throw new Error(`${changes} venue metadata records are stale; run bun run iracing:venue-metadata:seed`);
    }
  } else if (changes > 0) {
    updateTrackRegistrySource((draft) => applyMetadata(draft, seed));
  }

  console.log(
    `[iRacing Venue Metadata] ${seed.metadataByVenue.size} populated, `
      + `${seed.unavailableVenueIds.length} unavailable, ${changes} ${check ? "stale" : "updated"}`,
  );
}

if (import.meta.main) main();
