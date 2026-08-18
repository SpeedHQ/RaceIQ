import { z } from "zod";
import type { TrackImageryGeographicBounds, TrackImageryCandidate } from "../../../shared/racing/tracks/imagery";
import { request, requestBytes } from "./http";
import type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";

const WALLONIA_CANDIDATE_PREFIX = "wallonia-spw:";
const WALLONIA_BOUNDS = {
  west: 2.835011,
  south: 49.474632,
  east: 6.438924,
  north: 50.822978,
} as const;
const WALLONIA_MAX_DIMENSION = 4096;

const WALLONIA_REST_ROOT = "https://geoservices.wallonie.be/arcgis/rest/services";
const WALLONIA_SERVICE_NAME = /^ORTHO_(\d{4})(?:_(\d{4}))?(?:_(ETE|PRINTEMPS))?$/;
const WALLONIA_CANDIDATE_ID = /^wallonia-spw:(ortho_\d{4}(?:_\d{4})?(?:_(?:ete|printemps))?)$/;
const WALLONIA_METADATA_CONCURRENCY = 4;

const WalloniaDirectorySchema = z.object({
  services: z.array(z.object({ name: z.string(), type: z.literal("MapServer") })),
});

const WalloniaLayerSchema = z.object({
  type: z.literal("Raster Layer"),
  description: z.string(),
});

function serviceUrl(service: string, rest: boolean): string {
  const root = rest ? WALLONIA_REST_ROOT : "https://geoservices.wallonie.be/arcgis/services";
  return `${root}/IMAGERIE/${service}/MapServer${rest ? "" : "/WMSServer"}`;
}

function resolutionFromDescription(description: string): number | null {
  const match = /r[ée]solution(?: spatiale)? de\s*(\d+(?:[.,]\d+)?)\s*(cm|m)\b/i.exec(description);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  return match[2].toLocaleLowerCase() === "cm" ? value / 100 : value;
}

function fullWalloniaCoverage(description: string): boolean {
  if (/(?:une|en) partie[^.]*territoire wallon/i.test(description)) return false;
  return /(?:enti[eè]ret[eé][^.]*territoire wallon|ensemble du territoire wallon|couvrant le territoire wallon)/i.test(description);
}

function captureRange(startYear: number, endYear: number, season: string | undefined): string {
  if (season === "ETE") return `${startYear}-06-01/${endYear}-08-31`;
  if (season === "PRINTEMPS") return `${startYear}-03-01/${endYear}-05-31`;
  return `${startYear}-01-01/${endYear}-12-31`;
}

function candidateForService(service: string, description: string): TrackImageryCandidate | null {
  const match = WALLONIA_SERVICE_NAME.exec(service);
  const sourceResolutionM = resolutionFromDescription(description);
  if (!match || !sourceResolutionM || !fullWalloniaCoverage(description)) return null;
  const startYear = Number(match[1]);
  const endYear = match[2] ? Number(match[2]) : startYear;
  if (startYear < 1900 || endYear < startYear || endYear > new Date().getUTCFullYear() + 1) return null;
  const season = match[3] === "ETE" ? " summer" : match[3] === "PRINTEMPS" ? " spring" : "";
  const years = startYear === endYear ? String(startYear) : `${startYear}–${endYear}`;
  return {
    id: `${WALLONIA_CANDIDATE_PREFIX}${service.toLocaleLowerCase()}`,
    provider: "wallonia-spw",
    quality: "hq",
    coverage: "full",
    title: `SPW Orthophotos ${years}${season}`,
    sourceResolutionM,
    capturedAt: captureRange(startYear, endYear, match[3]),
    geographicReliability: "authoritative",
    providerStability: "stable",
    redistribution: "allowed",
    license: "CC BY 4.0",
    attribution: "Service public de Wallonie (SPW)",
    sourceUrl: serviceUrl(service, true),
  };
}

async function mapBounded<T, R>(values: readonly T[], callback: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await callback(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(WALLONIA_METADATA_CONCURRENCY, values.length) }, () => worker()));
  return output;
}

async function discoverServices(fetcher: TrackImageryFetcher): Promise<string[]> {
  const response = WalloniaDirectorySchema.parse(await (await request(`${WALLONIA_REST_ROOT}/IMAGERIE?f=json`, fetcher)).json());
  return response.services.map(({ name }) => (name.startsWith("IMAGERIE/") ? name.slice("IMAGERIE/".length) : "")).filter((service) => WALLONIA_SERVICE_NAME.test(service));
}

async function loadCandidate(service: string, fetcher: TrackImageryFetcher): Promise<TrackImageryCandidate | null> {
  const layer = WalloniaLayerSchema.parse(await (await request(`${serviceUrl(service, true)}/0?f=json`, fetcher)).json());
  return candidateForService(service, layer.description);
}

async function discoverCandidates(fetcher: TrackImageryFetcher): Promise<TrackImageryCandidate[]> {
  const services = await discoverServices(fetcher);
  const candidates = await mapBounded(services, async (service) => {
    try {
      return await loadCandidate(service, fetcher);
    } catch {
      return null;
    }
  });
  const available = candidates.filter((candidate): candidate is TrackImageryCandidate => candidate !== null);
  if (available.length === 0) throw new Error("Wallonia SPW advertises no reusable full-coverage orthophotos");
  return available.sort((left, right) => (right.capturedAt ?? "").localeCompare(left.capturedAt ?? "") || left.id.localeCompare(right.id));
}

function serviceFromCandidateId(candidateId: string): string | null {
  const match = WALLONIA_CANDIDATE_ID.exec(candidateId);
  return match ? match[1].toLocaleUpperCase() : null;
}

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

function getMapUrl(service: string, bounds: TrackImageryGeographicBounds, width: number, height: number): string {
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
  return `${serviceUrl(service, false)}?${params.toString()}`;
}

export const walloniaProvider: TrackImageryProvider = {
  id: "wallonia-spw",
  name: "Wallonia SPW orthophotos",
  maxFetchDimension: WALLONIA_MAX_DIMENSION,
  supports,
  owns: (candidateId) => WALLONIA_CANDIDATE_ID.test(candidateId),
  async search(context: TrackImageryProviderContext): Promise<TrackImageryCandidate[]> {
    return supports(context.location, context.bounds) ? discoverCandidates(context.fetcher) : [];
  },
  async resolve(candidateId: string, context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate> {
    const service = serviceFromCandidateId(candidateId);
    if (!service) throw new Error(`Wallonia provider does not own candidate ${candidateId}`);
    if (!supports(context.location, context.bounds)) throw new Error("Wallonia SPW imagery is unavailable for resolved venue location");
    const candidate = await loadCandidate(service, context.fetcher);
    if (!candidate || candidate.id !== candidateId) throw new Error(`Wallonia SPW no longer advertises imagery candidate ${candidateId}`);
    return { candidate };
  },
  async fetch(resolved: TrackImageryProviderResolvedCandidate, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
    const service = serviceFromCandidateId(resolved.candidate.id);
    if (!service || resolved.candidate.provider !== "wallonia-spw") throw new Error(`Wallonia provider does not own candidate ${resolved.candidate.id}`);
    if (!containsBounds(bounds)) throw new Error("Wallonia SPW imagery request is outside provider coverage");
    return requestBytes(getMapUrl(service, bounds, width, height), fetcher);
  },
};
