import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import type { ResolvedValue, TelemetryTimestamp } from "@raceiq/shared/telemetry/resolver/contracts";
import type { LmuResolvedValueWire } from "@raceiq/shared/telemetry/lmu-context";
import { getLapById, getLapMetaById } from "@raceiq/backend-core/db/lap-read-queries";
import { getLapReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import type { SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import { getLmuOpponentIndexStatus, reportLmuOpponentIndexReadFailure } from "@raceiq/backend-core/session-capture/lmu-opponent-index-runtime";
import { LmuOpponentIndexError, loadLmuOpponentInterval, readLmuOpponentCatalogSummary, readLmuOpponentIndex, type LmuOpponentIndex, type LmuOpponentIndexSourceDependency } from "@raceiq/backend-core/lap-analysis/lmu-opponent-index";
import { LmuOpponentSourceError, projectLmuOpponentTelemetry, type LmuOpponentLapInterval } from "@raceiq/backend-core/lap-analysis/lmu-opponent-laps";
import { groupLmuOpponentSessions as groupOpponentSessions } from "@raceiq/backend-core/lap-analysis/lmu-opponent-summary";
import { encodeLmuContext, encodeLmuResolvedValue } from "@raceiq/shared/telemetry/lmu-context";
import type { LmuCompetitor } from "@raceiq/shared/telemetry/lmu";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { OpponentLapCatalog, OpponentSemanticLapTelemetry } from "../contracts/opponents";

export { groupOpponentSessions };

const linearInterpolate = (lower: number, upper: number, fraction: number) => lower + (upper - lower) * fraction;
const DISTANCE_ALIGNMENT_HASH = createHash("sha256").update(linearInterpolate.toString()).digest("hex");

interface LmuPositionPoint {
  distance: number | null;
  sequence: bigint | null;
  continuousFromPrevious: boolean;
  channels: Readonly<Record<string, ResolvedValue<unknown>>>;
}

function numeric(channel: ResolvedValue<unknown> | undefined): ResolvedValue<number> | null {
  return channel?.state === "ok" && channel.freshness === "fresh" &&
    typeof channel.value === "number" && Number.isFinite(channel.value)
    ? channel as ResolvedValue<number>
    : null;
}


function positionPoints(
  rows: readonly { competitor: LmuCompetitor; captureSequence: string }[],
): LmuPositionPoint[] {
  const points: LmuPositionPoint[] = [];
  let previousDistance: number | null = null;
  let previousObservationKey: string | null = null;
  let previousCaptureSequence: bigint | null = null;
  let continuousFromPrevious = true;
  for (const row of rows) {
    const captureSequence = BigInt(row.captureSequence);
    if (previousCaptureSequence !== null && captureSequence !== previousCaptureSequence + 1n) continuousFromPrevious = false;
    previousCaptureSequence = captureSequence;
    const distanceValue = numeric(row.competitor.channels["race.competitor.lap-distance"]);
    const distance = distanceValue?.value ?? null;
    if (distance !== null && previousDistance !== null && distance < previousDistance) break;
    if (distance !== null) previousDistance = distance;
    const x = numeric(row.competitor.channels["motion.competitor.position.x"]);
    const z = numeric(row.competitor.channels["motion.competitor.position.z"]);
    const sequence = x?.provenance.sourceObservation?.updateSequence ??
      z?.provenance.sourceObservation?.updateSequence ??
      distanceValue?.provenance.sourceObservation?.updateSequence ?? null;
    const timestamp = x?.provenance.observedAt ?? z?.provenance.observedAt ?? distanceValue?.provenance.observedAt;
    const observationKey = sequence !== null && timestamp
      ? `${timestamp.domain}:${timestamp.domain === "monotonic" ? timestamp.nanoseconds : timestamp.milliseconds}:${sequence}`
      : null;
    if (observationKey !== null && observationKey === previousObservationKey) continue;
    previousObservationKey = observationKey;
    points.push({ distance, sequence, continuousFromPrevious, channels: row.competitor.channels });
    continuousFromPrevious = true;
  }
  return points;
}

function sourceValue(
  point: LmuPositionPoint,
  sourceId: string,
  semanticId: string,
): ResolvedValue<number> | null {
  const value = numeric(point.channels[sourceId]);
  return value ? { ...value, semanticId } : null;
}

function missingValue(template: ResolvedValue<number>, semanticId: string): ResolvedValue<number> {
  return {
    ...template, semanticId, value: null, mappingStatus: "unavailable", state: "missing", freshness: "unknown",
    confidence: null, confidenceComponents: { ...template.confidenceComponents, freshness: null },
    limitations: [...template.limitations, "No adjacent source observations cover this distance."],
  };
}

function interpolatedValue(
  points: readonly LmuPositionPoint[],
  distance: number,
  sourceId: string,
  semanticId: string,
): ResolvedValue<number> | null {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.distance === null || points[middle]!.distance! < distance) low = middle + 1;
    else high = middle;
  }
  if (low === points.length) return null;
  const upperPoint = points[low]!;
  const upperValue = sourceValue(upperPoint, sourceId, semanticId);
  if (upperPoint.distance === distance) return upperValue;
  if (low === 0) return null;
  const lowerPoint = points[low - 1]!;
  const lowerValue = sourceValue(lowerPoint, sourceId, semanticId);
  if (!lowerValue || !upperValue || !upperPoint.continuousFromPrevious || lowerPoint.distance === null || upperPoint.distance === null ||
      lowerPoint.sequence === null || upperPoint.sequence === null || upperPoint.sequence !== lowerPoint.sequence + 1n) {
    const template = lowerValue ?? upperValue;
    return template ? missingValue(template, semanticId) : null;
  }
  const fraction = (distance - lowerPoint.distance) / (upperPoint.distance - lowerPoint.distance);
  return {
    ...lowerValue,
    value: linearInterpolate(lowerValue.value!, upperValue.value!, fraction),
    mappingStatus: "derived",
    provenance: {
      ...lowerValue.provenance,
      derivation: {
        id: "lmu.opponent.distance-alignment",
        version: "1",
        codeHash: DISTANCE_ALIGNMENT_HASH,
      },
    },
    limitations: [...lowerValue.limitations, "Distance-aligned interpolation between adjacent native observations."],
  };
}

