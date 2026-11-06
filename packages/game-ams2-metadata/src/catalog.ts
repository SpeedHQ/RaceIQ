import cars from "./cars.json";
import tracks from "./tracks.json";

// Server inventory plus explicit compatibility mappings for recorded identities.
export const ams2CarCatalog = cars;
export const ams2TrackCatalog = tracks;
export type AMS2CatalogTrack = (typeof tracks)[number];
const tracksById = new Map(tracks.map(track => [track.id, track]));
const tracksByLayout = new Map(tracks.map(track => [track.layout.toLowerCase(), track]));
const tracksByTelemetryName = new Map(tracks.filter(track => track.telemetryName !== null).map(track => [track.telemetryName!.toLowerCase(), track]));
export function findAMS2CatalogTrack(id: string): AMS2CatalogTrack | undefined { return tracksById.get(id); }
export function findAMS2TrackByTelemetryName(name: string): AMS2CatalogTrack | undefined {
  const key=name.trim().toLowerCase();
  const exact=tracksByTelemetryName.get(key);
  if(exact) return exact;
  // Match only the exact, globally unique source layout, never a fuzzy display name.
  const variation=name.split(" - ");
  return variation.length === 2 ? tracksByLayout.get(variation[1].trim().toLowerCase()) : undefined;
}
