import { cars, tracks } from "./parser-data.generated";

function normalizeCatalogName(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, "");
}

export function getAcEvoParserCarByDisplayName(displayName: string) {
  const needle = displayName.toLowerCase().trim();
  for (const car of cars) if (car.name.toLowerCase() === needle) return car;
  const normalized = needle.replace(/[-_\s]/g, "");
  if (!normalized) return undefined;
  return cars.find((car) =>
    car.name.toLowerCase().replace(/[-_\s]/g, "") === normalized
    || car.model.toLowerCase().replace(/[-_\s]/g, "") === normalized
  );
}

export function getAcEvoParserTrackByName(trackName: string, config?: string) {
  const needle = normalizeCatalogName(trackName);
  if (!needle) return undefined;
  const exact = (target: string) => tracks.find((track) =>
    normalizeCatalogName(track.commonTrackName) === target
    || normalizeCatalogName(track.name) === target
    || normalizeCatalogName(`${track.name}${track.variant}`) === target
  );
  if (config) {
    const configured = normalizeCatalogName(`${trackName}${config}`);
    if (configured !== needle) {
      const match = exact(configured);
      if (match) return match;
    }
  }
  const exactMatch = exact(needle);
  if (exactMatch) return exactMatch;
  let best: (typeof tracks)[number] | undefined;
  let bestLength = 0;
  for (const track of tracks) {
    for (const candidate of [track.commonTrackName, track.name].map(normalizeCatalogName)) {
      if (!candidate || !(candidate.includes(needle) || needle.includes(candidate))) continue;
      const length = Math.min(candidate.length, needle.length);
      if (length > bestLength) {
        best = track;
        bestLength = length;
      }
    }
  }
  return best;
}
