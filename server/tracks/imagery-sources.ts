import sharp from "sharp";
import {
  TrackImageryGeographicBoundsSchema,
  type TrackImageryCandidate,
  type TrackImageryGeographicBounds,
  type TrackImageryOutputBudget,
  type TrackImageryOutputEstimate,
  type TrackImagerySource,
  type TrackImagerySourceSearchResult,
} from "../../shared/racing/tracks/imagery";
import { resolveTrackImageryProviderCandidate, searchTrackImageryProviders, type TrackImageryFetcher, type TrackImageryLocation, type TrackImageryResolvedCandidate } from "./imagery-providers";

const DEFAULT_TILE_SIZE = 512;
const MAX_SOURCE_CHUNK_SIZE = 4_096;
const EARTH_RADIUS_M = 6_378_137;
const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;
const ESTIMATED_PACK_MINIMUM_BYTES_PER_PIXEL = 0.65;
const ESTIMATED_PACK_MAXIMUM_BYTES_PER_PIXEL = 1.7;
const ESTIMATED_PROCESSING_MS_PER_MEGAPIXEL = 1_000;
const ESTIMATED_SOURCE_CHUNK_MS = 15_000;
const REQUIRED_DISK_RESERVE_BYTES = GIBIBYTE;

export const TRACK_IMAGERY_IMPORT_LIMITS = {
  maximumWidth: 100_000,
  maximumHeight: 100_000,
  maximumTotalPixels: 500_000_000,
  maximumTiles: 4_096,
  maximumUncompressedBytes: 2 * GIBIBYTE,
  maximumEstimatedPackBytes: 2 * GIBIBYTE,
  maximumJobDurationMs: 30 * 60 * 1_000,
  maximumConcurrency: 1,
} as const;

type Fetcher = TrackImageryFetcher;

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
  estimate: TrackImageryOutputEstimate;
}

function assertUsefulBounds(input: unknown): TrackImageryGeographicBounds {
  const bounds = TrackImageryGeographicBoundsSchema.parse(input);
  if (bounds.east - bounds.west > 2 || bounds.north - bounds.south > 2) throw new Error("Imagery bounds may span at most 2 degrees");
  return bounds;
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
    coverage: candidate.coverage,
    sourceResolutionM: candidate.sourceResolutionM,
    geographicReliability: candidate.geographicReliability,
    ...(candidate.cloudCoverPercent !== undefined ? { cloudCoverPercent: candidate.cloudCoverPercent } : {}),
    providerStability: candidate.providerStability,
    redistribution: candidate.redistribution,
  };
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

function outputEstimateProblems(estimate: TrackImageryOutputEstimate): string[] {
  const problems: string[] = [];
  if (estimate.width > TRACK_IMAGERY_IMPORT_LIMITS.maximumWidth || estimate.height > TRACK_IMAGERY_IMPORT_LIMITS.maximumHeight) {
    problems.push(
      `Output dimensions ${estimate.width.toLocaleString()} × ${estimate.height.toLocaleString()} exceed the ${TRACK_IMAGERY_IMPORT_LIMITS.maximumWidth.toLocaleString()} pixel axis limit`,
    );
  }
  if (estimate.totalPixels > TRACK_IMAGERY_IMPORT_LIMITS.maximumTotalPixels) {
    problems.push(`Output has ${estimate.totalPixels.toLocaleString()} pixels; maximum is ${TRACK_IMAGERY_IMPORT_LIMITS.maximumTotalPixels.toLocaleString()}`);
  }
  if (estimate.totalTiles > TRACK_IMAGERY_IMPORT_LIMITS.maximumTiles) {
    problems.push(`Output has ${estimate.totalTiles.toLocaleString()} tiles; maximum is ${TRACK_IMAGERY_IMPORT_LIMITS.maximumTiles.toLocaleString()}`);
  }
  if (estimate.estimatedUncompressedBytes > TRACK_IMAGERY_IMPORT_LIMITS.maximumUncompressedBytes) {
    problems.push("Estimated uncompressed work exceeds 2 GiB");
  }
  if (estimate.estimatedPackBytes.maximum > TRACK_IMAGERY_IMPORT_LIMITS.maximumEstimatedPackBytes) {
    problems.push("Conservative final pack estimate exceeds 2 GiB");
  }
  if (estimate.estimatedJobDurationMs > TRACK_IMAGERY_IMPORT_LIMITS.maximumJobDurationMs) {
    problems.push("Estimated import duration exceeds the 30 minute job limit");
  }
  return problems;
}

