import type { TrackImageryGeographicBounds, TrackImageryCandidate } from "../../../shared/racing/tracks/imagery";
import { request, requestBytes } from "./http";
import type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";

const NETHERLANDS_WMS_URL = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0";
const NETHERLANDS_CANDIDATE_PREFIX = "pdok-netherlands-rgb:";
const NETHERLANDS_BOUNDS = {
  west: 3.3,
  south: 50.73,
  east: 7.24,
  north: 53.6,
} as const;
const NETHERLANDS_MAX_DIMENSION = 2500;
interface NetherlandsVintage {
  id: string;
  layer: string;
  year: number;
  sourceResolutionM: number;
}

const NETHERLANDS_CANDIDATE_ID = /^pdok-netherlands-rgb:(\d{4})-(orthohr|ortho25)$/;
const NETHERLANDS_LAYER = /<Name>(\d{4})_(orthoHR|ortho25)<\/Name>/g;
const MAX_CAPABILITIES_LENGTH = 1_000_000;

function candidateForVintage(vintage: NetherlandsVintage): TrackImageryCandidate {
  const detail = vintage.sourceResolutionM < 0.1 ? "OrthoHR" : "Ortho25";
  return {
    id: vintage.id,
    provider: "pdok-netherlands-rgb",
    quality: "hq",
    coverage: "full",
    title: `PDOK ${vintage.year} ${detail} RGB`,
    sourceResolutionM: vintage.sourceResolutionM,
    capturedAt: `${vintage.year}-01-01/${vintage.year}-12-31`,
    geographicReliability: "authoritative",
    providerStability: "stable",
    redistribution: "allowed",
    license: "CC BY 4.0",
    attribution: "Beeldmateriaal.nl",
    sourceUrl: NETHERLANDS_WMS_URL,
  };
}

function parseVintages(capabilities: string): NetherlandsVintage[] {
  if (capabilities.length === 0 || capabilities.length > MAX_CAPABILITIES_LENGTH) throw new Error("PDOK returned invalid WMS capabilities");
  const bestByYear = new Map<number, NetherlandsVintage>();
  for (const match of capabilities.matchAll(NETHERLANDS_LAYER)) {
    const year = Number(match[1]);
    const detail = match[2];
    if (!Number.isSafeInteger(year) || year < 2000 || year > new Date().getUTCFullYear() + 1) continue;
    const sourceResolutionM = detail === "orthoHR" ? 0.08 : 0.25;
    const vintage = {
      id: `${NETHERLANDS_CANDIDATE_PREFIX}${year}-${detail.toLocaleLowerCase()}`,
      layer: `${year}_${detail}`,
      year,
      sourceResolutionM,
    };
    const existing = bestByYear.get(year);
    if (!existing || vintage.sourceResolutionM < existing.sourceResolutionM) bestByYear.set(year, vintage);
  }
  return [...bestByYear.values()].sort((left, right) => right.year - left.year);
}

async function discoverVintages(fetcher: TrackImageryFetcher): Promise<NetherlandsVintage[]> {
  const url = new URL(NETHERLANDS_WMS_URL);
  url.search = new URLSearchParams({ SERVICE: "WMS", REQUEST: "GetCapabilities" }).toString();
  const vintages = parseVintages(await (await request(url.href, fetcher)).text());
  if (vintages.length === 0) throw new Error("PDOK WMS advertises no finalized annual orthophotos");
  return vintages;
}

function layerFromCandidateId(candidateId: string): string | null {
  const match = NETHERLANDS_CANDIDATE_ID.exec(candidateId);
  if (!match) return null;
  return `${match[1]}_${match[2] === "orthohr" ? "orthoHR" : "ortho25"}`;
}

function normalizedCountry(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function containsBounds(bounds: TrackImageryGeographicBounds): boolean {
  return bounds.west >= NETHERLANDS_BOUNDS.west && bounds.south >= NETHERLANDS_BOUNDS.south && bounds.east <= NETHERLANDS_BOUNDS.east && bounds.north <= NETHERLANDS_BOUNDS.north;
}

function containsCenter(location: TrackImageryLocation): boolean {
  return (
    location.center.longitudeDeg >= NETHERLANDS_BOUNDS.west &&
    location.center.longitudeDeg <= NETHERLANDS_BOUNDS.east &&
    location.center.latitudeDeg >= NETHERLANDS_BOUNDS.south &&
    location.center.latitudeDeg <= NETHERLANDS_BOUNDS.north
  );
}

function supports(location: TrackImageryLocation, bounds: TrackImageryGeographicBounds): boolean {
  return normalizedCountry(location.country) === "netherlands" && containsCenter(location) && containsBounds(bounds);
}

function boundedDimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(NETHERLANDS_MAX_DIMENSION, Math.max(1, Math.floor(value)));
}

function getMapUrl(layer: string, bounds: TrackImageryGeographicBounds, width: number, height: number): string {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: layer,
    STYLES: "",
    CRS: "EPSG:4326",
    // WMS 1.3.0 EPSG:4326 uses latitude,longitude axis order.
    BBOX: [bounds.south, bounds.west, bounds.north, bounds.east].join(","),
    WIDTH: String(boundedDimension(width)),
    HEIGHT: String(boundedDimension(height)),
    FORMAT: "image/jpeg",
    TRANSPARENT: "FALSE",
  });
  return `${NETHERLANDS_WMS_URL}?${params.toString()}`;
}

export const netherlandsProvider: TrackImageryProvider = {
  id: "pdok-netherlands-rgb",
  name: "Netherlands PDOK aerial imagery",
  maxFetchDimension: NETHERLANDS_MAX_DIMENSION,
  supports,
  owns: (candidateId) => NETHERLANDS_CANDIDATE_ID.test(candidateId),
  async search(context: TrackImageryProviderContext): Promise<TrackImageryCandidate[]> {
    return supports(context.location, context.bounds) ? (await discoverVintages(context.fetcher)).map(candidateForVintage) : [];
  },
  async resolve(candidateId: string, context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate> {
    if (!NETHERLANDS_CANDIDATE_ID.test(candidateId)) throw new Error(`Netherlands provider does not own candidate ${candidateId}`);
    if (!supports(context.location, context.bounds)) throw new Error("Netherlands PDOK imagery is unavailable for resolved venue location");
    const vintage = (await discoverVintages(context.fetcher)).find(({ id }) => id === candidateId);
    if (!vintage) throw new Error(`PDOK no longer advertises imagery candidate ${candidateId}`);
    return { candidate: candidateForVintage(vintage) };
  },
  async fetch(resolved: TrackImageryProviderResolvedCandidate, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
    const layer = layerFromCandidateId(resolved.candidate.id);
    if (!layer || resolved.candidate.provider !== "pdok-netherlands-rgb") throw new Error(`Netherlands provider does not own candidate ${resolved.candidate.id}`);
    if (!containsBounds(bounds)) throw new Error("Netherlands PDOK imagery request is outside provider coverage");
    return requestBytes(getMapUrl(layer, bounds, width, height), fetcher);
  },
};