function extent(points: readonly LmuPositionPoint[]): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.distance !== null &&
        numeric(point.channels["motion.competitor.position.x"]) !== null &&
        numeric(point.channels["motion.competitor.position.z"]) !== null) {
      min = Math.min(min, point.distance);
      max = Math.max(max, point.distance);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null;
}

function firstSourceValue(
  points: readonly LmuPositionPoint[],
  sourceId: string,
  semanticId: string,
): ResolvedValue<number> | null {
  for (const point of points) {
    const value = sourceValue(point, sourceId, semanticId);
    if (value) return value;
  }
  return null;
}

export function alignLmuOpponentPositionTraces(
  playerRows: readonly { competitor: LmuCompetitor; captureSequence: string }[],
  opponent: LmuOpponentLapInterval,
  requested: { step: number; start?: number; end?: number },
) {
  const player = positionPoints(playerRows);
  const opponentRows = opponent.frames
    .filter((frame) => frame.captureSequence !== opponent.endSequence)
    .map((frame) => ({
      captureSequence: frame.captureSequence,
      competitor: frame.competitors.find((entry) =>
        entry.vehicleId === opponent.vehicleId && entry.incarnation === opponent.incarnation),
    }))
    .filter((row): row is { captureSequence: string; competitor: LmuCompetitor } => row.competitor !== undefined);
  const other = positionPoints(opponentRows);
  const playerRange = extent(player);
  const opponentRange = extent(other);
  if (!playerRange || !opponentRange) return null;
  const overlapStart = Math.max(playerRange[0], opponentRange[0]);
  const overlapEnd = Math.min(playerRange[1], opponentRange[1]);
  if ((requested.start !== undefined && requested.start < overlapStart) ||
      (requested.end !== undefined && requested.end > overlapEnd)) return { error: "range" as const };
  const start = requested.start ?? overlapStart;
  const end = requested.end ?? overlapEnd;
  if (start >= end) return null;
  let count = Math.floor((end - start) / requested.step) + 1;
  if (start + (count - 1) * requested.step < end - 1e-6) {
    if (count === 50_000) return { error: "budget" as const };
    count++;
  }
  if (count < 2 || count > 50_000) return { error: "budget" as const };
  const distanceMeters = Array.from({ length: count }, (_, index) =>
    index === count - 1 ? end : start + index * requested.step);
  const semanticIds = [
    "motion.position-x", "motion.position-z", "motion.speed",
    "race.competitor.scoring-time", "race.competitor.lap-start-time",
  ].filter((semanticId) => {
    const sourceId = semanticId === "motion.position-x" ? "motion.competitor.position.x" :
      semanticId === "motion.position-z" ? "motion.competitor.position.z" :
      semanticId === "motion.speed" ? "motion.competitor.speed" : semanticId;
    return firstSourceValue(player, sourceId, semanticId) !== null &&
      firstSourceValue(other, sourceId, semanticId) !== null;
  });
  const traces = semanticIds.map((semanticId) => {
    const sourceId = semanticId === "motion.position-x" ? "motion.competitor.position.x" :
      semanticId === "motion.position-z" ? "motion.competitor.position.z" :
      semanticId === "motion.speed" ? "motion.competitor.speed" : semanticId;
    const playerValues = distanceMeters.map((distance) => interpolatedValue(player, distance, sourceId, semanticId));
    const opponentValues = distanceMeters.map((distance) => interpolatedValue(other, distance, sourceId, semanticId));
    const playerTemplate = playerValues.find((value) => value !== null) ?? firstSourceValue(player, sourceId, semanticId)!;
    const opponentTemplate = opponentValues.find((value) => value !== null) ?? firstSourceValue(other, sourceId, semanticId)!;
    return {
      semanticId,
      unit: semanticId.startsWith("motion.position-") ? "m" : semanticId === "motion.speed" ? "m/s" : "s",
      distanceMeters,
      player: playerValues.map((value) => value ?? missingValue(playerTemplate, semanticId)),
      opponent: opponentValues.map((value) => value ?? missingValue(opponentTemplate, semanticId)),
    };
  });
  return { distanceMeters, traces };
}

