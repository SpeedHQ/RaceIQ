import { z } from "zod";
import { GameIdSchema } from "../../games/ids";
import { TrackVenueIdSchema } from "./configuration";

export const TRACK_IMAGERY_MANIFEST_VERSION = 2 as const;
export const TRACK_IMAGERY_PACKAGE_NAME = "imagery.rqi" as const;
export const TrackImageryQualitySchema = z.enum(["hq", "context"]);
export const TrackImageryCoverageSchema = z.enum(["full", "partial", "unknown"]);
export const TrackImageryGeographicReliabilitySchema = z.enum(["authoritative", "community", "satellite"]);
export const TrackImageryProviderStabilitySchema = z.enum(["authoritative", "stable", "opportunistic"]);
export const TrackImageryRedistributionSchema = z.literal("allowed");

const finiteNumber = z.number().finite();
const safeId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and hyphens");
const imageFileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpe?g|webp)$/i, "Image must be PNG, JPEG, or WebP");
const imageSourceSchema = z.object({
  name: z.string().trim().min(1),
  provider: z.string().trim().min(1).optional(),
  url: z.string().trim().optional(),
  capturedAt: z.string().trim().optional(),
  license: z.string().trim().min(1),
  attribution: z.string().trim(),
  quality: TrackImageryQualitySchema.optional(),
  coverage: TrackImageryCoverageSchema.optional(),
  geographicReliability: TrackImageryGeographicReliabilitySchema.optional(),
  cloudCoverPercent: finiteNumber.min(0).max(100).optional(),
  providerStability: TrackImageryProviderStabilitySchema.optional(),
  redistribution: TrackImageryRedistributionSchema.optional(),
  resolutionM: finiteNumber.positive().optional(),
  sourceResolutionM: finiteNumber.positive().optional(),
  storedResolutionM: finiteNumber.positive().optional(),
});
const textureSchema = z.object({
  image: imageFileName,
  opacity: finiteNumber.min(0).max(1),
  source: imageSourceSchema,
});

export const TrackImageryGeographicPointSchema = z.object({
  latitudeDeg: finiteNumber.min(-90).max(90),
  longitudeDeg: finiteNumber.min(-180).max(180),
});

export const TrackImageryGeographicBoundsSchema = z
  .object({
    west: finiteNumber.min(-180).max(180),
    south: finiteNumber.min(-90).max(90),
    east: finiteNumber.min(-180).max(180),
    north: finiteNumber.min(-90).max(90),
  })
  .refine((bounds) => bounds.east > bounds.west && bounds.north > bounds.south, "Imagery bounds must have positive width and height");

export const TrackImageryCalibrationSchema = z.object({
  originLatitudeDeg: finiteNumber.min(-90).max(90),
  originLongitudeDeg: finiteNumber.min(-180).max(180),
  /** Canvas-style affine transform from normalized image U/V to local east/north metres. */
  imageToEnu: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber, finiteNumber, finiteNumber]),
});

