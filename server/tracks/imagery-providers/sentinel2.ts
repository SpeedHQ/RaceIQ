import type { TrackImageryCandidate, TrackImageryGeographicBounds } from "../../../shared/racing/tracks/imagery";
import { request, requestBytes } from "./http";
import type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";

const PLANETARY_COMPUTER_URL = "https://planetarycomputer.microsoft.com";
const STAC_URL = `${PLANETARY_COMPUTER_URL}/api/stac/v1`;
const DATA_URL = `${PLANETARY_COMPUTER_URL}/api/data/v1`;
const COLLECTION = "sentinel-2-l2a";
const CANDIDATE_PREFIX = `${COLLECTION}:`;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MIN_CAPTURED_AT = Date.parse("2019-01-01T00:00:00Z");
const MAX_CLOUD_COVER = 20;
const SEARCH_LIMIT = 25;

interface StacAsset {
  href?: unknown;
  title?: unknown;
  type?: unknown;
}

interface StacItem {
  id?: unknown;
  bbox?: unknown;
  collection?: unknown;
  license?: unknown;
  properties?: Record<string, unknown>;
  assets?: Record<string, StacAsset>;
  links?: Array<{ rel?: unknown; href?: unknown }>;
}

interface StacSearchResponse {
  features?: unknown;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validBounds(bounds: TrackImageryGeographicBounds): boolean {
  return (
    finiteNumber(bounds.west) &&
    finiteNumber(bounds.south) &&
    finiteNumber(bounds.east) &&
    finiteNumber(bounds.north) &&
    bounds.west >= -180 &&
    bounds.east <= 180 &&
    bounds.south >= -90 &&
    bounds.north <= 90 &&
    bounds.west < bounds.east &&
    bounds.south < bounds.north
  );
}

function itemId(item: StacItem): string | null {
  return typeof item.id === "string" && ITEM_ID.test(item.id) ? item.id : null;
}

function itemBounds(item: StacItem): TrackImageryGeographicBounds | null {
  if (!Array.isArray(item.bbox) || item.bbox.length < 4) return null;
  const [west, south, east, north] = item.bbox;
  if (![west, south, east, north].every(finiteNumber)) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return { west, south, east, north };
}

function coversBounds(item: StacItem, bounds: TrackImageryGeographicBounds): boolean {
  const source = itemBounds(item);
  return !!source && source.west <= bounds.west && source.south <= bounds.south && source.east >= bounds.east && source.north >= bounds.north;
}

function visualAsset(item: StacItem): StacAsset | null {
  const asset = item.assets?.visual;
  return asset && typeof asset === "object" ? asset : null;
}

function capturedAt(item: StacItem): string | undefined {
  const properties = item.properties ?? {};
  const value = properties.datetime ?? properties.start_datetime ?? properties.end_datetime;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= MIN_CAPTURED_AT ? new Date(timestamp).toISOString() : undefined;
}

function cloudCover(item: StacItem): number | undefined {
  const value = item.properties?.["eo:cloud_cover"];
  if (!finiteNumber(value) || value < 0 || value > 100) return undefined;
  return value;
}

function reusableLicense(_item: StacItem): string {
  return "Copernicus Sentinel Data Terms and Conditions";
}

function attribution(capturedAtValue: string): string {
  const year = capturedAtValue.slice(0, 4);
  return `Contains modified Copernicus Sentinel data ${year}`;
}

function itemUrl(id: string): string {
  return `${STAC_URL}/collections/${COLLECTION}/items/${encodeURIComponent(id)}`;
}

function candidateFromItem(item: StacItem, bounds: TrackImageryGeographicBounds): TrackImageryCandidate | null {
  const id = itemId(item);
  const captured = capturedAt(item);
  const cloud = cloudCover(item);
  if (!id || !captured || cloud === undefined || cloud >= MAX_CLOUD_COVER || (item.collection !== undefined && item.collection !== COLLECTION) || !coversBounds(item, bounds) || !visualAsset(item))
    return null;
  return {
    id: `${CANDIDATE_PREFIX}${id}`,
    provider: "sentinel-2-l2a",
    quality: "context",
    coverage: "full",
    sourceResolutionM: 10,
    geographicReliability: "satellite",
    capturedAt: captured,
    cloudCoverPercent: cloud,
    providerStability: "authoritative",
    redistribution: "allowed",
    title: `Sentinel-2 L2A true color (${id})`,
    license: reusableLicense(item),
    attribution: attribution(captured),
    sourceUrl: itemUrl(id),
  };
}

function candidateItem(candidateId: string): string {
  if (!candidateId.startsWith(CANDIDATE_PREFIX)) throw new Error("Unsupported Sentinel-2 candidate");
  const id = candidateId.slice(CANDIDATE_PREFIX.length);
  if (!ITEM_ID.test(id)) throw new Error("Invalid Sentinel-2 candidate");
  return id;
}

async function searchItems(context: TrackImageryProviderContext): Promise<StacItem[]> {
  const response = await request(`${STAC_URL}/search`, context.fetcher, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      collections: [COLLECTION],
      bbox: [context.bounds.west, context.bounds.south, context.bounds.east, context.bounds.north],
      datetime: `2019-01-01T00:00:00Z/${new Date().toISOString()}`,
      query: { "eo:cloud_cover": { lt: MAX_CLOUD_COVER } },
      sortby: [{ field: "properties.datetime", direction: "desc" }],
      limit: SEARCH_LIMIT,
    }),
  });
  const data = (await response.json()) as StacSearchResponse;
  if (!Array.isArray(data.features)) return [];
  return data.features.filter((feature): feature is StacItem => !!feature && typeof feature === "object");
}

