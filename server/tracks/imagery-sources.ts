import sharp from "sharp";
import {
  TrackImageryCandidateSchema,
  TrackImageryGeographicBoundsSchema,
  type TrackImageryCandidate,
  type TrackImageryGeographicBounds,
  type TrackImagerySource,
  type TrackImagerySourceSearchResult,
} from "../../shared/racing/tracks/imagery";

const NAIP_SERVICE_URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer";
const OPEN_AERIAL_MAP_API_URL = "https://api.openaerialmap.org";
const OPEN_AERIAL_MAP_ID = /^[a-f0-9]{24}$/;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_TILE_REQUESTS = 400;
const SOURCE_TILE_SIZE = 256;
const DEFAULT_TILE_SIZE = 512;
const REQUEST_TIMEOUT_MS = 90_000;
const SOURCE_FETCH_CONCURRENCY = 8;
const SOURCE_CACHE_LIMIT = 64;
const EARTH_RADIUS_M = 6_378_137;

type Fetcher = typeof fetch;

interface NaipQueryResponse {
  features?: Array<{
    attributes?: {
      Year?: number;
      acquisition_date?: number | null;
      resolution_value?: number | null;
    };
  }>;
}

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

interface ResolvedCandidate {
  candidate: TrackImageryCandidate;
  tileTemplate?: string;
}

export interface OpenTrackImageryTile {
  tier: "hq";
  x: number;
  y: number;
  width: number;
  height: number;
  format: "webp";
  data: Uint8Array;
}

export interface OpenTrackImageryAsset {
  source: TrackImagerySource;
  candidate: TrackImageryCandidate;
  bounds: TrackImageryGeographicBounds;
  width: number;
  height: number;
  tileSize: number;
  columns: number;
  rows: number;
  resolutionM: number;
  tiles: AsyncIterable<OpenTrackImageryTile>;
}

function assertUsefulBounds(input: unknown): TrackImageryGeographicBounds {
  const bounds = TrackImageryGeographicBoundsSchema.parse(input);
  if (bounds.east - bounds.west > 2 || bounds.north - bounds.south > 2) throw new Error("Imagery bounds may span at most 2 degrees");
  return bounds;
}

function boundsParam(bounds: TrackImageryGeographicBounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north].join(",");
}

function boundedDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  return value.slice(0, 10);
}

function candidateSource(candidate: TrackImageryCandidate): TrackImagerySource {
  return {
    provider: candidate.provider,
    name: candidate.title,
    url: candidate.sourceUrl,
    ...(candidate.capturedAt ? { capturedAt: candidate.capturedAt } : {}),
    license: candidate.license,
    attribution: candidate.attribution,
    quality: candidate.quality,
    ...(candidate.resolutionM ? { sourceResolutionM: candidate.resolutionM } : {}),
  };
}