export const TrackImageryCandidateSchema = z.object({
  id: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  quality: TrackImageryQualitySchema,
  coverage: TrackImageryCoverageSchema,
  title: z.string().trim().min(1),
  capturedAt: z.string().trim().optional(),
  sourceResolutionM: finiteNumber.positive(),
  geographicReliability: TrackImageryGeographicReliabilitySchema,
  cloudCoverPercent: finiteNumber.min(0).max(100).optional(),
  providerStability: TrackImageryProviderStabilitySchema,
  redistribution: TrackImageryRedistributionSchema,
  license: z.string().trim().min(1),
  attribution: z.string().trim().min(1),
  sourceUrl: z.string().url(),
});
const imageryOutputCount = z.number().int().nonnegative();
export const TrackImageryOutputEstimateSchema = z.object({
  width: imageryOutputCount.positive(),
  height: imageryOutputCount.positive(),
  totalPixels: imageryOutputCount.positive(),
  tileSize: imageryOutputCount.positive(),
  columns: imageryOutputCount.positive(),
  rows: imageryOutputCount.positive(),
  totalTiles: imageryOutputCount.positive(),
  sourceChunks: imageryOutputCount.positive(),
  resolutionM: finiteNumber.positive(),
  estimatedUncompressedBytes: imageryOutputCount.positive(),
  estimatedPackBytes: z.object({ minimum: imageryOutputCount.positive(), maximum: imageryOutputCount.positive() }),
  estimatedJobDurationMs: imageryOutputCount.positive(),
});
export const TrackImageryOutputBudgetSchema = TrackImageryOutputEstimateSchema.extend({
  availableDiskBytes: imageryOutputCount.nullable(),
  requiredDiskBytes: imageryOutputCount.positive(),
  maximumJobDurationMs: imageryOutputCount.positive(),
  maximumConcurrency: imageryOutputCount.positive(),
  safe: z.boolean(),
  overrideActive: z.boolean(),
  problems: z.array(z.string().min(1)),
});
export const TrackImageryOutputBudgetResultSchema = z.object({
  candidate: TrackImageryCandidateSchema,
  budget: TrackImageryOutputBudgetSchema,
});
export const TrackImageryGeographicReferenceSchema = z.object({
  sourceGameId: z.literal("iracing"),
  sourceTrackOrdinal: z.number().int().nonnegative(),
  sourceName: z.string().trim().min(1),
  match: z.enum(["game-id", "assigned-identity", "shared-name"]),
  outlineSource: z.enum(["shared", "official-svg", "generated", "bundled", "recorded", "estimated"]),
  center: TrackImageryGeographicPointSchema,
  geographicPositions: z.array(TrackImageryGeographicPointSchema).min(4),
});

const baseSourceSchema = imageSourceSchema.extend({ provider: z.string().trim().min(1) }).superRefine((source, context) => {
  if (source.provider === "manual" && source.sourceResolutionM === undefined && source.storedResolutionM === undefined) return;
  if (source.sourceResolutionM === undefined || source.storedResolutionM === undefined) {
    context.addIssue({ code: "custom", message: "Packed source requires source and stored resolution" });
    return;
  }
  if (source.storedResolutionM < Math.max(source.sourceResolutionM, 0.1)) {
    context.addIssue({ code: "custom", message: "Stored imagery resolution must not upscale its source or exceed the 0.10 m/pixel detail target" });
  }
});

export const TrackImageryVenueManifestSchema = z.object({
  version: z.literal(TRACK_IMAGERY_MANIFEST_VERSION),
  venueId: TrackVenueIdSchema,
  calibration: TrackImageryCalibrationSchema,
  base: z.object({
    pack: z.literal(TRACK_IMAGERY_PACKAGE_NAME),
    tileSize: z.number().int().positive(),
    bounds: TrackImageryGeographicBoundsSchema,
    source: baseSourceSchema,
  }),
  layers: z.array(
    textureSchema.extend({
      id: safeId,
      kind: z.enum(["game", "layout", "correction"]),
    }),
  ),
});

export const TrackImageryLayoutManifestSchema = z.object({
  version: z.literal(TRACK_IMAGERY_MANIFEST_VERSION),
  gameId: GameIdSchema,
  trackOrdinal: z.number().int().nonnegative(),
  layers: z.array(safeId),
});

export type TrackImageryVenueManifest = z.infer<typeof TrackImageryVenueManifestSchema>;
export type TrackImageryLayoutManifest = z.infer<typeof TrackImageryLayoutManifestSchema>;
export type TrackImageryGeographicBounds = z.infer<typeof TrackImageryGeographicBoundsSchema>;
export type TrackImageryCandidate = z.infer<typeof TrackImageryCandidateSchema>;
export type TrackImageryGeographicReference = z.infer<typeof TrackImageryGeographicReferenceSchema>;
export interface TrackImagerySourceSearchGroup {
  id: string;
  name: string;
  candidates: TrackImageryCandidate[];
}
export interface TrackImagerySourceSearchResult {
  sources: TrackImagerySourceSearchGroup[];
  notices: string[];
}
export type TrackImageryOutputEstimate = z.infer<typeof TrackImageryOutputEstimateSchema>;
export type TrackImageryOutputBudget = z.infer<typeof TrackImageryOutputBudgetSchema>;
export type TrackImageryOutputBudgetResult = z.infer<typeof TrackImageryOutputBudgetResultSchema>;
export interface TrackImageryConfigurationIndex {
  venues: TrackImageryVenueManifest[];
  layouts: TrackImageryLayoutManifest[];
}
export type TrackImageryCalibration = TrackImageryVenueManifest["calibration"];
export type TrackImageryMatrix = TrackImageryCalibration["imageToEnu"];
export type TrackImagerySource = z.infer<typeof imageSourceSchema>;
export type TrackImageryLayerKind = TrackImageryVenueManifest["layers"][number]["kind"];

