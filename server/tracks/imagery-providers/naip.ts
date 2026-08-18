import type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";
import { request, responseBytes } from "./http";
import type { TrackImageryCandidate, TrackImageryGeographicBounds } from "../../../shared/racing/tracks/imagery";

const NAIP_SERVICE_URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer";
const NAIP_ID = "usgs-naip:latest";

interface NaipQueryResponse {
  features?: Array<{
    attributes?: {
      Year?: number | null;
      acquisition_date?: number | null;
      resolution_value?: number | null;
    };
  }>;
}

// NAIP has no meaningful coverage outside these mapped US footprints. Keeping
// this gate before requests prevents venue coordinates from becoming a query
// oracle for unrelated countries.
const NAIP_FOOTPRINTS: readonly TrackImageryGeographicBounds[] = [
  { west: -125.0, south: 24.3, east: -66.5, north: 49.5 },
  { west: -170.0, south: 51.0, east: -129.5, north: 72.0 },
  { west: -160.5, south: 18.7, east: -154.5, north: 22.4 },
  { west: -67.5, south: 17.7, east: -65.0, north: 18.7 },
];

function withinFootprint(bounds: TrackImageryGeographicBounds): boolean {
  return NAIP_FOOTPRINTS.some((footprint) => bounds.west >= footprint.west && bounds.east <= footprint.east && bounds.south >= footprint.south && bounds.north <= footprint.north);
}

function supports(location: TrackImageryLocation, bounds: TrackImageryGeographicBounds): boolean {
  return location.country.toUpperCase() === "USA" && withinFootprint(bounds);
}

function boundsParam(bounds: TrackImageryGeographicBounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north].join(",");
}

function dateFromAttributes(attributes: NonNullable<NaipQueryResponse["features"]>[number]["attributes"]): string | undefined {
  if (!attributes) return undefined;
  if (typeof attributes.acquisition_date === "number" && Number.isFinite(attributes.acquisition_date)) {
    const value = new Date(attributes.acquisition_date);
    if (!Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  }
  return Number.isSafeInteger(attributes.Year) ? `${attributes.Year}-01-01` : undefined;
}

function candidateFromAttributes(attributes: NonNullable<NaipQueryResponse["features"]>[number]["attributes"]): TrackImageryCandidate {
  const year = attributes && Number.isSafeInteger(attributes.Year) ? attributes.Year : undefined;
  const sourceResolutionM =
    attributes && typeof attributes.resolution_value === "number" && Number.isFinite(attributes.resolution_value) && attributes.resolution_value > 0 ? attributes.resolution_value : 0.6;
  return {
    id: NAIP_ID,
    provider: "usgs-naip",
    quality: "hq",
    coverage: "full",
    sourceResolutionM,
    geographicReliability: "authoritative",
    providerStability: "authoritative",
    redistribution: "allowed",
    title: year ? `USGS NAIP ${year}` : "USGS NAIP",
    capturedAt: dateFromAttributes(attributes),
    license: "Public domain",
    attribution: "National Agriculture Imagery Program (NAIP), USDA Farm Service Agency; distributed by the U.S. Geological Survey",
    sourceUrl: NAIP_SERVICE_URL,
  };
}

async function queryLatest(context: TrackImageryProviderContext, fetcher: TrackImageryFetcher): Promise<TrackImageryProviderResolvedCandidate[]> {
  if (!supports(context.location, context.bounds)) return [];
  const query = new URL(`${NAIP_SERVICE_URL}/query`);
  query.search = new URLSearchParams({
    f: "json",
    geometry: boundsParam(context.bounds),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "Year,acquisition_date,resolution_value",
    returnGeometry: "false",
    orderByFields: "Year DESC",
    resultRecordCount: "1",
  }).toString();
  const data = (await (await request(query.href, fetcher)).json()) as NaipQueryResponse;
  const attributes = data.features?.[0]?.attributes;
  return attributes ? [{ candidate: candidateFromAttributes(attributes), providerData: attributes }] : [];
}

function toResolved(candidate: TrackImageryCandidate, providerData?: unknown): TrackImageryProviderResolvedCandidate {
  return { candidate, ...(providerData === undefined ? {} : { providerData }) };
}

export const naipProvider: TrackImageryProvider = {
  id: "usgs-naip",
  name: "USGS NAIP",
  maxFetchDimension: 4_000,
  supports,
  owns: (candidateId) => candidateId === NAIP_ID,
  async search(context) {
    return (await queryLatest(context, context.fetcher)).map(({ candidate }) => candidate);
  },
  async resolve(candidateId, context) {
    if (candidateId !== NAIP_ID) throw new Error("USGS NAIP candidate id is not recognized");
    const resolved = await queryLatest(context, context.fetcher);
    if (resolved.length === 0) throw new Error("USGS NAIP has no coverage for this GPS footprint");
    return toResolved(resolved[0].candidate, resolved[0].providerData);
  },
  async fetch(resolved, bounds, width, height, fetcher) {
    if (resolved.candidate.id !== NAIP_ID || resolved.candidate.provider !== "usgs-naip") throw new Error("Resolved candidate does not belong to USGS NAIP");
    const url = new URL(`${NAIP_SERVICE_URL}/exportImage`);
    url.search = new URLSearchParams({
      bbox: boundsParam(bounds),
      bboxSR: "4326",
      imageSR: "4326",
      size: `${width},${height}`,
      adjustAspectRatio: "false",
      format: "jpg",
      pixelType: "U8",
      renderingRule: JSON.stringify({ rasterFunction: "NaturalColor" }),
      f: "image",
    }).toString();
    return responseBytes(await request(url.href, fetcher, { headers: { Accept: "image/jpeg,image/*" } }));
  },
};