const OPAQUE = z.string().min(1).max(512).refine((value) => new TextEncoder().encode(value).length <= 512);
const PlayerLapParam = z.object({
  id: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger),
}).strict();
const OpponentLapParam = PlayerLapParam.extend({ opponentLapId: OPAQUE }).strict();
const ComparisonBody = z.object({
  opponentLapId: OPAQUE,
  sourceRevision: OPAQUE,
  step: z.union([z.literal(1), z.literal(0.1)]),
  start: z.number().finite().nonnegative().optional(),
  end: z.number().finite().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.step === 0.1 && (value.start === undefined || value.end === undefined || value.start >= value.end)) {
    ctx.addIssue({ code: "custom", message: "Detail range requires 0 <= start < end" });
  }
  if (value.step === 1 && (value.start !== undefined || value.end !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Full-lap request cannot include a range" });
  }
});
const RevisionQuery = z.object({ sourceRevision: OPAQUE }).strict();


const error = (code: string, message: string, status: 400 | 404 | 409 | 410 | 422 | 500) =>
  Response.json({ code, error: message }, { status });


function playerRows(packets: readonly TelemetryPacket[]) {
  return packets.flatMap((packet) => {
    const context = packet.lmuContext;
    const competitor = context?.competitors?.find((entry) => entry.isPlayer);
    const scoringLapStart = competitor && numeric(competitor.channels["race.competitor.lap-start-time"]);
    const telemetryLapStart = packet.CurrentRaceTime - packet.CurrentLap;
    // Scoring can still describe the previous lap after high-rate telemetry crosses the line.
    if (scoringLapStart && Number.isFinite(telemetryLapStart) &&
        Math.abs(scoringLapStart.value! - telemetryLapStart) > 1e-6) return [];
    return context && competitor ? [{ competitor, captureSequence: context.key.captureSequence }] : [];
  });
}


