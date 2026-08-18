import type { TrackImageryGeographicBounds, TrackImageryCandidate } from "../../../shared/racing/tracks/imagery";
import { requestBytes } from "./http";
import type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";

const NETHERLANDS_WMS_URL = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0";
const NETHERLANDS_CANDIDATE_ID = "pdok-netherlands-rgb:2026-orthohr";
const NETHERLANDS_LAYER = "2026_orthoHR";
const NETHERLANDS_BOUNDS = {
  west: 3.3,
  south: 50.73,
  east: 7.24,
  north: 53.6,
} as const;
const NETHERLANDS_MAX_DIMENSION = 2500;

const netherlandsCandidate: TrackImageryCandidate = {
  id: NETHERLANDS_CANDIDATE_ID,
  provider: "pdok-netherlands-rgb",
  quality: "hq",
  coverage: "full",
  title: "PDOK 2026 OrthoHR RGB",
  sourceResolutionM: 0.08,
  capturedAt: "2026-01-01/2026-06-01",
  geographicReliability: "authoritative",
  providerStability: "stable",
  redistribution: "allowed",
  license: "CC BY 4.0",
  attribution: "Beeldmateriaal.nl",
  sourceUrl: NETHERLANDS_WMS_URL,
};

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

function getMapUrl(bounds: TrackImageryGeographicBounds, width: number, height: number): string {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: NETHERLANDS_LAYER,
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
  name: "Netherlands PDOK 2026 OrthoHR",
  maxFetchDimension: NETHERLANDS_MAX_DIMENSION,
  supports,
  owns: (candidateId) => candidateId === NETHERLANDS_CANDIDATE_ID,
  async search(context: TrackImageryProviderContext): Promise<TrackImageryCandidate[]> {
    return supports(context.location, context.bounds) ? [netherlandsCandidate] : [];
  },
  async resolve(candidateId: string, context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate> {
    if (candidateId !== NETHERLANDS_CANDIDATE_ID) throw new Error(`Netherlands provider does not own candidate ${candidateId}`);
    if (!supports(context.location, context.bounds)) throw new Error("Netherlands PDOK imagery is unavailable for resolved venue location");
    return { candidate: netherlandsCandidate, providerData: { location: context.location } };
  },
  async fetch(resolved: TrackImageryProviderResolvedCandidate, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
    if (resolved.candidate.id !== NETHERLANDS_CANDIDATE_ID || resolved.candidate.provider !== "pdok-netherlands-rgb")
      throw new Error(`Netherlands provider does not own candidate ${resolved.candidate.id}`);
    if (!containsBounds(bounds)) throw new Error("Netherlands PDOK imagery request is outside provider coverage");
    return requestBytes(getMapUrl(bounds, width, height), fetcher);
  },
};