async function resolveItem(id: string, fetcher: TrackImageryFetcher): Promise<StacItem> {
  const response = await request(itemUrl(id), fetcher);
  const item = (await response.json()) as StacItem;
  if (itemId(item) !== id || (item.collection !== undefined && item.collection !== COLLECTION)) throw new Error("Planetary Computer returned unexpected Sentinel-2 item");
  return item;
}

function dataApiUrl(id: string, bounds: TrackImageryGeographicBounds, width: number, height: number): string {
  const pathBounds = [bounds.west, bounds.south, bounds.east, bounds.north].join(",");
  const url = new URL(`${DATA_URL}/item/bbox/${pathBounds}/${width}x${height}.webp`);
  url.searchParams.set("collection", COLLECTION);
  url.searchParams.set("item", id);
  url.searchParams.set("assets", "visual");
  url.searchParams.set("asset_bidx", "visual|1,2,3");
  url.searchParams.set("resampling", "bilinear");
  return url.href;
}

function dimensionsValid(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192;
}

export const sentinel2Provider: TrackImageryProvider = {
  id: "sentinel-2-l2a",
  name: "Sentinel-2 L2A true color",

  supports(_location: TrackImageryLocation, bounds: TrackImageryGeographicBounds): boolean {
    return validBounds(bounds);
  },

  owns(candidateId: string): boolean {
    if (!candidateId.startsWith(CANDIDATE_PREFIX)) return false;
    try {
      candidateItem(candidateId);
      return true;
    } catch {
      return false;
    }
  },

  async search(context: TrackImageryProviderContext): Promise<TrackImageryCandidate[]> {
    const items = await searchItems(context);
    return items.map((item) => candidateFromItem(item, context.bounds)).filter((candidate): candidate is TrackImageryCandidate => candidate !== null);
  },

  async resolve(candidateId: string, context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate> {
    const id = candidateItem(candidateId);
    const item = await resolveItem(id, context.fetcher);
    const candidate = candidateFromItem(item, context.bounds);
    if (!candidate || candidate.id !== candidateId) throw new Error("Sentinel-2 candidate does not cover venue or is not reusable");
    return { candidate, providerData: { id, collection: COLLECTION, asset: "visual" } };
  },

  async fetch(resolved: TrackImageryProviderResolvedCandidate, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
    if (resolved.candidate.provider !== "sentinel-2-l2a" || !sentinel2Provider.owns(resolved.candidate.id)) throw new Error("Unsupported Sentinel-2 candidate");
    if (!validBounds(bounds) || !dimensionsValid(width, height)) throw new Error("Invalid Sentinel-2 raster request");
    const id = candidateItem(resolved.candidate.id);
    return requestBytes(dataApiUrl(id, bounds, width, height), fetcher);
  },
};

export default sentinel2Provider;