export function trackImageryOutputEstimate(boundsInput: unknown, resolutionM: number, tileSize = DEFAULT_TILE_SIZE, maximumSourceDimension = MAX_SOURCE_CHUNK_SIZE): TrackImageryOutputEstimate {
  if (!Number.isFinite(resolutionM) || resolutionM <= 0) throw new Error("Imagery resolution must be positive and finite");
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || tileSize > 2_048) throw new Error("Imagery tile size must be between 1 and 2048 pixels");
  const bounds = assertUsefulBounds(boundsInput);
  const grid = imageryGrid(bounds, resolutionM, tileSize);
  const totalPixels = grid.width * grid.height;
  const totalTiles = grid.columns * grid.rows;
  if (!Number.isSafeInteger(totalPixels) || !Number.isSafeInteger(totalTiles)) throw new Error("Imagery output exceeds safe integer dimensions");
  const sourceDimensionLimit = Math.max(tileSize, Math.min(MAX_SOURCE_CHUNK_SIZE, Math.floor(maximumSourceDimension)));
  const sourceChunkSize = tileSize * Math.max(1, Math.floor(sourceDimensionLimit / tileSize));
  const sourceChunks = Math.ceil(grid.width / sourceChunkSize) * Math.ceil(grid.height / sourceChunkSize);
  const estimatedUncompressedBytes = totalPixels * 4;
  const estimatedPackBytes = {
    minimum: Math.ceil(totalPixels * ESTIMATED_PACK_MINIMUM_BYTES_PER_PIXEL + totalTiles * 4_096 + MEBIBYTE),
    maximum: Math.ceil(totalPixels * ESTIMATED_PACK_MAXIMUM_BYTES_PER_PIXEL + totalTiles * 8_192 + 8 * MEBIBYTE),
  };
  const estimatedJobDurationMs = Math.ceil((totalPixels / 1_000_000) * ESTIMATED_PROCESSING_MS_PER_MEGAPIXEL + sourceChunks * ESTIMATED_SOURCE_CHUNK_MS);
  return { ...grid, totalPixels, tileSize, totalTiles, sourceChunks, resolutionM, estimatedUncompressedBytes, estimatedPackBytes, estimatedJobDurationMs };
}

export function assessTrackImageryOutputBudget(estimate: TrackImageryOutputEstimate, availableDiskBytes: number | null, overrideActive = false): TrackImageryOutputBudget {
  const requiredDiskBytes = Math.ceil(estimate.estimatedPackBytes.maximum * 2 + REQUIRED_DISK_RESERVE_BYTES);
  const problems = outputEstimateProblems(estimate);
  if (availableDiskBytes === null) problems.push("Available disk space could not be determined");
  else if (availableDiskBytes < requiredDiskBytes) problems.push("Available disk space is below the conservative pack, temporary database, and reserve requirement");
  return {
    ...estimate,
    availableDiskBytes,
    requiredDiskBytes,
    maximumJobDurationMs: TRACK_IMAGERY_IMPORT_LIMITS.maximumJobDurationMs,
    maximumConcurrency: TRACK_IMAGERY_IMPORT_LIMITS.maximumConcurrency,
    safe: problems.length === 0 || overrideActive,
    overrideActive,
    problems,
  };
}

export function assertTrackImageryOutputBudget(budget: TrackImageryOutputBudget): void {
  if (!budget.safe) throw new Error(`Unsafe imagery output: ${budget.problems.join("; ")}`);
}

function tileBounds(bounds: TrackImageryGeographicBounds, x: number, y: number, width: number, height: number, gridWidth: number, gridHeight: number): TrackImageryGeographicBounds {
  const west = bounds.west + ((bounds.east - bounds.west) * x) / gridWidth;
  const east = bounds.west + ((bounds.east - bounds.west) * (x + width)) / gridWidth;
  const north = bounds.north - ((bounds.north - bounds.south) * y) / gridHeight;
  const south = bounds.north - ((bounds.north - bounds.south) * (y + height)) / gridHeight;
  return { west, south, east, north };
}

