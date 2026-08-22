import { semanticLapFrames, type SemanticLapFrame } from "../../shared/racing/analysis/laps/semantic-frame";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { GameId } from "../../shared/games/ids";
import { getGame } from "../../shared/games/registry";
import { resolveTrack } from "../tracks/info";

export interface NativeSectorTimeline {
  sectorCount: number;
  times: number[];
  boundaryIndices: number[];
  sectorStarts: number[];
}

type SectorStarts = readonly [number, ...number[]];

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sectorStarts(value: unknown): SectorStarts | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const starts: number[] = [];
  for (const entry of value) {
    if (!finiteNumber(entry)) return null;
    starts.push(entry);
  }
  const [first, ...rest] = starts;
  return first === undefined ? null : [first, ...rest];
}

function validSectorTimes(value: unknown, lapTime: number): number[] | null {
  if (!finiteNumber(lapTime) || lapTime <= 0 || !Array.isArray(value) || value.length < 2) return null;
  const times: number[] = [];
  for (const entry of value) {
    if (!finiteNumber(entry) || entry <= 0) return null;
    times.push(entry);
  }
  const total = times.reduce((sum, time) => sum + time, 0);
  return Math.abs(total - lapTime) <= Math.max(0.25, lapTime * 0.02) ? times : null;
}

function latestStructuredTime(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const time = latestStructuredTime(value[index]);
      if (time !== undefined) return time;
    }
    return undefined;
  }
  if (value != null && typeof value === "object") {
    const direct = "value" in value ? latestStructuredTime(value.value) : undefined;
    if (direct !== undefined) return direct;
    const entries = Object.entries(value).sort(([left], [right]) => Number(right) - Number(left));
    for (const [, entry] of entries) {
      const time = latestStructuredTime(entry);
      if (time !== undefined) return time;
    }
  }
  return undefined;
}

/**
 * Game-owned sector evidence comes before layout/distance inference. Last-lap
 * and history values describe a completed lap; current-lap values are accepted
 * only once their finite sum agrees with its authoritative lap time.
 */
function authoritativeSectorTimes(samples: readonly SemanticTelemetrySample[], lapTime: number): number[] | null {
  for (let index = samples.length - 1; index >= 0; index--) {
    const values = samples[index].values;
    const lastLap = validSectorTimes(values["timing.sector.last-lap.times"], lapTime);
    if (lastLap) return lastLap;
    const currentLap = validSectorTimes(values["timing.sector.current-lap.times"], lapTime);
    if (currentLap) return currentLap;
    const scalarS1 = values["timing.sector.last-lap.s1"];
    const scalarS2 = values["timing.sector.last-lap.s2"];
    const scalarS3 = values["timing.sector.last-lap.s3"];
    if (finiteNumber(scalarS1) && scalarS1 > 0 && finiteNumber(scalarS2) && scalarS2 > 0) {
      const resolvedS3 = finiteNumber(scalarS3) && scalarS3 > 0 ? scalarS3 : lapTime - scalarS1 - scalarS2;
      const scalarLastLap = validSectorTimes([scalarS1, scalarS2, resolvedS3], lapTime);
      if (scalarLastLap) return scalarLastLap;
    }

    const s1 = latestStructuredTime(values["timing.sector.lap-history.s1"]);
    const s2 = latestStructuredTime(values["timing.sector.lap-history.s2"]);
    const s3 = latestStructuredTime(values["timing.sector.lap-history.s3"]);
    const history = validSectorTimes([s1, s2, s3], lapTime);
    if (history) return history;
  }
  const completed: number[] = [];
  for (const sample of samples) {
    const sectorIndex = sample.values["timing.sector.current-index"];
    const lastCompleted = sample.values["timing.sector.last-completed-time"];
    const currentTime = sample.values["timing.sector.current-time"];
    if (
      typeof sectorIndex !== "number" ||
      !Number.isSafeInteger(sectorIndex) ||
      sectorIndex <= 0 ||
      !finiteNumber(lastCompleted) ||
      lastCompleted <= 0 ||
      !finiteNumber(currentTime) ||
      currentTime < 0
    ) {
      continue;
    }
    // `current-index` is zero-based native authority. Reading current-time
    // confirms source is in an active sector, never a distance-derived guess.
    completed[sectorIndex - 1] = lastCompleted;
  }
  const completedTimes = validSectorTimes(completed, lapTime);
  if (completedTimes) return completedTimes;
  return null;
}

