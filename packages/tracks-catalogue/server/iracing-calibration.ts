import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { USER_TRACKS_DIR } from "@raceiq/shared/platform/runtime/data-paths";
import type { IRacingTrackCalibration } from "@raceiq/shared/racing/tracks/geometry/iracing-reference";
import { getLapSummariesByTrack } from "@raceiq/backend-core/db/lap-read-queries";
import { queryLapTelemetryBySemanticId } from "@raceiq/backend-core/telemetry/replay";
import type { IRacingSvgTrackMap } from "@raceiq/game-iracing/track-map-svg";

const SEMANTICS = ["motion.latitude", "motion.longitude", "motion.altitude", "identity.track.altitude", "timing.lap-fraction"] as const;
const DATA_ROOT = USER_TRACKS_DIR;
type Point = { x: number; z: number };
type GPS = Point & { fraction: number; altitude: number | null; timestampMs: number };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const calibrationSchema = z.object({
  source: z.literal("recorded-reference"),
  referenceLapId: z.number().int().positive(),
  geometryHash: z.string().regex(/^[\da-f]{64}$/),
  origin: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), altitude: z.number().finite() }).strict(),
  alignment: z.object({ scale: z.number().finite().min(0.1).max(10), cos: z.number().finite(), sin: z.number().finite(), tx: z.number().finite(), tz: z.number().finite(), flipX: z.boolean(), flipZ: z.boolean() }).strict(),
  elevationsM: z.array(z.number().finite()).nullable(),
  meanErrorM: z.number().finite().min(0).max(500),
}).strict();
const activeCalibrations = new Map<string, Promise<IRacingTrackCalibration | null>>();

export function iracingGeometryHash(trackId: string, map: IRacingSvgTrackMap, projectionPoints: readonly Point[]): string {
  const geometry = JSON.stringify({ trackId, points: map.points, ribbonEdges: map.ribbonEdges, projectionPoints, startFinishAligned: map.startFinishAligned, forwardDirectionKnown: map.forwardDirectionKnown });
  return createHash("sha256").update(geometry).digest("hex");
}

function artifactPath(trackId: string, hash: string, dataRoot = DATA_ROOT): string {
  return join(dataRoot, "iracing-calibrations", `${trackId}-${hash}.json`);
}

export function isValidIRacingTrackCalibration(value: unknown, hash: string, pointCount: number): value is IRacingTrackCalibration {
  const result = calibrationSchema.safeParse(value);
  if (!result.success) return false;
  const calibration = result.data;
  const { alignment, origin } = calibration;
  return calibration.geometryHash === hash && !(origin.latitude === 0 && origin.longitude === 0) &&
    Math.abs(alignment.cos ** 2 + alignment.sin ** 2 - 1) <= 1e-6 &&
    (calibration.meanErrorM <= 500) &&
    (calibration.elevationsM === null || calibration.elevationsM.length === pointCount);
}

function readCalibration(trackId: string, hash: string, pointCount: number, dataRoot = DATA_ROOT): IRacingTrackCalibration | null {
  const path = artifactPath(trackId, hash, dataRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isValidIRacingTrackCalibration(parsed, hash, pointCount) ? parsed : null;
  } catch {
    return null;
  }
}

export function usableIRacingTelemetryValue(frame: { values: readonly { semanticId: string; value: unknown; state?: string; freshness?: string }[] }, semanticId: string): unknown {
  const entry = frame.values.find((candidate) => candidate.semanticId === semanticId);
  if (!entry || (entry.state !== undefined && entry.state !== "ok") || (entry.freshness !== undefined && entry.freshness !== "fresh")) return null;
  return entry.value;
}

function timestampMilliseconds(timestamp: { domain: string; milliseconds?: number; nanoseconds?: bigint }): number {
  return timestamp.domain === "monotonic" ? Number(timestamp.nanoseconds ?? 0n) / 1_000_000 : timestamp.milliseconds ?? Number.NaN;
}

function cumulativeDistances(points: readonly Point[]): number[] {
  const distances = new Array<number>(points.length);
  distances[0] = 0;
  for (let index = 1; index < points.length; index++) {
    distances[index] = distances[index - 1]! + Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.z - points[index - 1]!.z);
  }
  return distances;
}

function pointAtFraction(points: readonly Point[], distances: readonly number[], fraction: number): Point {
  const target = Math.max(0, Math.min(1, fraction)) * distances[distances.length - 1]!;
  let index = 1;
  while (index < distances.length - 1 && distances[index]! < target) index++;
  const span = distances[index]! - distances[index - 1]!;
  const amount = span > 0 ? (target - distances[index - 1]!) / span : 0;
  const start = points[index - 1]!, end = points[index]!;
  return { x: start.x + (end.x - start.x) * amount, z: start.z + (end.z - start.z) * amount };
}

