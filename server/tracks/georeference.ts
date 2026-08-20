import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import {
  applyAlignment,
  computeAlignment,
  trackAlignmentRmse,
  type TrackAlignment,
} from "../../shared/racing/tracks/geometry/points";
import type { Point } from "../../shared/racing/tracks/geometry/types";
import {
  getGeoreferenceReference,
  getLatestGeoreferenceReference,
  getGeoreferenceTransform,
  saveGeoreferenceReference,
  saveGeoreferenceTransform,
  type GeodeticReferencePoint,
} from "../db/georeference-queries";
import { getLapById } from "../db/lap-read-queries";
import { getLapsForSession } from "../db/lap-reprocessing-queries";
import { getServerGame } from "../games/registry";

const EARTH_RADIUS_M = 6_378_137;
const MIN_SAMPLES = 20;
const MAX_REFERENCE_SAMPLES = 512;
const MIN_SPAN_M = 100;
const MAX_RMSE_M = 25;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

type LocalPoint = { x: number; z: number };
type EastNorthPoint = { east: number; north: number };

export interface GeographicPosition {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
}

export interface GeoreferenceMetadata {
  kind: "native" | "derived";
  sourceIdentity: string;
  canonicalSlug: string | null;
  quality: {
    score: number;
    rmseM: number;
    sampleCount: number;
  };
}

export interface LapGeoreference {
  positions: readonly (GeographicPosition | null)[];
  metadata: GeoreferenceMetadata;
}

