import type { TrackImageryGeographicBounds, TrackImageryCandidate } from "../../../shared/racing/tracks/imagery";
import { requestBytes } from "./http";
import type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";

const WALLONIA_WMS_URL = "https://geoservices.wallonie.be/arcgis/services/IMAGERIE/ORTHO_LAST/MapServer/WMSServer";
const WALLONIA_CANDIDATE_ID = "wallonia-spw:ortho-last";
const WALLONIA_BOUNDS = {
  west: 2.835011,
  south: 49.474632,
  east: 6.438924,
  north: 50.822978,
} as const;
const WALLONIA_MAX_DIMENSION = 4096;

const walloniaCandidate: TrackImageryCandidate = {
  id: WALLONIA_CANDIDATE_ID,
  provider: "wallonia-spw",
  quality: "hq",
  coverage: "full",
  title: "SPW ORTHO_LAST",
  sourceResolutionM: 0.25,
  capturedAt: "2023-05-27/2023-06-25",
  geographicReliability: "authoritative",
  providerStability: "stable",
  redistribution: "allowed",
  license: "CC BY 4.0",
  attribution: "Source : Service public de Wallonie (SPW) - Orthophotos - Vues aériennes les plus récentes (2025-09-20) https://geodata.wallonie.be/id/dfc9f3a2-adff-4b7f-ab77-8a890c4cabbb",
  sourceUrl: WALLONIA_WMS_URL,
};

function normalizedCountry(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function containsBounds(bounds: TrackImageryGeographicBounds): boolean {
  return bounds.west >= WALLONIA_BOUNDS.west && bounds.south >= WALLONIA_BOUNDS.south && bounds.east <= WALLONIA_BOUNDS.east && bounds.north <= WALLONIA_BOUNDS.north;
}

function containsCenter(location: TrackImageryLocation): boolean {
  return (
    location.center.longitudeDeg >= WALLONIA_BOUNDS.west &&
    location.center.longitudeDeg <= WALLONIA_BOUNDS.east &&
    location.center.latitudeDeg >= WALLONIA_BOUNDS.south &&
    location.center.latitudeDeg <= WALLONIA_BOUNDS.north
  );
}

function supports(location: TrackImageryLocation, bounds: TrackImageryGeographicBounds): boolean {
  return normalizedCountry(location.country) === "belgium" && containsCenter(location) && containsBounds(bounds);
}

function boundedDimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(WALLONIA_MAX_DIMENSION, Math.max(1, Math.floor(value)));
}

function getMapUrl(bounds: TrackImageryGeographicBounds, width: number, height: number): string {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: "0",
    STYLES: "",
    CRS: "CRS:84",
    BBOX: [bounds.west, bounds.south, bounds.east, bounds.north].join(","),
    WIDTH: String(boundedDimension(width)),
    HEIGHT: String(boundedDimension(height)),
    FORMAT: "image/jpeg",
    TRANSPARENT: "FALSE",
  });
  return `${WALLONIA_WMS_URL}?${params.toString()}`;
}

export const walloniaProvider: TrackImageryProvider = {
  id: "wallonia-spw",
  name: "Wallonia SPW ORTHO_LAST",
  supports,
  owns: (candidateId) => candidateId === WALLONIA_CANDIDATE_ID,
  async search(context: TrackImageryProviderContext): Promise<TrackImageryCandidate[]> {
    return supports(context.location, context.bounds) ? [walloniaCandidate] : [];
  },
  async resolve(candidateId: string, context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate> {
    if (candidateId !== WALLONIA_CANDIDATE_ID) throw new Error(`Wallonia provider does not own candidate ${candidateId}`);
    if (!supports(context.location, context.bounds)) throw new Error("Wallonia SPW imagery is unavailable for resolved venue location");
    return { candidate: walloniaCandidate, providerData: { location: context.location } };
  },
  async fetch(resolved: TrackImageryProviderResolvedCandidate, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
    if (resolved.candidate.id !== WALLONIA_CANDIDATE_ID || resolved.candidate.provider !== "wallonia-spw") throw new Error(`Wallonia provider does not own candidate ${resolved.candidate.id}`);
    if (!containsBounds(bounds)) throw new Error("Wallonia SPW imagery request is outside provider coverage");
    return requestBytes(getMapUrl(bounds, width, height), fetcher);
  },
};