export function fitIRacingSimilarity(source: readonly Point[], target: readonly Point[], flipX: boolean, flipZ: boolean) {
  if (source.length < 2 || source.length !== target.length) return null;
  const count = source.length;
  let sourceX = 0, sourceZ = 0, targetX = 0, targetZ = 0;
  for (let index = 0; index < count; index++) {
    sourceX += flipX ? -source[index]!.x : source[index]!.x;
    sourceZ += flipZ ? -source[index]!.z : source[index]!.z;
    targetX += target[index]!.x; targetZ += target[index]!.z;
  }
  sourceX /= count; sourceZ /= count; targetX /= count; targetZ /= count;
  let real = 0, imaginary = 0, denominator = 0;
  for (let index = 0; index < count; index++) {
    const x = (flipX ? -source[index]!.x : source[index]!.x) - sourceX;
    const z = (flipZ ? -source[index]!.z : source[index]!.z) - sourceZ;
    const u = target[index]!.x - targetX, v = target[index]!.z - targetZ;
    real += x * u + z * v; imaginary += x * v - z * u; denominator += x * x + z * z;
  }
  if (denominator <= 0) return null;
  const angle = Math.atan2(imaginary, real), cos = Math.cos(angle), sin = Math.sin(angle), scale = Math.hypot(real, imaginary) / denominator;
  const tx = targetX - scale * (cos * sourceX - sin * sourceZ);
  const tz = targetZ - scale * (sin * sourceX + cos * sourceZ);
  let squaredError = 0;
  for (let index = 0; index < count; index++) {
    const x = flipX ? -source[index]!.x : source[index]!.x;
    const z = flipZ ? -source[index]!.z : source[index]!.z;
    squaredError += (scale * (cos * x - sin * z) + tx - target[index]!.x) ** 2 + (scale * (sin * x + cos * z) + tz - target[index]!.z) ** 2;
  }
  return { scale, cos, sin, tx, tz, flipX, flipZ, error: Math.sqrt(squaredError / count) };
}

async function calibrateFromLap(trackId: string, hash: string, projectionPoints: readonly Point[]): Promise<IRacingTrackCalibration | null> {
  const summaries = await getLapSummariesByTrack(trackId, "iracing");
  const candidates = summaries.filter((lap) => lap.processing.state === "ready" && lap.isValid).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.lapId - b.lapId);
  for (const lap of candidates) {
    try {
      const replay = await queryLapTelemetryBySemanticId(lap.lapId, SEMANTICS, { rawCaptureRequirement: "native-values" });
      if (!replay || replay.envelopes.length < 50) continue;
      const firstFrame = replay.envelopes[0]!;
      const initialLatitude = usableIRacingTelemetryValue(firstFrame, "motion.latitude"), initialLongitude = usableIRacingTelemetryValue(firstFrame, "motion.longitude");
      if (initialLatitude === 0 && initialLongitude === 0) continue;
      const gps: GPS[] = [];
      for (const frame of replay.envelopes) {
        const latitude = usableIRacingTelemetryValue(frame, "motion.latitude"), longitude = usableIRacingTelemetryValue(frame, "motion.longitude");
        const fraction = usableIRacingTelemetryValue(frame, "timing.lap-fraction"), altitude = usableIRacingTelemetryValue(frame, "motion.altitude");
        const timestampMs = timestampMilliseconds(frame.observedAt);
        if (finite(latitude) && finite(longitude) && finite(fraction) && finite(timestampMs) && !(latitude === 0 && longitude === 0) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 && fraction >= 0 && fraction <= 1) {
          gps.push({ x: longitude, z: latitude, fraction, altitude: finite(altitude) ? altitude : null, timestampMs });
        }
      }
      if (gps.length < 50 || gps[0]!.fraction > 0.01 || gps[gps.length - 1]!.fraction < 0.99) continue;
      let completeCoverage = true;
      for (let index = 1; index < gps.length; index++) {
        const previous = gps[index - 1]!, current = gps[index]!;
        if (current.fraction < previous.fraction || current.timestampMs < previous.timestampMs || current.fraction - previous.fraction > 0.01 || current.timestampMs - previous.timestampMs > 2_000) {
          completeCoverage = false;
          break;
        }
      }
      if (!completeCoverage) continue;
      const first = gps[0]!, trackAltitude = usableIRacingTelemetryValue(firstFrame, "identity.track.altitude");
      if (first.altitude === null && !finite(trackAltitude)) continue;
      const originAltitude = first.altitude ?? trackAltitude as number;
      const origin = { latitude: first.z, longitude: first.x, altitude: originAltitude };
      const radians = Math.PI / 180, earthRadiusM = 6_378_137;
      const target = gps.map((row) => ({
        x: (row.x - origin.longitude) * radians * earthRadiusM * Math.cos(origin.latitude * radians),
        z: (row.z - origin.latitude) * radians * earthRadiusM,
      }));
      const projectionDistances = cumulativeDistances(projectionPoints);
      const projectionLength = projectionDistances[projectionDistances.length - 1]!;
      if (!finite(projectionLength) || projectionLength <= 0) continue;
      const source = gps.map((row) => pointAtFraction(projectionPoints, projectionDistances, row.fraction));
      const candidates = [
        fitIRacingSimilarity(source, target, false, false), fitIRacingSimilarity(source, target, false, true),
        fitIRacingSimilarity(source, target, true, false), fitIRacingSimilarity(source, target, true, true),
      ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null).sort((a, b) => a.error - b.error);
      const best = candidates[0];
      if (!best || !finite(best.scale) || best.scale < 0.1 || best.scale > 10 || !finite(best.error) || best.error > 500) continue;
      const elevations: number[] = [];
      let hasAltitude = true;
      for (let index = 0; index < projectionPoints.length; index++) {
        const fraction = projectionDistances[index]! / projectionLength;
        let nearest: GPS | null = null;
        for (const row of gps) if (nearest === null || Math.abs(row.fraction - fraction) < Math.abs(nearest.fraction - fraction)) nearest = row;
        if (!nearest || nearest.altitude === null) { hasAltitude = false; break; }
        elevations.push(nearest.altitude - originAltitude);
      }
      return {
        source: "recorded-reference", referenceLapId: lap.lapId, geometryHash: hash, origin,
        alignment: { scale: best.scale, cos: best.cos, sin: best.sin, tx: best.tx, tz: best.tz, flipX: best.flipX, flipZ: best.flipZ },
        elevationsM: hasAltitude ? elevations : null, meanErrorM: best.error,
      };
    } catch {
      // A broken source must not make outline or replay unavailable.
    }
  }
  return null;
}

