import sharp from "sharp";
import type { TrackImageryFetcher, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";
import { request, responseBytes, REQUEST_TIMEOUT_MS } from "./http";
import type { TrackImageryCandidate, TrackImageryGeographicBounds } from "../../../shared/racing/tracks/imagery";

const OPEN_AERIAL_MAP_API_URL = "https://api.openaerialmap.org";
const OPEN_AERIAL_MAP_TILE_HOST = "tiles.openaerialmap.org";
const OPEN_AERIAL_MAP_ID = /^[a-f0-9]{24}$/;
const SOURCE_TILE_SIZE = 256;
const MAX_TILE_REQUESTS = 400;
const SOURCE_FETCH_CONCURRENCY = 8;
const SOURCE_CACHE_LIMIT = 64;
const MAX_GSD_M = 2;

interface OpenAerialMapItem {
  _id?: string;
  uuid?: string;
  title?: string;
  provider?: string;
  acquisition_start?: string;
  gsd?: number;
  bbox?: number[];
  properties?: { license?: string; tms?: string };
  user?: { name?: string } | string;
}

interface OpenAerialMapResponse {
  meta?: { license?: string };
  results?: OpenAerialMapItem[] | OpenAerialMapItem;
}

function boundsParam(bounds: TrackImageryGeographicBounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north].join(",");
}

function boundedDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  return value.slice(0, 10);
}

function itemCoversBounds(item: OpenAerialMapItem, bounds: TrackImageryGeographicBounds): boolean {
  if (!Array.isArray(item.bbox) || item.bbox.length !== 4 || item.bbox.some((value) => !Number.isFinite(value))) return false;
  const [west, south, east, north] = item.bbox;
  return west <= bounds.west && south <= bounds.south && east >= bounds.east && north >= bounds.north;
}

function tileTemplate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^http:\/\/tiles\.openaerialmap\.org\//, "https://tiles.openaerialmap.org/");
  if (!normalized.includes("{z}") || !normalized.includes("{x}") || !normalized.includes("{y}")) return null;
  try {
    const probe = new URL(normalized.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"));
    if (probe.protocol !== "https:" || probe.hostname !== OPEN_AERIAL_MAP_TILE_HOST) return null;
    return normalized;
  } catch {
    return null;
  }
}

function reusableLicense(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const license = value.trim().replace("CC-BY", "CC BY");
  if (/public domain/i.test(license) || /^CC BY(?: 4\.0)?(?: International)?$/i.test(license)) return license;
  return null;
}

function candidateFromItem(item: OpenAerialMapItem, bounds: TrackImageryGeographicBounds, catalogLicense: unknown): TrackImageryProviderResolvedCandidate | null {
  if (!OPEN_AERIAL_MAP_ID.test(item._id ?? "") || !itemCoversBounds(item, bounds) || typeof item.uuid !== "string") return null;
  const template = tileTemplate(item.properties?.tms);
  if (!template) return null;
  const license = reusableLicense(item.properties?.license?.trim() || catalogLicense);
  if (!license) return null;
  const sourceResolutionM = typeof item.gsd === "number" && Number.isFinite(item.gsd) && item.gsd > 0 ? item.gsd : undefined;
  if (sourceResolutionM === undefined || sourceResolutionM > MAX_GSD_M) return null;
  const provider = item.provider?.trim() || (typeof item.user === "object" ? item.user.name?.trim() : undefined);
  let sourceUrl: string;
  try {
    const parsedSourceUrl = new URL(item.uuid);
    if (parsedSourceUrl.protocol !== "https:") return null;
    sourceUrl = parsedSourceUrl.href;
  } catch {
    return null;
  }
  const candidate: TrackImageryCandidate = {
    id: `openaerialmap:${item._id}`,
    provider: "openaerialmap",
    quality: "hq",
    coverage: "full",
    sourceResolutionM,
    geographicReliability: "community",
    providerStability: "opportunistic",
    redistribution: "allowed",
    title: item.title?.trim() || "OpenAerialMap imagery",
    capturedAt: boundedDate(item.acquisition_start),
    license,
    attribution: provider ? `${provider}; distributed by OpenAerialMap` : "OpenAerialMap contributors",
    sourceUrl,
  };
  return { candidate, providerData: { tileTemplate: template, item } };
}

function candidatesFromResponse(data: OpenAerialMapResponse, bounds: TrackImageryGeographicBounds): TrackImageryProviderResolvedCandidate[] {
  const items = Array.isArray(data.results) ? data.results : data.results ? [data.results] : [];
  return items
    .map((item) => candidateFromItem(item, bounds, data.meta?.license))
    .filter((value): value is TrackImageryProviderResolvedCandidate => value !== null)
    .sort((left, right) => left.candidate.sourceResolutionM - right.candidate.sourceResolutionM)
    .slice(0, 5);
}

async function searchCandidates(context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate[]> {
  const query = new URL(`${OPEN_AERIAL_MAP_API_URL}/meta`);
  query.search = new URLSearchParams({ bbox: boundsParam(context.bounds), has_tiled: "true", order_by: "gsd", sort: "asc", limit: "25" }).toString();
  const data = (await (await request(query.href, context.fetcher)).json()) as OpenAerialMapResponse;
  return candidatesFromResponse(data, context.bounds);
}

function tileX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * 2 ** zoom;
}

