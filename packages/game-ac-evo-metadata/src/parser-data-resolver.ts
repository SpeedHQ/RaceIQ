import { cars, tracks } from "./parser-data.generated";

function normalizeSourceName(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

export function getAcEvoParserCarByDisplayName(displayName: string) {
  const needle = normalizeSourceName(displayName);
  return needle ? cars.find((car) => normalizeSourceName(car.name) === needle) : undefined;
}

export function getAcEvoParserTrackByName(trackName: string, config = "") {
  const needle = JSON.stringify([normalizeSourceName(trackName), normalizeSourceName(config)]);
  if (!normalizeSourceName(trackName)) return undefined;
  return tracks.find((track) => JSON.stringify([
    normalizeSourceName(track.name),
    normalizeSourceName(track.variant),
  ]) === needle);
}