function computeDistanceSectorTimes(packets: readonly SemanticLapFrame[], lapTime: number, s1End: number, s2End: number): number[] | null {
  const first = packets[0];
  const last = packets[packets.length - 1];
  if (
    !first ||
    !last ||
    typeof first.distanceM !== "number" ||
    !Number.isFinite(first.distanceM) ||
    typeof last.distanceM !== "number" ||
    !Number.isFinite(last.distanceM) ||
    typeof first.lapElapsedSeconds !== "number" ||
    !Number.isFinite(first.lapElapsedSeconds)
  ) {
    return null;
  }
  const startDist = first.distanceM;
  const lapDist = last.distanceM - startDist;
  if (lapDist < 100) return null;

  let sector = 0;
  let sectorStart = first.lapElapsedSeconds;
  let s1: number | undefined;
  let s2: number | undefined;
  for (const packet of packets) {
    if (typeof packet.distanceM !== "number" || !Number.isFinite(packet.distanceM) || typeof packet.lapElapsedSeconds !== "number" || !Number.isFinite(packet.lapElapsedSeconds)) {
      return null;
    }
    const fraction = (packet.distanceM - startDist) / lapDist;
    const expected = fraction < s1End ? 0 : fraction < s2End ? 1 : 2;
    if (expected <= sector) continue;

    const elapsed = packet.lapElapsedSeconds - sectorStart;
    if (sector === 0) s1 = elapsed;
    else if (sector === 1) s2 = elapsed;
    sectorStart = packet.lapElapsedSeconds;
    sector = expected;
  }

  if (s1 === undefined || s2 === undefined) return null;
  const s3 = lapTime - s1 - s2;
  return s1 > 0 && s2 > 0 && s3 > 0 ? [s1, s2, s3] : null;
}

function computeSectorTimeline(packets: readonly SemanticLapFrame[], lapTime: number, starts: SectorStarts, lapFractionAt: (index: number) => number | undefined): NativeSectorTimeline | null {
  if (!finiteNumber(lapTime) || lapTime <= 0 || starts[0] < 0 || starts[0] >= 1e-6) return null;
  for (let index = 1; index < starts.length; index++) {
    const start = starts[index];
    const previous = starts[index - 1];
    if (!finiteNumber(start) || !finiteNumber(previous) || start <= previous || start >= 1) return null;
  }

  const boundaryIndices: number[] = [];
  for (let sector = 1; sector < starts.length; sector++) {
    const sectorStart = starts[sector];
    if (!finiteNumber(sectorStart)) return null;
    let boundaryIndex = -1;
    for (let index = 1; index < packets.length; index++) {
      const lapFraction = lapFractionAt(index);
      if (finiteNumber(lapFraction) && lapFraction >= sectorStart) {
        boundaryIndex = index;
        break;
      }
    }
    if (boundaryIndex <= 0) return null;
    boundaryIndices.push(boundaryIndex);
  }

  const first = packets[0];
  if (!first || typeof first.lapElapsedSeconds !== "number" || !Number.isFinite(first.lapElapsedSeconds)) {
    return null;
  }
  const startTime = first.lapElapsedSeconds;
  const times: number[] = [];
  let previousBoundaryTime = 0;
  for (const boundaryIndex of boundaryIndices) {
    const packet = packets[boundaryIndex];
    if (!packet || typeof packet.lapElapsedSeconds !== "number" || !Number.isFinite(packet.lapElapsedSeconds)) {
      return null;
    }
    const boundaryTime = packet.lapElapsedSeconds - startTime;
    times.push(boundaryTime - previousBoundaryTime);
    previousBoundaryTime = boundaryTime;
  }
  times.push(lapTime - previousBoundaryTime);
  if (times.some((time) => !Number.isFinite(time) || time <= 0)) return null;

  return {
    sectorCount: starts.length,
    times,
    boundaryIndices,
    sectorStarts: [...starts],
  };
}

/**
 * Resolve source-owned sector metadata already projected onto semantic frames.
 * Native metadata is supplied by its game adapter; no central code reads packet
 * fields.
 */
