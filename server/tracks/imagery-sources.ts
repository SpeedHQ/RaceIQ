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
const PLANETARY_COMPUTER_STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const NASA_HLS_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const NASA_HLS_METADATA_URL = "https://gibs.earthdata.nasa.gov/layer-metadata/v1.0/HLS_S30_Nadir_BRDF_Adjusted_Reflectance.json";
const OPEN_AERIAL_MAP_ID = /^[a-f0-9]{24}$/;
const NASA_HLS_ID = /^nasa-hls-(\d{4}-\d{2}-\d{2})$/;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_TILE_REQUESTS = 400;
const TILE_SIZE = 256;
const REQUEST_TIMEOUT_MS = 90_000;

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
  properties?: {
    license?: string;
    tms?: string;
  };
  user?: { name?: string } | string;
}

interface OpenAerialMapResponse {
  meta?: { license?: string };
  results?: OpenAerialMapItem[] | OpenAerialMapItem;
}

interface StacSearchResponse {
  features?: Array<{
    properties?: {
      datetime?: string;
      "eo:cloud_cover"?: number;
    };
  }>;
}

interface ResolvedCandidate {
  candidate: TrackImageryCandidate;
  tileTemplate?: string;
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
    name: candidate.title,
    url: candidate.sourceUrl,
    ...(candidate.capturedAt ? { capturedAt: candidate.capturedAt } : {}),
    license: candidate.license,
    attribution: candidate.attribution,
    quality: candidate.quality,
    ...(candidate.resolutionM ? { resolutionM: candidate.resolutionM } : {}),
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
  const probe = new URL(normalized.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"));
  if (probe.protocol !== "https:" || probe.hostname !== "tiles.openaerialmap.org" || !normalized.includes("{z}") || !normalized.includes("{x}") || !normalized.includes("{y}")) return null;
  return normalized;
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
  const provider = item.provider?.trim() || (typeof item.user === "object" ? item.user.name?.trim() : undefined);
  return {
    candidate: TrackImageryCandidateSchema.parse({
      id: `oam-${item._id}`,
      provider: "openaerialmap",
      quality: resolutionM !== undefined && resolutionM <= 2 ? "hq" : "lq",
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
    .slice(0, 5)
    .map(({ candidate }) => candidate);
}

function isoDateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function findNasaHlsCandidates(bounds: TrackImageryGeographicBounds, fetcher: Fetcher): Promise<TrackImageryCandidate[]> {
  const response = await request(PLANETARY_COMPUTER_STAC_URL, fetcher, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      collections: ["sentinel-2-l2a"],
      bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
      datetime: `${isoDateOffset(-372)}/${isoDateOffset(-7)}`,
      query: { "eo:cloud_cover": { lt: 30 } },
      sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
      limit: 20,
    }),
  });
  const data = (await response.json()) as StacSearchResponse;
  const seen = new Set<string>();
  const candidates: TrackImageryCandidate[] = [];
  for (const feature of data.features ?? []) {
    const capturedAt = boundedDate(feature.properties?.datetime);
    if (!capturedAt || seen.has(capturedAt)) continue;
    seen.add(capturedAt);
    const cloudCover = feature.properties?.["eo:cloud_cover"];
    candidates.push(
      TrackImageryCandidateSchema.parse({
        id: `nasa-hls-${capturedAt}`,
        provider: "nasa-hls",
        quality: "lq",
        title: `NASA HLS Sentinel-2 · ${capturedAt}${typeof cloudCover === "number" ? ` · ${cloudCover.toFixed(1)}% scene cloud` : ""}`,
        capturedAt,
        resolutionM: 30,
        license: "NASA open data; Copernicus Sentinel Data Terms",
        attribution: "NASA Harmonized Landsat Sentinel-2 (HLS); contains modified Copernicus Sentinel-2 data",
        sourceUrl: NASA_HLS_METADATA_URL,
      }),
    );
    if (candidates.length === 3) break;
  }
  return candidates;
}

export async function searchOpenTrackImagery(input: unknown, fetcher: Fetcher = fetch): Promise<TrackImagerySourceSearchResult> {
  const bounds = assertUsefulBounds(input);
  const searches = await Promise.allSettled([findNaipCandidate(bounds, fetcher), findOpenAerialMapCandidates(bounds, fetcher), findNasaHlsCandidates(bounds, fetcher)]);
  const labels = ["USGS NAIP", "OpenAerialMap", "NASA HLS"];
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
  candidates.sort((left, right) => Number(right.quality === "hq") - Number(left.quality === "hq") || (left.resolutionM ?? Infinity) - (right.resolutionM ?? Infinity));
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
    if (!resolved) throw new Error("OpenAerialMap image does not fully cover this GPS footprint");
    return resolved;
  }
  const nasaMatch = NASA_HLS_ID.exec(id);
  if (nasaMatch) {
    const capturedAt = nasaMatch[1];
    const parsedDate = Date.parse(`${capturedAt}T00:00:00Z`);
    if (!Number.isFinite(parsedDate) || parsedDate > Date.now() || parsedDate < Date.UTC(2015, 0, 1)) throw new Error("Invalid NASA HLS capture date");
    return {
      candidate: TrackImageryCandidateSchema.parse({
        id,
        provider: "nasa-hls",
        quality: "lq",
        title: `NASA HLS Sentinel-2 · ${capturedAt}`,
        capturedAt,
        resolutionM: 30,
        license: "NASA open data; Copernicus Sentinel Data Terms",
        attribution: "NASA Harmonized Landsat Sentinel-2 (HLS); contains modified Copernicus Sentinel-2 data",
        sourceUrl: NASA_HLS_METADATA_URL,
      }),
    };
  }
  throw new Error("Unknown imagery source");
}

