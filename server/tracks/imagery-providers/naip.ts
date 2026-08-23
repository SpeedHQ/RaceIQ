import sharp from "sharp";
import { z } from "zod";
import type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";
import { request, requestBytes, responseBytes } from "./http";
import { TrackImageryGeographicBoundsSchema, type TrackImageryCandidate, type TrackImageryGeographicBounds } from "../../../shared/racing/tracks/imagery";

const NAIP_SERVICE_URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer";
const PLANETARY_COMPUTER_URL = "https://planetarycomputer.microsoft.com";
const NAIP_STAC_URL = `${PLANETARY_COMPUTER_URL}/api/stac/v1`;
const NAIP_DATA_URL = `${PLANETARY_COMPUTER_URL}/api/data/v1`;
const NAIP_HISTORY_URL = `${PLANETARY_COMPUTER_URL}/dataset/naip`;
const NAIP_COLLECTION = "naip";
const NAIP_LATEST_ID = "usgs-naip:latest";
const NAIP_VINTAGE_ID = /^usgs-naip:(20\d{2})$/;
const STAC_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const STAC_SEARCH_LIMIT = 500;
const MAX_RENDER_ITEMS = 64;
const RENDER_CONCURRENCY = 4;

interface NaipQueryResponse {
  features?: Array<{
    attributes?: {
      Year?: number | null;
      acquisition_date?: number | null;
      resolution_value?: number | null;
    };
  }>;
}

const HistoricalNaipItemSchema = z.object({
  id: z.string().regex(STAC_ITEM_ID),
  bounds: TrackImageryGeographicBoundsSchema,
  year: z.number().int().min(2010).max(2100),
  capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceResolutionM: z.number().positive(),
});

const HistoricalNaipProviderDataSchema = z.object({
  year: z.number().int().min(2010).max(2100),
  items: z.array(HistoricalNaipItemSchema).min(1),
});

const StacNaipItemSchema = z.object({
  id: z.string().regex(STAC_ITEM_ID),
  collection: z.literal(NAIP_COLLECTION).optional(),
  bbox: z.array(z.number()).min(4),
  properties: z.object({
    datetime: z.string(),
    gsd: z.number().positive(),
    "naip:year": z.union([z.number().int(), z.string().regex(/^\d{4}$/)]),
  }),
  assets: z.object({ image: z.object({}).passthrough() }),
});

type HistoricalNaipItem = z.infer<typeof HistoricalNaipItemSchema>;
type HistoricalNaipProviderData = z.infer<typeof HistoricalNaipProviderDataSchema>;

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
    id: NAIP_LATEST_ID,
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
    where: "Category = 1",
    outFields: "Year,acquisition_date,resolution_value",
    returnGeometry: "false",
    orderByFields: "Year DESC",
    resultRecordCount: "1",
  }).toString();
  const data = (await (await request(query.href, fetcher)).json()) as NaipQueryResponse;
  const attributes = data.features?.[0]?.attributes;
  return attributes ? [{ candidate: candidateFromAttributes(attributes), providerData: attributes }] : [];
}

function historicalItem(value: unknown): HistoricalNaipItem | null {
  const parsed = StacNaipItemSchema.safeParse(value);
  if (!parsed.success) return null;
  const [west, south, east, north] = parsed.data.bbox;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  const year = typeof parsed.data.properties["naip:year"] === "string" ? Number(parsed.data.properties["naip:year"]) : parsed.data.properties["naip:year"];
  const capturedTimestamp = Date.parse(parsed.data.properties.datetime);
  if (year < 2010 || year > new Date().getUTCFullYear() + 1 || !Number.isFinite(capturedTimestamp)) return null;
  return {
    id: parsed.data.id,
    bounds: { west, south, east, north },
    year,
    capturedAt: new Date(capturedTimestamp).toISOString().slice(0, 10),
    sourceResolutionM: parsed.data.properties.gsd,
  };
}

function intersects(left: TrackImageryGeographicBounds, right: TrackImageryGeographicBounds): boolean {
  return left.west < right.east && left.east > right.west && left.south < right.north && left.north > right.south;
}