async function request(url: string, fetcher: Fetcher, init?: RequestInit): Promise<Response> {
  const response = await fetcher(url, {
    ...init,
    headers: { Accept: "application/json,image/avif,image/webp,image/png,image/jpeg,*/*", "User-Agent": "RaceIQ track imagery curator", ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
  return response;
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_SOURCE_BYTES) throw new Error("Imagery source response exceeds 100 MiB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("Imagery source returned an invalid image size");
  return bytes;
}

async function findNaipCandidate(bounds: TrackImageryGeographicBounds, fetcher: Fetcher): Promise<TrackImageryCandidate[]> {
  const query = new URL(`${NAIP_SERVICE_URL}/query`);
  query.search = new URLSearchParams({
    f: "json",
    geometry: boundsParam(bounds),
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
  if (!attributes) return [];
  const year = Number.isSafeInteger(attributes.Year) ? attributes.Year : undefined;
  const capturedAt = typeof attributes.acquisition_date === "number" ? new Date(attributes.acquisition_date).toISOString().slice(0, 10) : year ? `${year}-01-01` : undefined;
  return [
    TrackImageryCandidateSchema.parse({
      id: "naip",
      provider: "naip",
      quality: "hq",
      title: year ? `USGS NAIP ${year}` : "USGS NAIP",
      capturedAt,
      // NAIP imagery is published at 0.6m or finer. Missing service metadata cannot turn it into LQ.
      resolutionM: typeof attributes.resolution_value === "number" && attributes.resolution_value > 0 ? attributes.resolution_value : 0.6,
      license: "Public domain",
      attribution: "National Agriculture Imagery Program (NAIP), USDA Farm Service Agency; distributed by the U.S. Geological Survey",
      sourceUrl: NAIP_SERVICE_URL,
    }),
  ];
}

function openAerialMapTileTemplate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^http:\/\/tiles\.openaerialmap\.org\//, "https://tiles.openaerialmap.org/");
  try {
    const probe = new URL(normalized.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"));
    if (probe.protocol !== "https:" || probe.hostname !== "tiles.openaerialmap.org" || !normalized.includes("{z}") || !normalized.includes("{x}") || !normalized.includes("{y}")) return null;
    return normalized;
  } catch {
    return null;
  }
}

function itemCoversBounds(item: OpenAerialMapItem, bounds: TrackImageryGeographicBounds): boolean {
  if (!Array.isArray(item.bbox) || item.bbox.length !== 4 || item.bbox.some((value) => !Number.isFinite(value))) return false;
  const [west, south, east, north] = item.bbox;
  return west <= bounds.west && south <= bounds.south && east >= bounds.east && north >= bounds.north;
}

function openAerialMapCandidate(item: OpenAerialMapItem, bounds: TrackImageryGeographicBounds, catalogLicense = "CC BY 4.0"): ResolvedCandidate | null {
  if (!OPEN_AERIAL_MAP_ID.test(item._id ?? "") || !itemCoversBounds(item, bounds)) return null;
  const tileTemplate = openAerialMapTileTemplate(item.properties?.tms);
  if (!tileTemplate || typeof item.uuid !== "string") return null;
  const license = (item.properties?.license?.trim() || catalogLicense).replace("CC-BY", "CC BY");
  if (!/public domain/i.test(license) && !/^CC BY(?: 4\.0)?(?: International)?$/i.test(license)) return null;
  const resolutionM = typeof item.gsd === "number" && Number.isFinite(item.gsd) && item.gsd > 0 ? item.gsd : undefined;
  // Asset imports require known HQ GSD. Exclude unknown and coarse/LQ catalog records here.
  if (resolutionM === undefined || resolutionM > 2) return null;
  const provider = item.provider?.trim() || (typeof item.user === "object" ? item.user.name?.trim() : undefined);
  return {
    candidate: TrackImageryCandidateSchema.parse({
      id: `oam-${item._id}`,
      provider: "openaerialmap",
      quality: "hq",
      title: item.title?.trim() || "OpenAerialMap imagery",
      capturedAt: boundedDate(item.acquisition_start),
      resolutionM,
      license,
      attribution: provider ? `${provider}; distributed by OpenAerialMap` : "OpenAerialMap contributors",
      sourceUrl: item.uuid,
    }),
    tileTemplate,
  };
}

async function findOpenAerialMapCandidates(bounds: TrackImageryGeographicBounds, fetcher: Fetcher): Promise<TrackImageryCandidate[]> {
  const query = new URL(`${OPEN_AERIAL_MAP_API_URL}/meta`);
  query.search = new URLSearchParams({ bbox: boundsParam(bounds), has_tiled: "true", order_by: "gsd", sort: "asc", limit: "25" }).toString();
  const data = (await (await request(query.href, fetcher)).json()) as OpenAerialMapResponse;
  const items = Array.isArray(data.results) ? data.results : [];
  return items
    .map((item) => openAerialMapCandidate(item, bounds, data.meta?.license))
    .filter((candidate): candidate is ResolvedCandidate => candidate !== null)
    .sort((left, right) => (left.candidate.resolutionM ?? Infinity) - (right.candidate.resolutionM ?? Infinity))
    .slice(0, 5)
    .map(({ candidate }) => candidate);
}

export async function searchOpenTrackImagery(input: unknown, fetcher: Fetcher = fetch): Promise<TrackImagerySourceSearchResult> {
  const bounds = assertUsefulBounds(input);
  const searches = await Promise.allSettled([findNaipCandidate(bounds, fetcher), findOpenAerialMapCandidates(bounds, fetcher)]);
  const labels = ["USGS NAIP", "OpenAerialMap"];
  const candidates: TrackImageryCandidate[] = [];
  const notices: string[] = [];
  for (const [index, result] of searches.entries()) {
    if (result.status === "rejected") {
      notices.push(`${labels[index]} search unavailable: ${result.reason instanceof Error ? result.reason.message : "unknown error"}`);
      continue;
    }
    candidates.push(...result.value);
    if (result.value.length === 0) notices.push(`${labels[index]} has no full coverage for this GPS footprint.`);
  }
  candidates.sort((left, right) => (left.resolutionM ?? Infinity) - (right.resolutionM ?? Infinity));
  return { candidates, notices };
}

async function resolveCandidate(id: string, bounds: TrackImageryGeographicBounds, fetcher: Fetcher): Promise<ResolvedCandidate> {
  if (id === "naip") {
    const candidate = (await findNaipCandidate(bounds, fetcher))[0];
    if (!candidate) throw new Error("USGS NAIP has no coverage for this GPS footprint");
    return { candidate };
  }
  const openAerialMapId = id.startsWith("oam-") ? id.slice(4) : "";
  if (OPEN_AERIAL_MAP_ID.test(openAerialMapId)) {
    const data = (await (await request(`${OPEN_AERIAL_MAP_API_URL}/meta/${openAerialMapId}`, fetcher)).json()) as OpenAerialMapResponse;
    const item = Array.isArray(data.results) ? data.results[0] : data.results;
    const resolved = item ? openAerialMapCandidate(item, bounds, data.meta?.license) : null;
    if (!resolved) throw new Error("OpenAerialMap image is not a licensed, full-coverage HQ source");
    return resolved;
  }
  throw new Error("Unknown imagery source");
}

function geographicSpanMeters(bounds: TrackImageryGeographicBounds): { width: number; height: number } {
  const latitudeRad = (((bounds.south + bounds.north) / 2) * Math.PI) / 180;
  return {
    width: Math.max(Number.EPSILON, (((bounds.east - bounds.west) * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(latitudeRad)),
    height: Math.max(Number.EPSILON, (((bounds.north - bounds.south) * Math.PI) / 180) * EARTH_RADIUS_M),
  };
}

export function trackImageryRasterDimensions(boundsInput: unknown, maxDimension: number): { width: number; height: number } {
  const bounds = assertUsefulBounds(boundsInput);
  const safeMaximum = Math.max(1, Math.min(1_000, Math.floor(maxDimension)));
  const { width: widthM, height: heightM } = geographicSpanMeters(bounds);
  const aspectRatio = widthM / heightM;
  if (aspectRatio >= 1) return { width: safeMaximum, height: Math.max(1, Math.round(safeMaximum / aspectRatio)) };
  return { width: Math.max(1, Math.round(safeMaximum * aspectRatio)), height: safeMaximum };
}

function imageryGrid(bounds: TrackImageryGeographicBounds, resolutionM: number, tileSize: number): { width: number; height: number; columns: number; rows: number } {
  const { width: widthM, height: heightM } = geographicSpanMeters(bounds);
  const width = Math.max(1, Math.ceil(widthM / resolutionM));
  const height = Math.max(1, Math.ceil(heightM / resolutionM));
  return { width, height, columns: Math.ceil(width / tileSize), rows: Math.ceil(height / tileSize) };
}

function tileBounds(bounds: TrackImageryGeographicBounds, x: number, y: number, width: number, height: number, gridWidth: number, gridHeight: number): TrackImageryGeographicBounds {
  const west = bounds.west + ((bounds.east - bounds.west) * x) / gridWidth;
  const east = bounds.west + ((bounds.east - bounds.west) * (x + width)) / gridWidth;
  const north = bounds.north - ((bounds.north - bounds.south) * y) / gridHeight;
  const south = bounds.north - ((bounds.north - bounds.south) * (y + height)) / gridHeight;
  return { west, south, east, north };
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
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
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

async function mapBounded<T, R>(values: readonly T[], concurrency: number, callback: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await callback(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

async function renderOpenAerialMapRegion(tileTemplate: string, bounds: TrackImageryGeographicBounds, width: number, height: number, cache: SourceTileCache): Promise<Uint8Array> {
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
  const fetched = await mapBounded(jobs, SOURCE_FETCH_CONCURRENCY, async ({ x, y }) => ({
    x,
    y,
    bytes: await cache.get(tileTemplate.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y))),
  }));
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

async function fetchProviderRaster(resolved: ResolvedCandidate, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: Fetcher): Promise<Uint8Array> {
  if (resolved.candidate.provider === "naip") {
    const url = new URL(`${NAIP_SERVICE_URL}/exportImage`);
    url.search = new URLSearchParams({
      bbox: boundsParam(bounds),
      bboxSR: "4326",
      imageSR: "4326",
      size: `${width},${height}`,
      format: "jpg",
      pixelType: "U8",
      renderingRule: JSON.stringify({ rasterFunction: "NaturalColor" }),
      f: "image",
    }).toString();
    return responseBytes(await request(url.href, fetcher));
  }
  if (!resolved.tileTemplate) throw new Error("OpenAerialMap image has no tile service");
  return renderOpenAerialMapRegion(resolved.tileTemplate, bounds, width, height, new SourceTileCache(fetcher));
}

async function normalizeOpaqueRaster(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const input = sharp(bytes, { limitInputPixels: 50_000_000 }).rotate().resize(width, height, { fit: "fill" });
  const stats = await input.clone().stats();
  const alpha = stats.channels[3];
  if (alpha && alpha.min < 254) throw new Error("Open imagery does not fully cover this GPS footprint");
  const colorChannels = stats.channels.slice(0, 3);
  if (colorChannels.length >= 3 && (colorChannels.every((channel) => channel.max <= 5) || colorChannels.every((channel) => channel.min >= 250)))
    throw new Error("Open imagery source returned no visible coverage");
  return new Uint8Array(await input.webp({ quality: 90, effort: 4 }).toBuffer());
}

export interface OpenTrackImageryRaster {
  bytes: Uint8Array;
  source: TrackImagerySource;
  candidate: TrackImageryCandidate;
  width: number;
  height: number;
}

export async function loadOpenTrackImageryRaster(candidateId: string, boundsInput: unknown, purpose: "preview", fetcher: Fetcher = fetch): Promise<OpenTrackImageryRaster> {
  if (purpose !== "preview") throw new Error("Only imagery previews use the raster endpoint");
  const bounds = assertUsefulBounds(boundsInput);
  const resolved = await resolveCandidate(candidateId, bounds, fetcher);
  const dimensions = trackImageryRasterDimensions(bounds, 1_000);
  const raw = await fetchProviderRaster(resolved, bounds, dimensions.width, dimensions.height, fetcher);
  const bytes = await normalizeOpaqueRaster(raw, dimensions.width, dimensions.height);
  return { bytes, source: candidateSource(resolved.candidate), candidate: resolved.candidate, ...dimensions };
}

export async function loadOpenTrackImageryAsset(candidateId: string, boundsInput: unknown, tileSize = DEFAULT_TILE_SIZE, fetcher: Fetcher = fetch): Promise<OpenTrackImageryAsset> {
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || tileSize > 2_048) throw new Error("Imagery tile size must be between 1 and 2048 pixels");
  const bounds = assertUsefulBounds(boundsInput);
  const resolved = await resolveCandidate(candidateId, bounds, fetcher);
  if (resolved.candidate.quality !== "hq" || !resolved.candidate.resolutionM || !Number.isFinite(resolved.candidate.resolutionM) || resolved.candidate.resolutionM <= 0)
    throw new Error("Imagery source has no known HQ resolution");
  const resolutionM = Math.max(resolved.candidate.resolutionM, 0.1);
  const grid = imageryGrid(bounds, resolutionM, tileSize);
  const cache = new SourceTileCache(fetcher);
  const tiles = (async function* (): AsyncIterable<OpenTrackImageryTile> {
    for (let y = 0; y < grid.height; y += tileSize) {
      for (let x = 0; x < grid.width; x += tileSize) {
        const width = Math.min(tileSize, grid.width - x);
        const height = Math.min(tileSize, grid.height - y);
        const tile = tileBounds(bounds, x, y, width, height, grid.width, grid.height);
        const raw =
          resolved.candidate.provider === "naip"
            ? await (async () => {
                const url = new URL(`${NAIP_SERVICE_URL}/exportImage`);
                url.search = new URLSearchParams({
                  bbox: boundsParam(tile),
                  bboxSR: "4326",
                  imageSR: "4326",
                  size: `${width},${height}`,
                  format: "jpg",
                  pixelType: "U8",
                  renderingRule: JSON.stringify({ rasterFunction: "NaturalColor" }),
                  f: "image",
                }).toString();
                return responseBytes(await request(url.href, fetcher));
              })()
            : await renderOpenAerialMapRegion(resolved.tileTemplate!, tile, width, height, cache);
        yield { tier: "hq", x: Math.floor(x / tileSize), y: Math.floor(y / tileSize), width, height, format: "webp", data: await normalizeOpaqueRaster(raw, width, height) };
      }
    }
  })();
  const source = { ...candidateSource(resolved.candidate), storedResolutionM: resolutionM };
  return { source, candidate: resolved.candidate, bounds, ...grid, tileSize, resolutionM, tiles };
}