async function sourceForLap(id: number) {
  const [meta, source] = await Promise.all([getLapMetaById(id), getLapReplaySource(id)]);
  return meta && source ? { meta, source } : null;
}

async function opponentIndex(id: number, requestedGameId: string) {
  const resolved = await sourceForLap(id);
  if (!resolved || resolved.meta.gameId !== requestedGameId || resolved.source.gameId !== requestedGameId) {
    return { error: error("LAP_NOT_FOUND", "Lap not found", 404) } as const;
  }
  const { meta, source } = resolved;
  if (meta.gameId !== "lmu" || source.gameId !== "lmu") {
    return { error: error("INVALID_OPPONENT_COMPARISON", "Opponent laps require an LMU lap", 400) } as const;
  }
  const sourcePath = source.captureManifestFile ?? source.rawFile;
  if (!sourcePath) return { error: error("OPPONENT_DATA_UNAVAILABLE", "Session source is unavailable", 422) } as const;
  const captureSource: SessionCaptureSource = {
    rawFile: sourcePath, source: source.source, gameId: source.gameId, carId: source.carId ?? "",
    trackId: source.trackId ?? "", captureFormatVersion: source.captureFormatVersion,
  };
  let status = await getLmuOpponentIndexStatus(captureSource);
  if (status.indexState !== "ready") {
    // A removal may publish a new retention revision while the index transitions out of ready.
    // Re-read durable retention before reporting transient index readiness to callers.
    status = await getLmuOpponentIndexStatus(captureSource);
  }
  return { meta, status, captureSource };
}

async function readReadyOpponentIndex(
  publicationPath: string | null,
  sourceRevision: string,
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[],
) {
  if (!publicationPath) throw new Error("Ready opponent index has no publication path");
  return readLmuOpponentIndex(publicationPath, { sourceRevision, sourceDependencies });
}

async function loadSelectedOpponentInterval(
  source: SessionCaptureSource,
  index: LmuOpponentIndex,
  opponentLapId: string,
) {
  try {
    return await loadLmuOpponentInterval(index, opponentLapId);
  } catch (cause) {
    if (cause instanceof LmuOpponentIndexError && cause.code === "BLOCK_CORRUPT") {
      await reportLmuOpponentIndexReadFailure(source, index.publicationPath);
    }
    throw cause;
  }
}

function opponentReadinessError(status: { indexState: OpponentLapCatalog["indexState"]; error: string | null }) {
  if (status.indexState === "waiting-finalization" || status.indexState === "queued" || status.indexState === "building") {
    return error("OPPONENT_INDEX_NOT_READY", "Opponent index is not ready", 409);
  }
  if (status.indexState === "failed") {
    return error("OPPONENT_INDEX_FAILED", status.error ?? "Opponent index preparation failed", 422);
  }
  return status.indexState === "ready" ? null : error("OPPONENT_DATA_UNAVAILABLE", "Opponent data is unavailable", 422);
}

function opponentStorageError(cause: unknown, fallback: string) {
  if (cause instanceof LmuOpponentSourceError) return error("OPPONENT_DATA_UNAVAILABLE", cause.message, 422);
  if (cause instanceof LmuOpponentIndexError) {
    if (cause.code === "SOURCE_CHANGED") return error("SOURCE_CHANGED", "Opponent source revision changed", 409);
    if (cause.code === "BLOCK_CORRUPT") return error("OPPONENT_DATA_UNAVAILABLE", cause.message, 422);
  }
  return error("STORAGE_IO_ERROR", cause instanceof Error ? cause.message : fallback, 500);
}