function coversBounds(items: readonly HistoricalNaipItem[], bounds: TrackImageryGeographicBounds): boolean {
  const relevant = items.filter((item) => intersects(item.bounds, bounds));
  const xBreaks = [bounds.west, bounds.east, ...relevant.flatMap((item) => [Math.max(bounds.west, item.bounds.west), Math.min(bounds.east, item.bounds.east)])]
    .filter((value) => value >= bounds.west && value <= bounds.east)
    .sort((left, right) => left - right)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
  const epsilon = 1e-10;
  for (let index = 0; index < xBreaks.length - 1; index += 1) {
    const west = xBreaks[index];
    const east = xBreaks[index + 1];
    if (east - west <= epsilon) continue;
    const longitude = (west + east) / 2;
    const intervals = relevant
      .filter((item) => item.bounds.west <= longitude && item.bounds.east >= longitude)
      .map((item) => [Math.max(bounds.south, item.bounds.south), Math.min(bounds.north, item.bounds.north)] as const)
      .filter(([south, north]) => north > south)
      .sort(([leftSouth], [rightSouth]) => leftSouth - rightSouth);
    let coveredNorth = bounds.south;
    for (const [south, north] of intervals) {
      if (south > coveredNorth + epsilon) return false;
      coveredNorth = Math.max(coveredNorth, north);
      if (coveredNorth >= bounds.north - epsilon) break;
    }
    if (coveredNorth < bounds.north - epsilon) return false;
  }
  return xBreaks.length >= 2;
}

function captureRange(items: readonly HistoricalNaipItem[]): string {
  const dates = [...new Set(items.map((item) => item.capturedAt))].sort();
  return dates.length === 1 ? dates[0] : `${dates[0]}/${dates.at(-1)}`;
}

function historicalCandidate(year: number, items: HistoricalNaipItem[]): TrackImageryProviderResolvedCandidate {
  const candidate: TrackImageryCandidate = {
    id: `usgs-naip:${year}`,
    provider: "usgs-naip",
    quality: "hq",
    coverage: "full",
    sourceResolutionM: Math.max(...items.map((item) => item.sourceResolutionM)),
    geographicReliability: "authoritative",
    providerStability: "authoritative",
    redistribution: "allowed",
    title: `USGS NAIP ${year}`,
    capturedAt: captureRange(items),
    license: "Public domain",
    attribution: "National Agriculture Imagery Program (NAIP), USDA Farm Service Agency",
    sourceUrl: NAIP_HISTORY_URL,
  };
  return { candidate, providerData: { year, items } satisfies HistoricalNaipProviderData };
}

async function queryHistorical(context: TrackImageryProviderContext, fetcher: TrackImageryFetcher): Promise<TrackImageryProviderResolvedCandidate[]> {
  if (!supports(context.location, context.bounds)) return [];
  const query = new URL(`${NAIP_STAC_URL}/search`);
  query.search = new URLSearchParams({
    collections: NAIP_COLLECTION,
    bbox: boundsParam(context.bounds),
    limit: String(STAC_SEARCH_LIMIT),
  }).toString();
  const response = (await (await request(query.href, fetcher)).json()) as { features?: unknown };
  if (!Array.isArray(response.features)) return [];
  if (response.features.length >= STAC_SEARCH_LIMIT) throw new Error("Historical NAIP search exceeded bounded catalog result limit");
  const groups = new Map<number, HistoricalNaipItem[]>();
  for (const value of response.features) {
    const item = historicalItem(value);
    if (!item) continue;
    const group = groups.get(item.year) ?? [];
    group.push(item);
    groups.set(item.year, group);
  }
  return [...groups.entries()]
    .filter(([, items]) => coversBounds(items, context.bounds))
    .sort(([leftYear], [rightYear]) => rightYear - leftYear)
    .map(([year, items]) => historicalCandidate(year, items));
}

function capturesDate(candidate: TrackImageryCandidate, capturedAt: string | undefined): boolean {
  if (!capturedAt || !candidate.capturedAt) return false;
  const [start, end = start] = candidate.capturedAt.split("/");
  return capturedAt >= start && capturedAt <= end;
}