export function trackImageryRasterDimensions(boundsInput: unknown, maxDimension: number): { width: number; height: number } {
  const bounds = assertUsefulBounds(boundsInput);
  const safeMaximum = Math.max(256, Math.min(4_000, Math.floor(maxDimension)));
  const latitudeRad = (((bounds.south + bounds.north) / 2) * Math.PI) / 180;
  const widthM = Math.max(Number.EPSILON, (bounds.east - bounds.west) * Math.cos(latitudeRad));
  const heightM = Math.max(Number.EPSILON, bounds.north - bounds.south);
  const aspectRatio = widthM / heightM;
  if (aspectRatio >= 1) return { width: safeMaximum, height: Math.max(256, Math.round(safeMaximum / aspectRatio)) };
  return { width: Math.max(256, Math.round(safeMaximum * aspectRatio)), height: safeMaximum };
}

function tileX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * 2 ** zoom;
}

function tileY(latitude: number, zoom: number): number {
  const latitudeRad = (Math.max(-85.051_128_78, Math.min(85.051_128_78, latitude)) * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(latitudeRad)) / Math.PI) / 2) * 2 ** zoom;
}

async function renderOpenAerialMapTiles(tileTemplate: string, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: Fetcher): Promise<Uint8Array> {
  const zoom = Math.max(0, Math.min(22, Math.ceil(Math.log2((width * 360) / (TILE_SIZE * (bounds.east - bounds.west))))));
  const westX = tileX(bounds.west, zoom);
  const eastX = tileX(bounds.east, zoom);
  const northY = tileY(bounds.north, zoom);
  const southY = tileY(bounds.south, zoom);
  const startX = Math.floor(westX);
  const endX = Math.floor(eastX);
  const startY = Math.floor(northY);
  const endY = Math.floor(southY);
  const columns = endX - startX + 1;
  const rows = endY - startY + 1;
  if (columns <= 0 || rows <= 0 || columns * rows > MAX_TILE_REQUESTS) throw new Error("OpenAerialMap footprint requires too many source tiles");

  const tileJobs: Array<{ x: number; y: number }> = [];
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) tileJobs.push({ x, y });
  }
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let offset = 0; offset < tileJobs.length; offset += 16) {
    const batch = tileJobs.slice(offset, offset + 16);
    const tiles = await Promise.all(
      batch.map(async ({ x, y }) => {
        const url = tileTemplate.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));
        const response = await fetcher(url, {
          headers: { Accept: "image/png,image/jpeg,image/webp,*/*", "User-Agent": "RaceIQ track imagery curator" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`tiles.openaerialmap.org returned HTTP ${response.status}`);
        return { input: Buffer.from(await responseBytes(response)), left: (x - startX) * TILE_SIZE, top: (y - startY) * TILE_SIZE };
      }),
    );
    for (const tile of tiles) {
      if (tile) composites.push(tile);
    }
  }
  if (composites.length === 0) throw new Error("OpenAerialMap returned no image tiles for this footprint");
  const left = Math.floor((westX - startX) * TILE_SIZE);
  const top = Math.floor((northY - startY) * TILE_SIZE);
  const right = Math.ceil((eastX - startX) * TILE_SIZE);
  const bottom = Math.ceil((southY - startY) * TILE_SIZE);
  return new Uint8Array(
    await sharp({ create: { width: columns * TILE_SIZE, height: rows * TILE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites)
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
  if (resolved.candidate.provider === "nasa-hls") {
    const url = new URL(NASA_HLS_WMS_URL);
    url.search = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.1.1",
      REQUEST: "GetMap",
      LAYERS: "HLS_S30_Nadir_BRDF_Adjusted_Reflectance",
      STYLES: "default",
      SRS: "EPSG:4326",
      BBOX: boundsParam(bounds),
      WIDTH: String(width),
      HEIGHT: String(height),
      FORMAT: "image/png",
      TRANSPARENT: "FALSE",
      TIME: resolved.candidate.capturedAt ?? "",
    }).toString();
    return responseBytes(await request(url.href, fetcher));
  }
  if (!resolved.tileTemplate) throw new Error("OpenAerialMap image has no tile service");
  return renderOpenAerialMapTiles(resolved.tileTemplate, bounds, width, height, fetcher);
}