function tileY(latitude: number, zoom: number): number {
  const latitudeRad = (Math.max(-85.051_128_78, Math.min(85.051_128_78, latitude)) * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(latitudeRad)) / Math.PI) / 2) * 2 ** zoom;
}

class SourceTileCache {
  private readonly values = new Map<string, Promise<Uint8Array | null>>();
  private readonly fetcher: TrackImageryFetcher;

  constructor(fetcher: TrackImageryFetcher) {
    this.fetcher = fetcher;
  }
  async get(url: string): Promise<Uint8Array | null> {
    const existing = this.values.get(url);
    if (existing) return existing;
    const pending = (async () => {
      const response = await this.fetcher(url, {
        headers: { Accept: "image/png,image/jpeg,image/webp,*/*", "User-Agent": "RaceIQ track imagery curator" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`OpenAerialMap tile service returned HTTP ${response.status}`);
      return responseBytes(response);
    })();
    this.values.set(url, pending);
    if (this.values.size > SOURCE_CACHE_LIMIT) this.values.delete(this.values.keys().next().value as string);
    return pending;
  }
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
  await Promise.all(Array.from({ length: Math.min(SOURCE_FETCH_CONCURRENCY, values.length) }, () => worker()));
  return output;
}

async function renderRegion(template: string, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
  const zoom = Math.max(0, Math.min(22, Math.ceil(Math.log2((width * 360) / (SOURCE_TILE_SIZE * Math.max(bounds.east - bounds.west, Number.EPSILON))))));
  const westX = tileX(bounds.west, zoom);
  const eastX = tileX(bounds.east, zoom);
  const northY = tileY(bounds.north, zoom);
  const southY = tileY(bounds.south, zoom);
  const startX = Math.floor(westX);
  const endX = Math.max(startX, Math.ceil(eastX) - 1);
  const startY = Math.floor(northY);
  const endY = Math.max(startY, Math.ceil(southY) - 1);
  const columns = endX - startX + 1;
  const rows = endY - startY + 1;
  if (columns <= 0 || rows <= 0 || columns * rows > MAX_TILE_REQUESTS) throw new Error("OpenAerialMap footprint requires too many source tiles");
  const jobs: Array<{ x: number; y: number }> = [];
  for (let y = startY; y <= endY; y += 1) for (let x = startX; x <= endX; x += 1) jobs.push({ x, y });
  const cache = new SourceTileCache(fetcher);
  const fetched = await mapBounded(jobs, async ({ x, y }) => ({ x, y, bytes: await cache.get(template.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y))) }));
  const composites = fetched
    .filter((tile): tile is { x: number; y: number; bytes: Uint8Array } => tile.bytes !== null)
    .map((tile) => ({ input: Buffer.from(tile.bytes), left: (tile.x - startX) * SOURCE_TILE_SIZE, top: (tile.y - startY) * SOURCE_TILE_SIZE }));
  if (composites.length === 0) throw new Error("OpenAerialMap returned no image tiles for this footprint");
  const left = Math.floor((westX - startX) * SOURCE_TILE_SIZE);
  const top = Math.floor((northY - startY) * SOURCE_TILE_SIZE);
  const right = Math.ceil((eastX - startX) * SOURCE_TILE_SIZE);
  const bottom = Math.ceil((southY - startY) * SOURCE_TILE_SIZE);
  const mosaic = await sharp({ create: { width: columns * SOURCE_TILE_SIZE, height: rows * SOURCE_TILE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toBuffer();
  return new Uint8Array(
    await sharp(mosaic)
      .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
      .resize(width, height, { fit: "fill" })
      .png()
      .toBuffer(),
  );
}

export const openAerialMapProvider: TrackImageryProvider = {
  id: "openaerialmap",
  name: "OpenAerialMap",
  supports: () => true,
  owns: (candidateId) => candidateId.startsWith("openaerialmap:") && OPEN_AERIAL_MAP_ID.test(candidateId.slice("openaerialmap:".length)),
  async search(context) {
    return (await searchCandidates(context)).map(({ candidate }) => candidate);
  },
  async resolve(candidateId, context) {
    if (!candidateId.startsWith("openaerialmap:") || !OPEN_AERIAL_MAP_ID.test(candidateId.slice("openaerialmap:".length))) throw new Error("OpenAerialMap candidate id is not recognized");
    const id = candidateId.slice("openaerialmap:".length);
    const data = (await (await request(`${OPEN_AERIAL_MAP_API_URL}/meta/${id}`, context.fetcher)).json()) as OpenAerialMapResponse;
    const resolved = candidatesFromResponse(data, context.bounds).find(({ candidate }) => candidate.id === candidateId);
    if (!resolved) throw new Error("OpenAerialMap image is not a licensed, full-coverage HQ source");
    return resolved;
  },
  async fetch(resolved, bounds, width, height, fetcher) {
    if (resolved.candidate.provider !== "openaerialmap") throw new Error("Resolved candidate does not belong to OpenAerialMap");
    const template =
      typeof resolved.providerData === "object" && resolved.providerData !== null && "tileTemplate" in resolved.providerData && typeof resolved.providerData.tileTemplate === "string"
        ? resolved.providerData.tileTemplate
        : null;
    if (!template) throw new Error("OpenAerialMap image has no tile service");
    return renderRegion(template, bounds, width, height, fetcher);
  },
};