function decodeOpponentValue(value: LmuResolvedValueWire<number>): ResolvedValue<number> {
  const decodeTimestamp = (timestamp: LmuResolvedValueWire<number>["provenance"]["observedAt"]): TelemetryTimestamp =>
    timestamp.domain === "monotonic" ? { domain: "monotonic", nanoseconds: BigInt(timestamp.nanoseconds) } : timestamp;
  const { sourceObservation, ...provenance } = value.provenance;
  return {
    ...value,
    provenance: {
      ...provenance,
      observedAt: decodeTimestamp(provenance.observedAt),
      ...(sourceObservation ? {
        sourceObservation: {
          timestamp: decodeTimestamp(sourceObservation.timestamp),
          updateSequence: BigInt(sourceObservation.updateSequence),
        },
      } : {}),
    },
  };
}


function semanticFrameTime(timestamp: TelemetryTimestamp) {
  return timestamp.domain === "monotonic"
    ? { domain: timestamp.domain, milliseconds: Number(timestamp.nanoseconds) / 1_000_000 }
    : { domain: timestamp.domain, milliseconds: timestamp.milliseconds };
}

function observationAdvances(previous: TelemetryTimestamp | null, current: TelemetryTimestamp): boolean {
  if (!previous || previous.domain !== current.domain) return false;
  return current.domain === "monotonic"
    ? previous.domain === "monotonic" && current.nanoseconds > previous.nanoseconds
    : previous.domain !== "monotonic" && current.milliseconds > previous.milliseconds;
}

export function buildLmuOpponentSemanticFrames(interval: LmuOpponentLapInterval) {
  const envelopes = [];
  let previousKey: string | null = null;
  let previousSequence: bigint | null = null;
  let previousObservedAt: TelemetryTimestamp | null = null;
  let previousCaptureSequence: bigint | null = null;
  let replaySequence = 0;
  for (const frame of interval.frames) {
    if (frame.captureSequence === interval.endSequence) continue;
    const competitor = frame.competitors.find((entry) =>
      entry.vehicleId === interval.vehicleId && entry.incarnation === interval.incarnation);
    const scoringTime = competitor?.channels["race.competitor.scoring-time"];
    const sourceSequence = scoringTime?.provenance.sourceObservation?.updateSequence;
    if (!competitor || !scoringTime || sourceSequence === undefined) continue;
    const observedAt = scoringTime.provenance.observedAt;
    const timestampKey = observedAt.domain === "monotonic"
      ? observedAt.nanoseconds.toString()
      : observedAt.milliseconds.toString();
    const key = `${observedAt.domain}:${sourceSequence}:${timestampKey}`;
    const captureSequence = BigInt(frame.captureSequence);
    const captureAdvanced = previousCaptureSequence === null || captureSequence > previousCaptureSequence;
    previousCaptureSequence = captureSequence;
    if (key === previousKey) continue;
    const counterReset = previousSequence !== null && sourceSequence < previousSequence;
    if (counterReset && (!captureAdvanced || !observationAdvances(previousObservedAt, observedAt))) {
      throw new LmuOpponentSourceError("Opponent scoring source sequence is not strictly increasing");
    }
    const gap = previousSequence !== null && sourceSequence > previousSequence + 1n
      ? sourceSequence - previousSequence - 1n
      : 0n;
    // Replay sequence is an ordinal, not a source counter; reserve a hole to stop playback bridging missing observations.
    replaySequence += gap > 0n ? 2 : 1;
    const discontinuity = gap > 0n ? `${gap} source scoring update(s) unavailable before this frame.` : null;
    const projected = projectLmuOpponentTelemetry(competitor);
    const values = discontinuity
      ? projected.map((value) => ({
          ...value,
          limitations: [...value.limitations, discontinuity],
        }))
      : projected;
    envelopes.push({
      sequence: replaySequence,
      observedAt: semanticFrameTime(observedAt),
      receivedAt: { domain: "wall-clock" as const, milliseconds: frame.frameTime },
      simulator: "lmu",
      values,
      ...(frame.lmuContext ? { lmu: encodeLmuContext({
        ...frame.lmuContext,
        supplemental: frame.lmuContext.supplemental.filter((entry) => entry.applicability === "session"),
        competitors: frame.lmuContext.competitors?.filter((entry) =>
          entry.vehicleId === interval.vehicleId && entry.incarnation === interval.incarnation ||
          entry.isPlayer && entry.vehicleId === frame.lmuContext!.playerVehicleId
        ).map((entry) => entry.vehicleId === interval.vehicleId && entry.incarnation === interval.incarnation ? entry : { ...entry, channels: {} }),
      }) } : {}),
    });
    previousKey = key;
    previousSequence = sourceSequence;
    previousObservedAt = observedAt;
  }
  return envelopes;
}