interface NormalizedRasterPixels {
  data: Buffer;
  width: number;
  height: number;
  channels: 3;
}

async function normalizeOpaquePixels(bytes: Uint8Array, width: number, height: number): Promise<NormalizedRasterPixels> {
  const input = sharp(bytes, { limitInputPixels: 50_000_000 }).rotate().resize(width, height, { fit: "fill" });
  const stats = await input.clone().stats();
  const alpha = stats.channels[3];
  if (alpha && alpha.min < 254) throw new Error("Open imagery does not fully cover this GPS footprint");
  const colorChannels = stats.channels.slice(0, 3);
  if (colorChannels.length >= 3 && (colorChannels.every((channel) => channel.max <= 5) || colorChannels.every((channel) => channel.min >= 250))) {
    throw new Error("Open imagery source returned no visible coverage");
  }
  const { data } = await input.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { data, width, height, channels: 3 };
}

async function normalizeOpaqueRaster(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const pixels = await normalizeOpaquePixels(bytes, width, height);
  return new Uint8Array(await sharp(pixels.data, { raw: pixels }).webp({ quality: 90, effort: 4 }).toBuffer());
}

export interface OpenTrackImageryRaster {
  bytes: Uint8Array;
  source: TrackImagerySource;
  candidate: TrackImageryCandidate;
  width: number;
  height: number;
}

export async function searchOpenTrackImagery(boundsInput: TrackImageryGeographicBounds, location: TrackImageryLocation, fetcher: Fetcher = fetch): Promise<TrackImagerySourceSearchResult> {
  return searchTrackImageryProviders(assertUsefulBounds(boundsInput), location, fetcher);
}

export async function loadOpenTrackImageryRaster(
  candidateId: string,
  boundsInput: TrackImageryGeographicBounds,
  location: TrackImageryLocation,
  purpose: "preview",
  fetcher: Fetcher = fetch,
): Promise<OpenTrackImageryRaster> {
  if (purpose !== "preview") throw new Error("Only imagery previews use the raster endpoint");
  const bounds = assertUsefulBounds(boundsInput);
  const resolved = await resolveTrackImageryProviderCandidate(candidateId, bounds, location, fetcher);
  const dimensions = trackImageryRasterDimensions(bounds, 1_000);
  const raw = await resolved.provider.fetch(resolved, bounds, dimensions.width, dimensions.height, fetcher);
  const bytes = await normalizeOpaqueRaster(raw, dimensions.width, dimensions.height);
  return { bytes, source: candidateSource(resolved.candidate), candidate: resolved.candidate, ...dimensions };
}

interface ResolvedOpenTrackImageryAssetPlan {
  bounds: TrackImageryGeographicBounds;
  resolved: TrackImageryResolvedCandidate;
  resolutionM: number;
  sourceChunkSize: number;
  estimate: TrackImageryOutputEstimate;
}

async function resolveOpenTrackImageryAssetPlan(
  candidateId: string,
  boundsInput: TrackImageryGeographicBounds,
  location: TrackImageryLocation,
  tileSize: number,
  fetcher: Fetcher,
): Promise<ResolvedOpenTrackImageryAssetPlan> {
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || tileSize > 2_048) throw new Error("Imagery tile size must be between 1 and 2048 pixels");
  const bounds = assertUsefulBounds(boundsInput);
  const resolved = await resolveTrackImageryProviderCandidate(candidateId, bounds, location, fetcher);
  if (!resolved.candidate.sourceResolutionM || !Number.isFinite(resolved.candidate.sourceResolutionM) || resolved.candidate.sourceResolutionM <= 0)
    throw new Error("Imagery source has no known resolution");
  const resolutionM = Math.max(resolved.candidate.sourceResolutionM, 0.1);
  const providerChunkLimit = Math.min(MAX_SOURCE_CHUNK_SIZE, resolved.provider.maxFetchDimension ?? MAX_SOURCE_CHUNK_SIZE);
  const sourceChunkSize = tileSize * Math.max(1, Math.floor(Math.max(tileSize, providerChunkLimit) / tileSize));
  const estimate = trackImageryOutputEstimate(bounds, resolutionM, tileSize, providerChunkLimit);
  return { bounds, resolved, resolutionM, sourceChunkSize, estimate };
}