export function readPersistedIRacingCalibration(trackId: string, hash: string, pointCount: number, dataRoot = DATA_ROOT): IRacingTrackCalibration | null {
  return readCalibration(trackId, hash, pointCount, dataRoot);
}

export function persistIRacingCalibration(trackId: string, calibration: IRacingTrackCalibration, pointCount: number, dataRoot = DATA_ROOT): IRacingTrackCalibration | null {
  if (!isValidIRacingTrackCalibration(calibration, calibration.geometryHash, pointCount)) return null;
  const directory = join(dataRoot, "iracing-calibrations");
  const path = artifactPath(trackId, calibration.geometryHash, dataRoot), temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, JSON.stringify(calibration), { flag: "wx" });
    try {
      linkSync(temporary, path);
    } catch {
      const existing = readCalibration(trackId, calibration.geometryHash, pointCount, dataRoot);
      if (!existing) return null;
      return existing;
    }
    return readCalibration(trackId, calibration.geometryHash, pointCount, dataRoot);
  } catch {
    return null;
  } finally {
    try { unlinkSync(temporary); } catch { /* The temporary artifact was never created or is already gone. */ }
  }
}

async function resolveCalibration(trackId: string, map: IRacingSvgTrackMap, projectionPoints: readonly Point[]): Promise<IRacingTrackCalibration | null> {
  const hash = iracingGeometryHash(trackId, map, projectionPoints);
  const stored = readCalibration(trackId, hash, projectionPoints.length);
  if (stored) return stored;
  const calibration = await calibrateFromLap(trackId, hash, projectionPoints);
  return calibration ? persistIRacingCalibration(trackId, calibration, projectionPoints.length) : null;
}

export function getIRacingTrackCalibration(trackId: string, map: IRacingSvgTrackMap, projectionPoints: readonly Point[]): Promise<IRacingTrackCalibration | null> {
  const hash = iracingGeometryHash(trackId, map, projectionPoints);
  const key = artifactPath(trackId, hash);
  const active = activeCalibrations.get(key);
  if (active) return active;
  const pending = resolveCalibration(trackId, map, projectionPoints);
  activeCalibrations.set(key, pending);
  void pending.then(
    () => { if (activeCalibrations.get(key) === pending) activeCalibrations.delete(key); },
    () => { if (activeCalibrations.get(key) === pending) activeCalibrations.delete(key); },
  );
  return pending;
}