export const opponentRoutes = new Hono()
  .get("/api/laps/:id/opponent-laps", zValidator("param", PlayerLapParam, (result, c) => result.success ? undefined : c.json({ code: "INVALID_OPPONENT_COMPARISON", error: "Malformed opponent request" }, 400)), async (c) => {
    const { id } = c.req.valid("param");
    const gameId = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameId.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    try {
      const result = await opponentIndex(id, gameId.data);
      if ("error" in result) return result.error;
      if (result.meta.gameId !== gameId.data) return c.json({ error: "Lap not found" }, 404);
      const summary = result.status.indexState === "ready"
        ? readLmuOpponentCatalogSummary(
            await readReadyOpponentIndex(
              result.status.publicationPath,
              result.status.retention.sourceRevision,
              result.status.sourceDependencies,
            ),
            id,
          )
        : { sessions: [], laps: [] };
      const catalog: OpponentLapCatalog = {
        playerLapId: id, sourceRevision: result.status.retention.sourceRevision,
        opponentRetention: result.status.retention.opponentRetention,
        opponentAvailability: result.status.retention.opponentAvailability,
        indexState: result.status.indexState,
        sessions: summary.sessions, laps: summary.laps,
      };
      return c.json(catalog);
    } catch (cause) {
      return opponentStorageError(cause, "Unable to read opponent source");
    }
  })
  .post("/api/laps/:id/opponent-comparison", zValidator("param", PlayerLapParam, (result, c) => result.success ? undefined : c.json({ code: "INVALID_OPPONENT_COMPARISON", error: "Malformed opponent request" }, 400)), zValidator("json", ComparisonBody, (result, c) => result.success ? undefined : c.json({ code: "INVALID_OPPONENT_COMPARISON", error: "Malformed opponent request" }, 400)), async (c) => {
    const { id } = c.req.valid("param");
    const gameId = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameId.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    try {
      const result = await opponentIndex(id, gameId.data);
      if ("error" in result) return result.error;
      if (result.meta.gameId !== gameId.data) return error("LAP_NOT_FOUND", "Lap not found", 404);
      const body = c.req.valid("json");
      const retention = result.status.retention;
      if (body.sourceRevision !== retention.sourceRevision) return error("SOURCE_CHANGED", "Opponent source revision changed", 409);
      if (retention.opponentRetention === "removed") return error("OPPONENT_DATA_REMOVED", "Opponent data was removed", 410);
      if (retention.opponentRetention === "not-recorded" || retention.opponentAvailability === "missing" || retention.opponentAvailability === "corrupt") {
        return error("OPPONENT_DATA_UNAVAILABLE", "Opponent data is unavailable", 422);
      }
      const readiness = opponentReadinessError(result.status);
      if (readiness) return readiness;
      const index = await readReadyOpponentIndex(result.status.publicationPath, retention.sourceRevision, result.status.sourceDependencies);
      const summary = readLmuOpponentCatalogSummary(index, id);
      const opponentSummary = summary.laps.find((lap) => lap.opponentLapId === body.opponentLapId);
      if (!opponentSummary) return error("OPPONENT_LAP_NOT_FOUND", "Opponent lap not found", 404);
      const opponent = await loadSelectedOpponentInterval(result.captureSource, index, body.opponentLapId);
      const playerLap = await getLapById(id);
      const playerPackets = playerLap?.telemetry ?? [];
      const opponentLapTime = decodeOpponentValue(opponentSummary.lapTime);
      const playerLapTime = result.meta.lapTime;
      const traces = alignLmuOpponentPositionTraces(playerRows(playerPackets), opponent, body);
      if (traces && "error" in traces) {
        return traces.error === "range"
          ? error("INVALID_OPPONENT_COMPARISON", "Requested distance range exceeds paired source coverage", 400)
          : error("OPPONENT_DATA_UNAVAILABLE", "Requested trace exceeds the 50000-sample budget", 422);
      }
      const knownPlayerLapTime = typeof playerLapTime === "number" && Number.isFinite(playerLapTime) ? playerLapTime : null;
      const knownOpponentLapTime = opponentLapTime.state === "ok" && typeof opponentLapTime.value === "number" &&
        Number.isFinite(opponentLapTime.value) ? opponentLapTime.value : null;
      const hasLapTiming = knownPlayerLapTime !== null && knownOpponentLapTime !== null;
      type KnownTiming = ResolvedValue<number> & { value: number };
      const delta = (semanticId: string, playerTime: number, opponentTime: KnownTiming) => ({
        ...opponentTime,
        semanticId,
        value: playerTime - opponentTime.value,
        mappingStatus: "derived" as const,
        provenance: {
          ...opponentTime.provenance,
          derivation: {
            id: "lmu.opponent-comparison.delta-seconds",
            version: "1",
            codeHash: createHash("sha256").update("player-seconds-minus-opponent-seconds").digest("hex"),
          },
        },
        limitations: [...opponentTime.limitations, "Player input is the persisted selected-lap timing."],
      });
      const lapDeltaSeconds = hasLapTiming
        ? delta("timing.lap.delta", knownPlayerLapTime!, { ...opponentLapTime, value: knownOpponentLapTime! })
        : {
            ...opponentLapTime,
            semanticId: "timing.lap.delta",
            value: null,
            mappingStatus: "unavailable" as const,
            state: "missing" as const,
            freshness: "unknown" as const,
            confidence: null,
            confidenceComponents: { ...opponentLapTime.confidenceComponents, freshness: null, inputCompleteness: 0 },
            limitations: [...opponentLapTime.limitations, "Source-backed timing is unavailable on one or both laps."],
          };
      if (!hasLapTiming && !traces) {
        return error("OPPONENT_DATA_UNAVAILABLE", "No paired position coverage or comparable lap timing is available", 422);
      }
      const playerSectorTimes = result.meta.sectorTimes ?? [];
      const opponentCompetitor = opponent.frames.at(-1)?.competitors.find((entry) =>
        entry.vehicleId === opponent.vehicleId && entry.incarnation === opponent.incarnation);
      const opponentSectorOne = opponentCompetitor?.channels["race.competitor.last-sector-1"];
      const opponentSectorTwoCumulative = opponentCompetitor?.channels["race.competitor.last-sector-2-cumulative"];
      const sectorDeltas = [];
      if (opponent.endSequence !== null && playerSectorTimes[0] !== undefined && opponentSectorOne?.state === "ok" && typeof opponentSectorOne.value === "number") {
        sectorDeltas.push({ semanticId: "timing.sector.last-lap.s1", deltaSeconds: delta("timing.sector.last-lap.s1.delta", playerSectorTimes[0], opponentSectorOne as KnownTiming) });
      }
      if (opponent.endSequence !== null && playerSectorTimes[1] !== undefined && opponentSectorOne?.state === "ok" && typeof opponentSectorOne.value === "number" &&
          opponentSectorTwoCumulative?.state === "ok" && typeof opponentSectorTwoCumulative.value === "number" &&
          opponentSectorTwoCumulative.value >= opponentSectorOne.value) {
        const opponentSectorTwo = {
          ...opponentSectorTwoCumulative,
          value: opponentSectorTwoCumulative.value - opponentSectorOne.value,
          provenance: {
            ...opponentSectorTwoCumulative.provenance,
            derivation: {
              id: "lmu.opponent-sector-two.duration",
              version: "1",
              codeHash: createHash("sha256").update("cumulative-sector-1-2-minus-sector-1").digest("hex"),
            },
          },
        };
        sectorDeltas.push({ semanticId: "timing.sector.last-lap.s2", deltaSeconds: delta("timing.sector.last-lap.s2.delta", playerSectorTimes[1], opponentSectorTwo as KnownTiming) });
      }
      return c.json({
        playerLapId: id, sourceRevision: retention.sourceRevision, opponent: opponentSummary,
        mode: traces ? "telemetry" as const : "timing-only" as const,
        lapDeltaSeconds: encodeLmuResolvedValue(lapDeltaSeconds), sectorDeltas: sectorDeltas.map((sector) => ({ ...sector, deltaSeconds: encodeLmuResolvedValue(sector.deltaSeconds) })),
        traces: (traces?.traces ?? []).map((trace) => ({ ...trace,
          player: trace.player.map(encodeLmuResolvedValue), opponent: trace.opponent.map(encodeLmuResolvedValue),
        })),
      });
    } catch (cause) {
      return opponentStorageError(cause, "Unable to compare opponent lap");
    }
  })
  .get("/api/laps/:id/opponent-laps/:opponentLapId/semantic-telemetry", zValidator("param", OpponentLapParam, (result, c) => result.success ? undefined : c.json({ code: "INVALID_OPPONENT_COMPARISON", error: "Malformed opponent request" }, 400)), zValidator("query", RevisionQuery, (result, c) => result.success ? undefined : c.json({ code: "INVALID_OPPONENT_COMPARISON", error: "Malformed opponent request" }, 400)), async (c) => {
    const { id, opponentLapId } = c.req.valid("param");
    const gameId = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameId.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    try {
      const result = await opponentIndex(id, gameId.data);
      if ("error" in result) return result.error;
      if (result.meta.gameId !== gameId.data) return error("LAP_NOT_FOUND", "Lap not found", 404);
      const revision = c.req.valid("query").sourceRevision;
      const retention = result.status.retention;
      if (revision !== retention.sourceRevision) return error("SOURCE_CHANGED", "Opponent source revision changed", 409);
      if (retention.opponentRetention === "removed") return error("OPPONENT_DATA_REMOVED", "Opponent data was removed", 410);
      if (retention.opponentRetention !== "retained" || retention.opponentAvailability === "missing" || retention.opponentAvailability === "corrupt") {
        return error("OPPONENT_DATA_UNAVAILABLE", "Opponent data is unavailable", 422);
      }
      const readiness = opponentReadinessError(result.status);
      if (readiness) return readiness;
      const index = await readReadyOpponentIndex(result.status.publicationPath, retention.sourceRevision, result.status.sourceDependencies);
      const summary = readLmuOpponentCatalogSummary(index, id);
      if (!summary.laps.some((lap) => lap.opponentLapId === opponentLapId)) {
        return error("OPPONENT_LAP_NOT_FOUND", "Opponent lap not found", 404);
      }
      const interval = await loadSelectedOpponentInterval(result.captureSource, index, opponentLapId);
      const envelopes = buildLmuOpponentSemanticFrames(interval);
      if (envelopes.length === 0) {
        return error("OPPONENT_DATA_UNAVAILABLE", "Opponent interval has no source-backed scoring observations", 422);
      }
      const response: OpponentSemanticLapTelemetry = {
        opponentLapId, sourceRevision: revision,
        requestedSemanticIds: [...new Set(envelopes.flatMap((envelope) => envelope.values.map((value) => value.semanticId)))].sort(),
        sectorTimes: null, sectorStarts: null, insights: [], detectorCoverage: [], parseError: null,
        envelopes: envelopes.map((envelope) => ({ ...envelope, values: envelope.values.map(encodeLmuResolvedValue) })),
      };
      return c.json(response);
    } catch (cause) {
      return opponentStorageError(cause, "Unable to read opponent telemetry");
    }
  });