export async function estimateOpenTrackImageryAsset(
  candidateId: string,
  boundsInput: TrackImageryGeographicBounds,
  location: TrackImageryLocation,
  tileSize = DEFAULT_TILE_SIZE,
  fetcher: Fetcher = fetch,
): Promise<{ candidate: TrackImageryCandidate; estimate: TrackImageryOutputEstimate }> {
  const plan = await resolveOpenTrackImageryAssetPlan(candidateId, boundsInput, location, tileSize, fetcher);
  return { candidate: plan.resolved.candidate, estimate: plan.estimate };
}

export async function loadOpenTrackImageryAsset(
  candidateId: string,
  boundsInput: TrackImageryGeographicBounds,
  location: TrackImageryLocation,
  tileSize = DEFAULT_TILE_SIZE,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  allowUnsafe = false,
): Promise<OpenTrackImageryAsset> {
  signal?.throwIfAborted();
  const { bounds, resolved, resolutionM, sourceChunkSize, estimate } = await resolveOpenTrackImageryAssetPlan(candidateId, boundsInput, location, tileSize, fetcher);
  const estimateProblems = outputEstimateProblems(estimate);
  if (estimateProblems.length > 0 && !allowUnsafe) throw new Error(`Unsafe imagery output: ${estimateProblems.join("; ")}`);
  const sourceChunkCount = estimate.sourceChunks;
  const tiles = (async function* (): AsyncIterable<OpenTrackImageryTile> {
    let sourceChunkIndex = 0;
    for (let sourceY = 0; sourceY < estimate.height; sourceY += sourceChunkSize) {
      for (let sourceX = 0; sourceX < estimate.width; sourceX += sourceChunkSize) {
        signal?.throwIfAborted();
        const sourceWidth = Math.min(sourceChunkSize, estimate.width - sourceX);
        const sourceHeight = Math.min(sourceChunkSize, estimate.height - sourceY);
        const sourceBounds = tileBounds(bounds, sourceX, sourceY, sourceWidth, sourceHeight, estimate.width, estimate.height);
        sourceChunkIndex += 1;
        let raw: Uint8Array;
        try {
          raw = await resolved.provider.fetch(resolved, sourceBounds, sourceWidth, sourceHeight, fetcher);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown provider error";
          throw new Error(`${resolved.provider.name} source chunk ${sourceChunkIndex}/${sourceChunkCount} failed: ${message}`, { cause: error });
        }
        signal?.throwIfAborted();
        const pixels = await normalizeOpaquePixels(raw, sourceWidth, sourceHeight);
        for (let offsetY = 0; offsetY < sourceHeight; offsetY += tileSize) {
          for (let offsetX = 0; offsetX < sourceWidth; offsetX += tileSize) {
            signal?.throwIfAborted();
            const width = Math.min(tileSize, sourceWidth - offsetX);
            const height = Math.min(tileSize, sourceHeight - offsetY);
            const data = new Uint8Array(await sharp(pixels.data, { raw: pixels }).extract({ left: offsetX, top: offsetY, width, height }).webp({ quality: 90, effort: 4 }).toBuffer());
            yield {
              tier: "hq",
              x: Math.floor((sourceX + offsetX) / tileSize),
              y: Math.floor((sourceY + offsetY) / tileSize),
              width,
              height,
              format: "webp",
              data,
            };
          }
        }
      }
    }
  })();
  const source = { ...candidateSource(resolved.candidate), storedResolutionM: resolutionM };
  return {
    source,
    candidate: resolved.candidate,
    bounds,
    width: estimate.width,
    height: estimate.height,
    tileSize,
    columns: estimate.columns,
    rows: estimate.rows,
    resolutionM,
    tiles,
    estimate,
  };
}
