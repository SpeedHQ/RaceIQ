import { cars, tracks } from "@raceiq/game-acc-metadata/parser-data";

const carPairs = cars
  .filter((car) => cars.filter((other) => other.model === car.model).length === 1)
  .map(({ id, model }) => [String(id), model] as const);
const trackPairs = tracks
  .filter((track) => tracks.filter((other) => other.setupFolder === track.setupFolder).length === 1)
  .map(({ id, setupFolder }) => [String(id), setupFolder] as const);

export function accLegacyAlternatives(kind: "car" | "track", value: string): string[] {
  const pairs = kind === "car" ? carPairs : trackPairs;
  const pair = pairs.find(([ordinal, native]) => ordinal === value || native === value);
  return pair ? [value, pair[0] === value ? pair[1] : pair[0]] : [value];
}

export function accLegacyPairs(kind: "car" | "track"): readonly (readonly [string, string])[] {
  return kind === "car" ? carPairs : trackPairs;
}
