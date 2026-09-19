import carsJson from "./cars.json";
import tracksJson from "./tracks.json";

export interface LMUCarCatalogEntry {
  id: string;
  name: string;
  class: string;
  series: string[];
  manufacturer: string;
  engine: string;
  thumbnail: string | null;
  variantIds: string[];
}

export interface LMUTrackCatalogEntry {
  id: string;
  layout: string;
  name: string;
  venue: string;
  event: string;
  location: string;
  countryCode: string;
  lengthKm: number;
  boundariesSvg: string;
  commonTrackName?: string;
}

const COMMON_TRACK_BY_PREFIX: Record<string, string> = {
  bahrainwec_: "sakhir",
  barcelona_: "catalunya",
  cotawec_: "austin",
  daytona_: "daytona",
  imolawec_: "imola",
  interlagos_: "interlagos",
  lagunaseca_: "laguna-seca",
  lemans_: "le-mans",
  monza_: "monza",
  paulricard_: "paul-ricard",
  portimaowec_: "portimao",
  qatar_: "lusail",
  sebring_: "sebring",
  fujiwec_: "fuji",
  silverstone_: "silverstone",
  spa_: "spa",
};

function commonTrackName(id: string): string | undefined {
  const prefix = Object.keys(COMMON_TRACK_BY_PREFIX).find((candidate) => id.startsWith(candidate));
  return prefix ? COMMON_TRACK_BY_PREFIX[prefix] : undefined;
}

export const lmuCarCatalog: readonly LMUCarCatalogEntry[] = carsJson.cars;
export const lmuTrackCatalog: readonly LMUTrackCatalogEntry[] = tracksJson.tracks.map((track) => ({
  ...track,
  commonTrackName: commonTrackName(track.id),
}));

const carsById = new Map(lmuCarCatalog.map((car) => [car.id, car]));
const tracksById = new Map(lmuTrackCatalog.map((track) => [track.id, track]));

export function getLMUCar(id: string): LMUCarCatalogEntry | undefined {
  return carsById.get(id);
}

export function getLMUTrack(id: string): LMUTrackCatalogEntry | undefined {
  return tracksById.get(id);
}
const tracksByAssetName = new Map(
  lmuTrackCatalog.map((track) => [track.boundariesSvg.split("/").pop()!, track]),
);

export function getLMUTrackByAssetName(assetName: string): LMUTrackCatalogEntry | undefined {
  return tracksByAssetName.get(assetName);
}

const tracksByNativeName = new Map<string, LMUTrackCatalogEntry>();
for (const track of lmuTrackCatalog) {
  for (const alias of [
    track.id,
    track.id.split("/").at(-1),
    track.layout,
    track.name,
  ]) {
    if (alias) tracksByNativeName.set(alias.trim().toLowerCase(), track);
  }
}

/** Resolve LMU's string-native track identity to shared circuit facts. */
export function getLMUSharedTrackName(name: string): string | undefined {
  return tracksByNativeName.get(name.trim().toLowerCase())?.commonTrackName;
}
