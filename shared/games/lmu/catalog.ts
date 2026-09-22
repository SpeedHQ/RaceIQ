import carsJson from "./cars.json";
import tracksJson from "./tracks.json";

export interface LMUCarVariant {
  id: string;
  name: string;
}

export interface LMUCarCatalogEntry {
  id: string;
  name: string;
  class: string;
  series: string[];
  manufacturer: string;
  engine: string;
  thumbnail: string | null;
  variants: LMUCarVariant[];
  vehicleNames: string[];
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
  sectorFractions?: readonly number[];
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
  boundariesSvg: track.trackSvg,
  commonTrackName: commonTrackName(track.id),
}));

const carsById = new Map(lmuCarCatalog.map((car) => [car.id, car]));
const tracksById = new Map(lmuTrackCatalog.map((track) => [track.id, track]));

function key(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function addAlias<T>(index: Map<string, Set<T>>, alias: string | undefined, value: T): void {
  if (!alias) return;
  const normalized = key(alias);
  if (!normalized) return;

  const values = index.get(normalized) ?? new Set<T>();
  values.add(value);
  index.set(normalized, values);
}
function addCarNameAliases(index: Map<string, Set<LMUCarCatalogEntry>>, name: string, car: LMUCarCatalogEntry): void {
  addAlias(index, name, car);
  addAlias(index, name.replace(/\s+\d{4}$/, ""), car);
}

function resolveTier<T>(index: Map<string, Set<T>>, values: readonly string[]): T | null | undefined {
  const candidates = new Set<T>();
  let matched = false;
  for (const value of values) {
    const matches = index.get(key(value));
    if (!matches) continue;
    matched = true;
    for (const match of matches) candidates.add(match);
  }
  if (!matched) return undefined;
  return candidates.size === 1 ? candidates.values().next().value : null;
}

const carsByExactId = new Map<string, Set<LMUCarCatalogEntry>>();
const carsByVehicleAlias = new Map<string, Set<LMUCarCatalogEntry>>();
const carsByModelAlias = new Map<string, Set<LMUCarCatalogEntry>>();
for (const car of lmuCarCatalog) {
  addAlias(carsByExactId, car.id, car);
  addCarNameAliases(carsByModelAlias, car.name, car);
  for (const variant of car.variants) {
    addAlias(carsByExactId, variant.id, car);
    addAlias(carsByVehicleAlias, variant.id.split("/").at(-1), car);
    addAlias(carsByVehicleAlias, variant.name, car);
  }
  for (const vehicleName of car.vehicleNames) addAlias(carsByVehicleAlias, vehicleName, car);
}

const tracksByExactId = new Map<string, Set<LMUTrackCatalogEntry>>();
const tracksByDisplayName = new Map<string, Set<LMUTrackCatalogEntry>>();
for (const track of lmuTrackCatalog) {
  addAlias(tracksByExactId, track.id, track);
  addAlias(tracksByExactId, track.id.split("/").at(-1), track);
  addAlias(tracksByExactId, track.layout, track);
  addAlias(tracksByDisplayName, track.name, track);
}

function resolveTrackTier(
  index: Map<string, Set<LMUTrackCatalogEntry>>,
  trackIds: readonly string[],
): LMUTrackCatalogEntry | null | undefined {
  const populated = trackIds
    .map((trackId) => index.get(key(trackId)))
    .filter((matches): matches is Set<LMUTrackCatalogEntry> => matches !== undefined);
  if (populated.length === 0) return undefined;
  const candidates = new Set(populated[0]);
  for (const matches of populated.slice(1)) {
    for (const candidate of candidates) {
      if (!matches.has(candidate)) candidates.delete(candidate);
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

export function getLMUCar(id: string): LMUCarCatalogEntry | undefined {
  return carsById.get(id);
}

export function getLMUTrack(id: string): LMUTrackCatalogEntry | undefined {
  return tracksById.get(id);
}

export function resolveLMUCar(
  carId: string,
  vehicleName?: string,
): LMUCarCatalogEntry | undefined {
  const values = vehicleName === undefined ? [carId] : [carId, vehicleName];
  for (const index of [carsByExactId, carsByVehicleAlias, carsByModelAlias]) {
    const resolved = resolveTier(index, values);
    if (resolved !== undefined) return resolved ?? undefined;
  }
  return undefined;
}

export function resolveLMUTrack(
  ...trackIds: string[]
): LMUTrackCatalogEntry | undefined {
  for (const index of [tracksByExactId, tracksByDisplayName]) {
    const resolved = resolveTrackTier(index, trackIds);
    if (resolved !== undefined) return resolved ?? undefined;
  }
  return undefined;
}
const tracksByAssetName = new Map(
  lmuTrackCatalog.map((track) => [track.boundariesSvg.split("/").pop()!, track]),
);

export function getLMUTrackByAssetName(assetName: string): LMUTrackCatalogEntry | undefined {
  return tracksByAssetName.get(assetName);
}

/** Resolve an unambiguous LMU track identity to shared circuit facts. */
export function getLMUSharedTrackName(name: string): string | undefined {
  return resolveLMUTrack(name)?.commonTrackName;
}
