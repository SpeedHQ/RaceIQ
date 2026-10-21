import { cars, tracks } from "./parser-data.generated";

export function getAccParserCarByModel(model: string) {
  return cars.find((car) => car.model === model);
}

export function getAccParserTrackByName(name: string) {
  const needle = name.toLowerCase().replace(/[-_\s]/g, "");
  return tracks.find((track) => {
    const candidate = track.name.toLowerCase().replace(/[-_\s]/g, "");
    return candidate === needle || candidate.includes(needle) || needle.includes(candidate);
  });
}