export function computeNativeSectorTimeline(
  packets: readonly SemanticLapFrame[],
  lapTime: number,
  getLayout: (packet: SemanticLapFrame) =>
    | {
        starts: number[];
        lapFraction?: number;
      }
    | undefined,
): NativeSectorTimeline | null {
  let starts: SectorStarts | null = null;
  for (const packet of packets) {
    const layout = getLayout(packet);
    const candidate = sectorStarts(layout?.starts);
    if (candidate) {
      starts = candidate;
      break;
    }
  }
  if (!starts) return null;
  return computeSectorTimeline(packets, lapTime, starts, (index) => {
    const packet = packets[index];
    const lapFraction = packet ? getLayout(packet)?.lapFraction : undefined;
    return finiteNumber(lapFraction) ? lapFraction : undefined;
  });
}

function semanticNativeSectorTimeline(samples: readonly SemanticTelemetrySample[], packets: readonly SemanticLapFrame[], lapTime: number): NativeSectorTimeline | null {
  let starts: SectorStarts | null = null;
  for (const sample of samples) {
    const candidate = sectorStarts(sample.values["timing.sector.layout.start-fractions"]);
    if (candidate) {
      starts = candidate;
      break;
    }
  }
  const first = packets[0];
  const last = packets[packets.length - 1];
  if (!starts || !first || !last || !finiteNumber(first.distanceM) || !finiteNumber(last.distanceM)) {
    return null;
  }
  const firstDistance = first.distanceM;
  const lapDistance = last.distanceM - firstDistance;
  if (lapDistance <= 0) return null;
  return computeSectorTimeline(packets, lapTime, starts, (index) => {
    const packet = packets[index];
    if (!packet || !finiteNumber(packet.distanceM)) return undefined;
    const fraction = (packet.distanceM - firstDistance) / lapDistance;
    return finiteNumber(fraction) ? fraction : undefined;
  });
}

/** Resolve any game-owned sector layout from semantic replay values. */
export function computeSemanticSectorTimeline(samples: readonly SemanticTelemetrySample[], lapTime: number): NativeSectorTimeline | null {
  return semanticNativeSectorTimeline(samples, semanticLapFrames(samples), lapTime);
}

/** Resolve iRacing sector timing from semantic sector layout and lap distance. */
export function computeIRacingSectorTimeline(samples: readonly SemanticTelemetrySample[], lapTime: number): NativeSectorTimeline | null {
  return computeSemanticSectorTimeline(samples, lapTime);
}

/**
 * Pure function that computes source-defined sector times from semantic lap
 * samples.
 *
 * @param trackOrdinal Track ordinal from the session
 * @param gameId       Game identifier
 * @param samples      Semantic samples for the completed lap
 * @param lapTime      Authoritative lap time (seconds)
 * @param accLiveSectors Optional ACC live-tracked sector times (captured during the lap).
 *                       Pass undefined for non-ACC games or when not yet tracked.
 */
export async function computeLapSectors(
  trackOrdinal: number,
  gameId: GameId,
  samples: readonly SemanticTelemetrySample[],
  lapTime: number,
  accLiveSectors?: { s1: number; s2: number },
): Promise<number[] | null> {
  if (!Number.isFinite(lapTime) || lapTime <= 0) return null;
  const packets = semanticLapFrames(samples);
  if (packets.length < 50) return null;

  const game = getGame(gameId);
  if (gameId === "f1-2025" || gameId === "acc") {
    const canonicalTimes = authoritativeSectorTimes(samples, lapTime);
    if (canonicalTimes) return canonicalTimes;
    if (gameId === "acc" && accLiveSectors && Number.isFinite(accLiveSectors.s1) && Number.isFinite(accLiveSectors.s2) && accLiveSectors.s1 > 0 && accLiveSectors.s2 > 0) {
      const s3 = lapTime - accLiveSectors.s1 - accLiveSectors.s2;
      return Number.isFinite(s3) && s3 > 0 ? [accLiveSectors.s1, accLiveSectors.s2, s3] : null;
    }
    // F1 owns its splits; do not invent them from track distance. ACC may
    // lack live timing on legacy captures and can still use track geometry.
    if (gameId === "f1-2025") return null;
  }
  if (game.nativeSectors) return semanticNativeSectorTimeline(samples, packets, lapTime)?.times ?? null;

  const { s1End, s2End } = resolveTrack(gameId, trackOrdinal).sectors;
  return computeDistanceSectorTimes(packets, lapTime, s1End, s2End);
}