interface Transform {
  scale: number;
  rotation: number;
  flipX: boolean;
  flipZ: boolean;
  translationEastM: number;
  translationNorthM: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nativePosition(packet: TelemetryPacket): GeographicPosition | null {
  const geo = packet.iracing as
    | (NonNullable<TelemetryPacket["iracing"]> & {
        latitudeDeg?: number;
        longitudeDeg?: number;
        altitudeM?: number;
      })
    | undefined;
  if (
    !geo ||
    !finite(geo.latitudeDeg) ||
    !finite(geo.longitudeDeg) ||
    !finite(geo.altitudeM)
  )
    return null;
  if (
    geo.latitudeDeg < -90 ||
    geo.latitudeDeg > 90 ||
    geo.longitudeDeg < -180 ||
    geo.longitudeDeg > 180
  )
    return null;
  return {
    latitudeDeg: geo.latitudeDeg,
    longitudeDeg: geo.longitudeDeg,
    altitudeM: geo.altitudeM,
  };
}

function sourceIdentity(trackOrdinal: number): string {
  return `iracing-track:${trackOrdinal}`;
}

function referenceVersion(path: readonly GeodeticReferencePoint[]): string {
  return createHash("sha256")
    .update(JSON.stringify(path))
    .digest("hex")
    .slice(0, 32);
}

function toEnu(
  point: GeodeticReferencePoint,
  origin: GeodeticReferencePoint,
): EastNorthPoint {
  const lat0 = (origin.latitudeDeg * Math.PI) / 180;
  return {
    east:
      (((point.longitudeDeg - origin.longitudeDeg) * Math.PI) / 180) *
      EARTH_RADIUS_M *
      Math.cos(lat0),
    north:
      (((point.latitudeDeg - origin.latitudeDeg) * Math.PI) / 180) *
      EARTH_RADIUS_M,
  };
}

function resampleByArc<T>(
  points: readonly T[],
  count: number,
  distance: (a: T, b: T) => number,
  interpolate: (a: T, b: T, fraction: number) => T,
): T[] {
  if (count <= 0 || points.length === 0) return [];
  if (points.length === 1)
    return Array.from({ length: count }, () => points[0]!);
  const cumulative = new Array<number>(points.length).fill(0);
  for (let index = 1; index < points.length; index++) {
    cumulative[index] =
      cumulative[index - 1]! +
      Math.max(0, distance(points[index - 1]!, points[index]!));
  }
  const total = cumulative[cumulative.length - 1]!;
  if (total <= 0) {
    return Array.from({ length: count }, (_, index) => {
      const position =
        count <= 1 ? 0 : (index * (points.length - 1)) / (count - 1);
      const before = Math.floor(position);
      const after = Math.min(points.length - 1, before + 1);
      return interpolate(points[before]!, points[after]!, position - before);
    });
  }
  return Array.from({ length: count }, (_, index) => {
    const target = count <= 1 ? 0 : (index * total) / (count - 1);
    let after = 1;
    while (after < cumulative.length - 1 && cumulative[after]! < target)
      after++;
    const before = after - 1;
    const span = cumulative[after]! - cumulative[before]!;
    return interpolate(
      points[before]!,
      points[after]!,
      span > 0 ? (target - cumulative[before]!) / span : 0,
    );
  });
}

function arcFractions<T>(
  points: readonly T[],
  distance: (a: T, b: T) => number,
): number[] {
  const cumulative = new Array<number>(points.length).fill(0);
  for (let index = 1; index < points.length; index++) {
    cumulative[index] =
      cumulative[index - 1]! +
      Math.max(0, distance(points[index - 1]!, points[index]!));
  }
  const total = cumulative[cumulative.length - 1]!;
  return total > 0
    ? cumulative.map((value) => value / total)
    : cumulative.map((_, index) =>
        points.length <= 1 ? 0 : index / (points.length - 1),
      );
}

function interpolateAtFraction<T>(
  points: readonly T[],
  fractions: readonly number[],
  fraction: number,
  interpolate: (a: T, b: T, fraction: number) => T,
): T {
  if (points.length === 1) return points[0]!;
  let after = 1;
  while (after < fractions.length - 1 && fractions[after]! < fraction) after++;
  const before = after - 1;
  const span = fractions[after]! - fractions[before]!;
  return interpolate(
    points[before]!,
    points[after]!,
    span > 0 ? (fraction - fractions[before]!) / span : 0,
  );
}

function toTrackAlignment(transform: Transform): TrackAlignment {
  return {
    scale: transform.scale,
    cos: Math.cos(transform.rotation),
    sin: Math.sin(transform.rotation),
    tx: transform.translationEastM,
    tz: transform.translationNorthM,
    flipX: transform.flipX,
    flipZ: transform.flipZ,
  };
}

function applyTransform(
  point: LocalPoint,
  transform: Transform,
): EastNorthPoint {
  const mapped = applyAlignment(point, toTrackAlignment(transform));
  return { east: mapped.x, north: mapped.z };
}

function hasMinimumSpan(points: readonly Point[]): boolean {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  return maxX - minX >= MIN_SPAN_M || maxZ - minZ >= MIN_SPAN_M;
}


function quality(rmseM: number): number {
  return Math.max(0, Math.min(1, 1 - rmseM / MAX_RMSE_M));
}

function geographyFromTransform(
  points: readonly LocalPoint[],
  referencePath: readonly GeodeticReferencePoint[],
  origin: GeodeticReferencePoint,
  transform: Transform,
): (GeographicPosition | null)[] {
  const localFractions = arcFractions(points, (a, b) =>
    Math.hypot(b.x - a.x, b.z - a.z),
  );
  const referenceFractions = arcFractions(referencePath, (a, b) => {
    const first = toEnu(a, origin);
    const second = toEnu(b, origin);
    return Math.hypot(second.east - first.east, second.north - first.north);
  });
  const refs = localFractions.map((fraction) =>
    interpolateAtFraction(
      referencePath,
      referenceFractions,
      fraction,
      (a, b, f) => ({
        latitudeDeg: a.latitudeDeg + (b.latitudeDeg - a.latitudeDeg) * f,
        longitudeDeg: a.longitudeDeg + (b.longitudeDeg - a.longitudeDeg) * f,
        altitudeM: a.altitudeM + (b.altitudeM - a.altitudeM) * f,
      }),
    ),
  );
  const cosLat = Math.cos((origin.latitudeDeg * Math.PI) / 180);
  return points.map((point, index) => {
    const mapped = applyTransform(point, transform);
    const ref = refs[index]!;
    return {
      latitudeDeg:
        origin.latitudeDeg + ((mapped.north / EARTH_RADIUS_M) * 180) / Math.PI,
      longitudeDeg:
        origin.longitudeDeg +
        ((mapped.east / (EARTH_RADIUS_M * cosLat)) * 180) / Math.PI,
      altitudeM: ref.altitudeM,
    };
  });
}

export async function assignLapGeoreference(input: {
  canonicalSlug?: string;
  gameId: GameId;
  trackOrdinal: number;
  packets: readonly TelemetryPacket[];
}): Promise<GeoreferenceMetadata | null> {
  if (input.gameId === "iracing") {
    const nativeValid: GeographicPosition[] = [];
    for (const packet of input.packets) {
      const position = nativePosition(packet);
      if (position) nativeValid.push(position);
    }
    if (nativeValid.length < MIN_SAMPLES) return null;
    const sourceId = sourceIdentity(input.trackOrdinal);
    if (
      input.canonicalSlug &&
      (await getGeoreferenceReference(input.canonicalSlug, sourceId))
    ) {
      return {
        kind: "native",
        sourceIdentity: sourceId,
        canonicalSlug: input.canonicalSlug,
        quality: { score: 1, rmseM: 0, sampleCount: nativeValid.length },
      };
    }
    const boundedPath = resampleByArc(
      nativeValid,
      Math.min(MAX_REFERENCE_SAMPLES, nativeValid.length),
      (a, b) => {
        const east =
          (((b.longitudeDeg - a.longitudeDeg) * Math.PI) / 180) *
          EARTH_RADIUS_M *
          Math.cos((a.latitudeDeg * Math.PI) / 180);
        const north =
          (((b.latitudeDeg - a.latitudeDeg) * Math.PI) / 180) * EARTH_RADIUS_M;
        return Math.hypot(east, north);
      },
      (a, b, f) => ({
        latitudeDeg: a.latitudeDeg + (b.latitudeDeg - a.latitudeDeg) * f,
        longitudeDeg: a.longitudeDeg + (b.longitudeDeg - a.longitudeDeg) * f,
        altitudeM: a.altitudeM + (b.altitudeM - a.altitudeM) * f,
      }),
    );
    const origin = boundedPath[0]!;
    if (input.canonicalSlug) {
      await saveGeoreferenceReference({
        canonicalSlug: input.canonicalSlug,
        sourceIdentity: sourceId,
        referenceVersion: referenceVersion(boundedPath),
        referencePath: boundedPath,
        originLatitudeDeg: origin.latitudeDeg,
        originLongitudeDeg: origin.longitudeDeg,
        originAltitudeM: origin.altitudeM,
        sampleCount: boundedPath.length,
        qualityRmseM: 0,
      });
    }
    return {
      kind: "native",
      sourceIdentity: sourceId,
      canonicalSlug: input.canonicalSlug ?? null,
      quality: { score: 1, rmseM: 0, sampleCount: nativeValid.length },
    };
  }

  if (!input.canonicalSlug) return null;
  const reference = await getLatestGeoreferenceReference(input.canonicalSlug);
  if (!reference || reference.referencePath.length < MIN_SAMPLES) return null;
  const local = input.packets
    .map((packet) => ({ x: packet.PositionX, z: packet.PositionZ }))
    .filter((point): point is LocalPoint => finite(point.x) && finite(point.z));
  if (local.length < MIN_SAMPLES || local.length !== input.packets.length)
    return null;
  const origin: GeodeticReferencePoint = {
    latitudeDeg: reference.originLatitudeDeg,
    longitudeDeg: reference.originLongitudeDeg,
    altitudeM: reference.originAltitudeM,
  };
  const existing = await getGeoreferenceTransform(
    input.canonicalSlug,
    input.gameId,
    input.trackOrdinal,
    reference.referenceVersion,
  );
  if (existing) {
    return {
      kind: "derived",
      sourceIdentity: reference.sourceIdentity,
      canonicalSlug: input.canonicalSlug,
      quality: {
        score: existing.quality,
        rmseM: existing.rmseM,
        sampleCount: existing.sampleCount,
      },
    };
  }
  const referenceEnu = reference.referencePath.map((point) => {
    const enu = toEnu(point, origin);
    return { x: enu.east, z: enu.north };
  });
  const fitSampleCount = Math.min(
    200,
    Math.max(MIN_SAMPLES, local.length, referenceEnu.length),
  );
  const sourceSamples = resampleByArc(
    local,
    fitSampleCount,
    (a, b) => Math.hypot(b.x - a.x, b.z - a.z),
    (a, b, f) => ({
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
    }),
  );
  const targetSamples = resampleByArc(
    referenceEnu,
    fitSampleCount,
    (a, b) => Math.hypot(b.x - a.x, b.z - a.z),
    (a, b, f) => ({
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
    }),
  );
  if (!hasMinimumSpan(sourceSamples) || !hasMinimumSpan(targetSamples))
    return null;
  const fitted = computeAlignment(sourceSamples, targetSamples, {
    allowReverse: false,
    sampleCount: fitSampleCount,
    inputsAreArcSamples: true,
  });
  if (!fitted || fitted.scale < MIN_SCALE || fitted.scale > MAX_SCALE)
    return null;
  const rmseM = trackAlignmentRmse(sourceSamples, targetSamples, fitted);
  if (!Number.isFinite(rmseM) || rmseM > MAX_RMSE_M) return null;
  const score = quality(rmseM);
  if (score < 0.5) return null;
  const transform = await saveGeoreferenceTransform({
    canonicalSlug: input.canonicalSlug,
    targetGameId: input.gameId,
    targetTrackOrdinal: input.trackOrdinal,
    sourceIdentity: reference.sourceIdentity,
    referenceVersion: reference.referenceVersion,
    scale: fitted.scale,
    rotation: Math.atan2(fitted.sin, fitted.cos),
    flipX: fitted.flipX,
    flipZ: fitted.flipZ,
    translationEastM: fitted.tx,
    translationNorthM: fitted.tz,
    rmseM,
    quality: score,
    sampleCount: fitSampleCount,
  });
  return {
    kind: "derived",
    sourceIdentity: reference.sourceIdentity,
    canonicalSlug: input.canonicalSlug,
    quality: {
      score: transform.quality,
      rmseM: transform.rmseM,
      sampleCount: transform.sampleCount,
    },
  };
}
export async function assignSessionGeoreference(
  sessionId: number,
  gameId: GameId,
): Promise<void> {
  const rows = (await getLapsForSession(sessionId))
    .filter((lap) => lap.isValid && lap.lapTime > 0)
    .sort(
      (first, second) =>
        Number(second.rawFrameCount ?? 0) - Number(first.rawFrameCount ?? 0) ||
        first.lapTime - second.lapTime,
    );
  const adapter = getServerGame(gameId);
  for (const row of rows) {
    const lap = await getLapById(row.id);
    const trackOrdinal = lap?.trackOrdinal;
    if (
      !lap ||
      lap.gameId !== gameId ||
      trackOrdinal == null ||
      lap.telemetry.length < MIN_SAMPLES
    )
      continue;
    const canonicalSlug = adapter.getSharedTrackName?.(trackOrdinal);
    if (!canonicalSlug) continue;
    const assignment = await assignLapGeoreference({
      canonicalSlug,
      gameId,
      trackOrdinal,
      packets: lap.telemetry,
    });
    if (assignment) return;
  }
}

/** Read-only Analyse projection. Track assignments are created at session finalization. */
export async function resolveLapGeoreference(input: {
  canonicalSlug?: string;
  gameId: GameId;
  trackOrdinal: number;
  packets: readonly TelemetryPacket[];
}): Promise<LapGeoreference | null> {
  if (input.gameId === "iracing") {
    const native: (GeographicPosition | null)[] = [];
    let nativeSampleCount = 0;
    for (const packet of input.packets) {
      const position = nativePosition(packet);
      native.push(position);
      if (position) nativeSampleCount++;
    }
    if (nativeSampleCount < MIN_SAMPLES) return null;
    return {
      positions: native,
      metadata: {
        kind: "native",
        sourceIdentity: sourceIdentity(input.trackOrdinal),
        canonicalSlug: input.canonicalSlug ?? null,
        quality: { score: 1, rmseM: 0, sampleCount: nativeSampleCount },
      },
    };
  }
  if (!input.canonicalSlug) return null;
  const reference = await getLatestGeoreferenceReference(input.canonicalSlug);
  if (!reference || reference.referencePath.length < MIN_SAMPLES) return null;
  const transform = await getGeoreferenceTransform(
    input.canonicalSlug,
    input.gameId,
    input.trackOrdinal,
    reference.referenceVersion,
  );
  if (!transform) return null;
  const local = input.packets
    .map((packet) => ({ x: packet.PositionX, z: packet.PositionZ }))
    .filter((point): point is LocalPoint => finite(point.x) && finite(point.z));
  if (local.length < MIN_SAMPLES || local.length !== input.packets.length)
    return null;
  const origin: GeodeticReferencePoint = {
    latitudeDeg: reference.originLatitudeDeg,
    longitudeDeg: reference.originLongitudeDeg,
    altitudeM: reference.originAltitudeM,
  };
  return {
    positions: geographyFromTransform(local, reference.referencePath, origin, {
      scale: transform.scale,
      rotation: transform.rotation,
      flipX: transform.flipX,
      flipZ: transform.flipZ,
      translationEastM: transform.translationEastM,
      translationNorthM: transform.translationNorthM,
    }),
    metadata: {
      kind: "derived",
      sourceIdentity: reference.sourceIdentity,
      canonicalSlug: input.canonicalSlug,
      quality: {
        score: transform.quality,
        rmseM: transform.rmseM,
        sampleCount: transform.sampleCount,
      },
    },
  };
}