export interface TrackImageryTexture {
  id: string;
  kind: TrackImageryLayerKind;
  url: string;
  opacity: number;
  source: TrackImagerySource;
}

export interface TrackImageryBase {
  tier: "hq";
  width: number;
  height: number;
  tileSize: number;
  columns: number;
  rows: number;
  bounds: TrackImageryGeographicBounds;
  contentHash: string;
  resolutionM?: number;
  source: TrackImagerySource;
  tileUrlTemplate: string;
}

export interface TrackImagery {
  version: typeof TRACK_IMAGERY_MANIFEST_VERSION;
  venueId: string;
  calibration: TrackImageryCalibration;
  base: TrackImageryBase;
  textures: TrackImageryTexture[];
}

export interface TrackImageryPoint {
  x: number;
  z: number;
}

export type TrackImageryGeographicPoint = z.infer<typeof TrackImageryGeographicPointSchema>;

const EARTH_RADIUS_M = 6_378_137;

function finitePoint(point: TrackImageryPoint | undefined): point is TrackImageryPoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.z);
}

function finiteGeographicPoint(point: TrackImageryGeographicPoint | null | undefined): point is TrackImageryGeographicPoint {
  return !!point && Number.isFinite(point.latitudeDeg) && Number.isFinite(point.longitudeDeg) && Math.abs(point.latitudeDeg) <= 90 && Math.abs(point.longitudeDeg) <= 180;
}