async function normalizeOpaqueRaster(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const input = sharp(bytes, { limitInputPixels: 50_000_000 }).rotate().resize(width, height, { fit: "fill" });
  const stats = await input.clone().stats();
  const alpha = stats.channels[3];
  if (alpha && alpha.min < 254) throw new Error("Open imagery does not fully cover this GPS footprint");
  const colorChannels = stats.channels.slice(0, 3);
  if (colorChannels.every((channel) => channel.max <= 5) || colorChannels.every((channel) => channel.min >= 250)) throw new Error("Open imagery source returned no visible coverage");
  return new Uint8Array(await input.webp({ quality: 90, effort: 4 }).toBuffer());
}

export interface OpenTrackImageryRaster {
  bytes: Uint8Array;
  source: TrackImagerySource;
  candidate: TrackImageryCandidate;
  width: number;
  height: number;
}

export async function loadOpenTrackImageryRaster(candidateId: string, boundsInput: unknown, purpose: "preview" | "asset", fetcher: Fetcher = fetch): Promise<OpenTrackImageryRaster> {
  const bounds = assertUsefulBounds(boundsInput);
  const resolved = await resolveCandidate(candidateId, bounds, fetcher);
  const dimensions = trackImageryRasterDimensions(bounds, purpose === "preview" ? 1_000 : resolved.candidate.quality === "hq" ? 4_000 : 1_400);
  const raw = await fetchProviderRaster(resolved, bounds, dimensions.width, dimensions.height, fetcher);
  const bytes = await normalizeOpaqueRaster(raw, dimensions.width, dimensions.height);
  return { bytes, source: candidateSource(resolved.candidate), candidate: resolved.candidate, ...dimensions };
}