async function searchAll(context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate[]> {
  const [latestResult, historicalResult] = await Promise.allSettled([queryLatest(context, context.fetcher), queryHistorical(context, context.fetcher)]);
  if (latestResult.status === "rejected" && historicalResult.status === "rejected") throw latestResult.reason;
  const historical = historicalResult.status === "fulfilled" ? historicalResult.value : [];
  const latest = latestResult.status === "fulfilled" ? latestResult.value : [];
  return [...historical, ...latest.filter(({ candidate }) => !historical.some(({ candidate: vintage }) => capturesDate(vintage, candidate.capturedAt)))];
}

function historicalProviderData(value: unknown, expectedYear: number): HistoricalNaipProviderData | null {
  const parsed = HistoricalNaipProviderDataSchema.safeParse(value);
  return parsed.success && parsed.data.year === expectedYear ? parsed.data : null;
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
  await Promise.all(Array.from({ length: Math.min(RENDER_CONCURRENCY, values.length) }, () => worker()));
  return output;
}

function historicalDataUrl(itemId: string, bounds: TrackImageryGeographicBounds, width: number, height: number): string {
  const url = new URL(`${NAIP_DATA_URL}/item/bbox/${boundsParam(bounds)}/${width}x${height}.webp`);
  url.searchParams.set("collection", NAIP_COLLECTION);
  url.searchParams.set("item", itemId);
  url.searchParams.set("assets", "image");
  url.searchParams.set("asset_bidx", "image|1,2,3");
  url.searchParams.set("resampling", "bilinear");
  return url.href;
}

async function renderHistorical(items: readonly HistoricalNaipItem[], bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
  const jobs = items
    .filter((item) => intersects(item.bounds, bounds))
    .map((item) => {
      const intersection = {
        west: Math.max(bounds.west, item.bounds.west),
        south: Math.max(bounds.south, item.bounds.south),
        east: Math.min(bounds.east, item.bounds.east),
        north: Math.min(bounds.north, item.bounds.north),
      };
      const left = Math.max(0, Math.floor(((intersection.west - bounds.west) / (bounds.east - bounds.west)) * width));
      const right = Math.min(width, Math.ceil(((intersection.east - bounds.west) / (bounds.east - bounds.west)) * width));
      const top = Math.max(0, Math.floor(((bounds.north - intersection.north) / (bounds.north - bounds.south)) * height));
      const bottom = Math.min(height, Math.ceil(((bounds.north - intersection.south) / (bounds.north - bounds.south)) * height));
      return { item, intersection, left, top, width: right - left, height: bottom - top };
    })
    .filter((job) => job.width > 0 && job.height > 0);
  if (jobs.length === 0 || jobs.length > MAX_RENDER_ITEMS) throw new Error("Historical NAIP footprint has invalid source tile coverage");
  const composites = await mapBounded(jobs, async (job) => ({
    input: Buffer.from(await requestBytes(historicalDataUrl(job.item.id, job.intersection, job.width, job.height), fetcher)),
    left: job.left,
    top: job.top,
  }));
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites)
      .png()
      .toBuffer(),
  );
}

async function fetchLatest(bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array> {
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
}

function toResolved(candidate: TrackImageryCandidate, providerData?: unknown): TrackImageryProviderResolvedCandidate {
  return { candidate, ...(providerData === undefined ? {} : { providerData }) };
}

export const naipProvider: TrackImageryProvider = {
  id: "usgs-naip",
  name: "USGS NAIP",
  maxFetchDimension: 4_000,
  supports,
  owns(candidateId) {
    return candidateId === NAIP_LATEST_ID || NAIP_VINTAGE_ID.test(candidateId);
  },
  async search(context) {
    return (await searchAll(context)).map(({ candidate }) => candidate);
  },
  async resolve(candidateId, context) {
    if (candidateId === NAIP_LATEST_ID) {
      const resolved = await queryLatest(context, context.fetcher);
      if (resolved.length === 0) throw new Error("USGS NAIP has no coverage for this GPS footprint");
      return toResolved(resolved[0].candidate, resolved[0].providerData);
    }
    const match = NAIP_VINTAGE_ID.exec(candidateId);
    if (!match) throw new Error("USGS NAIP candidate id is not recognized");
    const resolved = (await queryHistorical(context, context.fetcher)).find(({ candidate }) => candidate.id === candidateId);
    if (!resolved) throw new Error("Historical NAIP vintage does not fully cover this GPS footprint");
    return resolved;
  },
  async fetch(resolved, bounds, width, height, fetcher) {
    if (resolved.candidate.provider !== "usgs-naip" || !naipProvider.owns(resolved.candidate.id)) throw new Error("Resolved candidate does not belong to USGS NAIP");
    if (resolved.candidate.id === NAIP_LATEST_ID) return fetchLatest(bounds, width, height, fetcher);
    const match = NAIP_VINTAGE_ID.exec(resolved.candidate.id);
    const data = match ? historicalProviderData(resolved.providerData, Number(match[1])) : null;
    if (!data) throw new Error("Historical NAIP candidate has invalid source metadata");
    return renderHistorical(data.items, bounds, width, height, fetcher);
  },
};