function toEnu(point: TrackImageryGeographicPoint, originLatitudeDeg: number, originLongitudeDeg: number): TrackImageryPoint {
  const latitudeRad = (originLatitudeDeg * Math.PI) / 180;
  return {
    x: (((point.longitudeDeg - originLongitudeDeg) * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(latitudeRad),
    z: (((point.latitudeDeg - originLatitudeDeg) * Math.PI) / 180) * EARTH_RADIUS_M,
  };
}
export function geographicTrackImageryPoint(point: TrackImageryGeographicPoint, calibration: TrackImageryCalibration): TrackImageryPoint {
  return toEnu(point, calibration.originLatitudeDeg, calibration.originLongitudeDeg);
}
export function geographicTrackImageryPointFromEnu(point: TrackImageryPoint, originLatitudeDeg: number, originLongitudeDeg: number): TrackImageryGeographicPoint {
  const latitudeRad = (originLatitudeDeg * Math.PI) / 180;
  return {
    latitudeDeg: originLatitudeDeg + ((point.z / EARTH_RADIUS_M) * 180) / Math.PI,
    longitudeDeg: originLongitudeDeg + ((point.x / (EARTH_RADIUS_M * Math.cos(latitudeRad))) * 180) / Math.PI,
  };
}
const DEFAULT_TRACK_IMAGERY_PADDING_FRACTION = 0.5;

/** Include broad surrounding context because catalog outlines have no geographic heading and must be rotated into place. */
export function trackImageryGeographicBounds(
  geographic: readonly (TrackImageryGeographicPoint | null)[],
  paddingFraction = DEFAULT_TRACK_IMAGERY_PADDING_FRACTION,
): TrackImageryGeographicBounds | null {
  const valid = geographic.filter(finiteGeographicPoint);
  if (valid.length < 2) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const point of valid) {
    west = Math.min(west, point.longitudeDeg);
    south = Math.min(south, point.latitudeDeg);
    east = Math.max(east, point.longitudeDeg);
    north = Math.max(north, point.latitudeDeg);
  }
  const safePadding = Number.isFinite(paddingFraction) ? Math.max(0, paddingFraction) : DEFAULT_TRACK_IMAGERY_PADDING_FRACTION;
  const longitudePadding = Math.max((east - west) * safePadding, 0.000_01);
  const latitudePadding = Math.max((north - south) * safePadding, 0.000_01);
  return TrackImageryGeographicBoundsSchema.parse({
    west: Math.max(-180, west - longitudePadding),
    south: Math.max(-90, south - latitudePadding),
    east: Math.min(180, east + longitudePadding),
    north: Math.min(90, north + latitudePadding),
  });
}

/** Create an exact north-up calibration for an API image exported to geographic bounds. */
export function trackImageryCalibrationFromBounds(geographic: readonly (TrackImageryGeographicPoint | null)[], bounds: TrackImageryGeographicBounds): TrackImageryCalibration | null {
  const valid = geographic.filter(finiteGeographicPoint);
  if (valid.length < 2 || !TrackImageryGeographicBoundsSchema.safeParse(bounds).success) return null;
  const originLatitudeDeg = valid.reduce((sum, point) => sum + point.latitudeDeg, 0) / valid.length;
  const originLongitudeDeg = valid.reduce((sum, point) => sum + point.longitudeDeg, 0) / valid.length;
  const northWest = toEnu({ latitudeDeg: bounds.north, longitudeDeg: bounds.west }, originLatitudeDeg, originLongitudeDeg);
  const northEast = toEnu({ latitudeDeg: bounds.north, longitudeDeg: bounds.east }, originLatitudeDeg, originLongitudeDeg);
  const southWest = toEnu({ latitudeDeg: bounds.south, longitudeDeg: bounds.west }, originLatitudeDeg, originLongitudeDeg);
  return {
    originLatitudeDeg,
    originLongitudeDeg,
    imageToEnu: [northEast.x - northWest.x, northEast.z - northWest.z, southWest.x - northWest.x, southWest.z - northWest.z, northWest.x, northWest.z],
  };
}

/** Create a north-up venue footprint covering one GPS path. */
export function defaultVenueImageryCalibration(geographic: readonly (TrackImageryGeographicPoint | null)[], imageAspectRatio: number): TrackImageryCalibration | null {
  const valid = geographic.filter(finiteGeographicPoint);
  if (valid.length < 2) return null;
  const originLatitudeDeg = valid.reduce((sum, point) => sum + point.latitudeDeg, 0) / valid.length;
  const originLongitudeDeg = valid.reduce((sum, point) => sum + point.longitudeDeg, 0) / valid.length;
  const enu = valid.map((point) => toEnu(point, originLatitudeDeg, originLongitudeDeg));
  let minEast = Infinity;
  let maxEast = -Infinity;
  let minNorth = Infinity;
  let maxNorth = -Infinity;
  for (const point of enu) {
    minEast = Math.min(minEast, point.x);
    maxEast = Math.max(maxEast, point.x);
    minNorth = Math.min(minNorth, point.z);
    maxNorth = Math.max(maxNorth, point.z);
  }
  const aspectRatio = Number.isFinite(imageAspectRatio) && imageAspectRatio > 0 ? imageAspectRatio : 1;
  let width = Math.max(1, (maxEast - minEast) * 1.2);
  let height = Math.max(1, (maxNorth - minNorth) * 1.2);
  if (width / height < aspectRatio) width = height * aspectRatio;
  else height = width / aspectRatio;
  const centerEast = (minEast + maxEast) / 2;
  const centerNorth = (minNorth + maxNorth) / 2;
  return {
    originLatitudeDeg,
    originLongitudeDeg,
    imageToEnu: [width, 0, 0, -height, centerEast - width / 2, centerNorth + height / 2],
  };
}

function fitEnuToTrack(local: readonly TrackImageryPoint[], geographic: readonly (TrackImageryGeographicPoint | null)[], calibration: TrackImageryCalibration): TrackImageryMatrix | null {
  const count = Math.min(local.length, geographic.length);
  const pairs: Array<{ source: TrackImageryPoint; target: TrackImageryPoint }> = [];
  const stride = Math.max(1, Math.floor(count / 500));
  for (let index = 0; index < count; index += stride) {
    const target = local[index];
    const geo = geographic[index];
    if (!finitePoint(target) || !finiteGeographicPoint(geo)) continue;
    pairs.push({ source: toEnu(geo, calibration.originLatitudeDeg, calibration.originLongitudeDeg), target });
  }
  if (pairs.length < 3) return null;

  let best: { matrix: TrackImageryMatrix; error: number } | null = null;
  for (const flipEast of [1, -1]) {
    for (const flipNorth of [1, -1]) {
      let sourceX = 0;
      let sourceZ = 0;
      let targetX = 0;
      let targetZ = 0;
      for (const pair of pairs) {
        sourceX += flipEast * pair.source.x;
        sourceZ += flipNorth * pair.source.z;
        targetX += pair.target.x;
        targetZ += pair.target.z;
      }
      sourceX /= pairs.length;
      sourceZ /= pairs.length;
      targetX /= pairs.length;
      targetZ /= pairs.length;
      let cross = 0;
      let dot = 0;
      let sourceNorm = 0;
      let targetNorm = 0;
      for (const pair of pairs) {
        const sx = flipEast * pair.source.x - sourceX;
        const sz = flipNorth * pair.source.z - sourceZ;
        const tx = pair.target.x - targetX;
        const tz = pair.target.z - targetZ;
        cross += sx * tz - sz * tx;
        dot += sx * tx + sz * tz;
        sourceNorm += sx * sx + sz * sz;
        targetNorm += tx * tx + tz * tz;
      }
      if (sourceNorm <= 0 || targetNorm <= 0) continue;
      const rotation = Math.atan2(cross, dot);
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const scale = Math.sqrt(targetNorm / sourceNorm);
      const a = scale * cos * flipEast;
      const b = scale * sin * flipEast;
      const c = -scale * sin * flipNorth;
      const d = scale * cos * flipNorth;
      const e = targetX - (a * sourceX) / flipEast - (c * sourceZ) / flipNorth;
      const f = targetZ - (b * sourceX) / flipEast - (d * sourceZ) / flipNorth;
      const matrix: TrackImageryMatrix = [a, b, c, d, e, f];
      let error = 0;
      for (const pair of pairs) {
        const mapped = transformTrackImageryPoint(matrix, pair.source.x, pair.source.z);
        error += (mapped.x - pair.target.x) ** 2 + (mapped.z - pair.target.z) ** 2;
      }
      if (!best || error < best.error) best = { matrix, error };
    }
  }
  return best?.matrix ?? null;
}

export function composeTrackImageryMatrices(outer: TrackImageryMatrix, inner: TrackImageryMatrix): TrackImageryMatrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/** Resolve shared venue imagery into current game's local X/Z coordinates. */
export function resolveTrackImageryMatrix(
  local: readonly TrackImageryPoint[],
  geographic: readonly (TrackImageryGeographicPoint | null)[],
  calibration: TrackImageryCalibration,
): TrackImageryMatrix | null {
  const enuToTrack = fitEnuToTrack(local, geographic, calibration);
  return enuToTrack ? composeTrackImageryMatrices(enuToTrack, calibration.imageToEnu) : null;
}

export function transformTrackImageryPoint(matrix: TrackImageryMatrix, u: number, v: number): TrackImageryPoint {
  return { x: matrix[0] * u + matrix[2] * v + matrix[4], z: matrix[1] * u + matrix[3] * v + matrix[5] };
}

export function translateTrackImageryMatrix(matrix: TrackImageryMatrix, x: number, z: number): TrackImageryMatrix {
  return [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4] + x, matrix[5] + z];
}

export function scaleTrackImageryMatrix(matrix: TrackImageryMatrix, factor: number): TrackImageryMatrix {
  const center = transformTrackImageryPoint(matrix, 0.5, 0.5);
  const a = matrix[0] * factor;
  const b = matrix[1] * factor;
  const c = matrix[2] * factor;
  const d = matrix[3] * factor;
  return [a, b, c, d, center.x - (a + c) / 2, center.z - (b + d) / 2];
}

export function rotateTrackImageryMatrix(matrix: TrackImageryMatrix, radians: number): TrackImageryMatrix {
  const center = transformTrackImageryPoint(matrix, 0.5, 0.5);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = cos * matrix[0] - sin * matrix[1];
  const b = sin * matrix[0] + cos * matrix[1];
  const c = cos * matrix[2] - sin * matrix[3];
  const d = sin * matrix[2] + cos * matrix[3];
  return [a, b, c, d, center.x - (a + c) / 2, center.z - (b + d) / 2];
}
