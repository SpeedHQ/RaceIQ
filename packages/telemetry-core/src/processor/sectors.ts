import { DEFAULT_SECTORS, getTrackSectorsByName } from "@raceiq/shared/racing/tracks/sectors";
import { TRACK_NAME_BY_ORDINAL } from "./generated-sector-ordinal-map";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TrackSectors } from "@raceiq/shared/racing/tracks/sectors";

export interface NativeSectorTimeline {
  sectorCount: number;
  times: number[];
  boundaryIndices: number[];
  sectorStarts: number[];
}

type IRacingSectorTimeline = NativeSectorTimeline;

function computeDistanceSectorTimes(packets: TelemetryPacket[], lapTime: number, s1End: number, s2End: number): number[] | null {
  const startDist = packets[0].DistanceTraveled;
  const lapDist = packets[packets.length - 1].DistanceTraveled - startDist;
  if (lapDist < 100) return null;
  let sector = 0;
  let sectorStart = packets[0].CurrentLap;
  let s1 = 0;
  let s2 = 0;
  for (const packet of packets) {
    const fraction = (packet.DistanceTraveled - startDist) / lapDist;
    const expected = fraction < s1End ? 0 : fraction < s2End ? 1 : 2;
    if (expected <= sector) continue;
    const elapsed = packet.CurrentLap - sectorStart;
    if (sector === 0) s1 = elapsed;
    else if (sector === 1) s2 = elapsed;
    sectorStart = packet.CurrentLap;
    sector = expected;
  }
  const s3 = lapTime - s1 - s2;
  return s1 > 0 && s2 > 0 && s3 > 0 ? [s1, s2, s3] : null;
}

export function computeNativeSectorTimeline(
  packets: TelemetryPacket[],
  lapTime: number,
  getLayout: (packet: TelemetryPacket) => { starts: number[]; lapFraction?: number } | undefined,
): NativeSectorTimeline | null {
  const layouts = packets.map(getLayout);
  const starts = layouts.find((layout) => layout?.starts.length)?.starts;
  if (!starts || starts.length < 2 || !Number.isFinite(starts[0]) || starts[0] < 0 || starts[0] >= 1e-6 || starts.some((value, index) => !Number.isFinite(value) || value < 0 || value >= 1 || (index > 0 && value <= starts[index - 1]))) return null;
  const boundaryIndices = starts.slice(1).map((boundary) => layouts.findIndex((layout) => (layout?.lapFraction ?? -1) >= boundary));
  if (boundaryIndices.some((index) => index <= 0)) return null;
  const startTime = packets[0].CurrentLap;
  const times: number[] = [];
  let previousBoundaryTime = 0;
  for (const boundaryIndex of boundaryIndices) {
    const boundaryTime = packets[boundaryIndex].CurrentLap - startTime;
    times.push(boundaryTime - previousBoundaryTime);
    previousBoundaryTime = boundaryTime;
  }
  times.push(lapTime - previousBoundaryTime);
  if (times.some((time) => time <= 0)) return null;
  return { sectorCount: starts.length, times, boundaryIndices, sectorStarts: [...starts] };
}

export function computeIRacingSectorTimeline(packets: TelemetryPacket[], lapTime: number): IRacingSectorTimeline | null {
  return computeNativeSectorTimeline(packets, lapTime, (packet) => {
    const starts = packet.iracing?.sectorStarts;
    if (!starts?.length) return undefined;
    return { starts, lapFraction: packet.iracing?.lapDistancePct };
  });
}

export interface SectorComputationOptions {
  /** Optional host-resolved geometry sectors; otherwise packaged RaceIQ ordinal fallback. */
  sectors?: TrackSectors;
  accLiveSectors?: { s1: number; s2: number };
}

/** Resolve the legacy FM ordinal catalog without loading runtime catalog files. */
export function getPackagedTrackSectorsByOrdinal(ordinal: number): TrackSectors {
  const trackName = TRACK_NAME_BY_ORDINAL[ordinal];
  return trackName ? getTrackSectorsByName(trackName) : DEFAULT_SECTORS;
}

/** Pure sector computation. Explicit host geometry sectors take precedence over packaged fallback. */
export function computeLapSectors(trackOrdinal: number, gameId: GameId, packets: TelemetryPacket[], lapTime: number, options: SectorComputationOptions = {}): number[] | null {
  if (packets.length < 50) return null;
  if (gameId === "iracing") {
    const timeline = computeIRacingSectorTimeline(packets, lapTime);
    return timeline?.times ?? null;
  }
  const { s1End, s2End } = options.sectors ?? getPackagedTrackSectorsByOrdinal(trackOrdinal);
  if (gameId === "lmu") {
    const native = packets.findLast((packet) => (packet.lmu?.lastSector1 ?? 0) > 0 && (packet.lmu?.lastSector2 ?? 0) > 0);
    if (native?.lmu) {
      const s1 = native.lmu.lastSector1;
      const s2 = native.lmu.lastSector2 - s1;
      const s3 = lapTime - native.lmu.lastSector2;
      if (Number.isFinite(lapTime) && s2 > 0 && s3 > 0) return [s1, s2, s3];
    }
  }
  let s1 = 0, s2 = 0;
  if (gameId === "f1-2025") {
    let completedLapNum = 0;
    for (const packet of packets) completedLapNum = Math.max(completedLapNum, packet.LapNumber ?? 0);
    if (completedLapNum > 0) {
      for (let i = packets.length - 1; i >= 0; i--) {
        const entry = packets[i].f1?.lapSectors?.[completedLapNum];
        if (entry && entry.s1 > 0 && entry.s2 > 0 && entry.s3 > 0) { s1 = entry.s1; s2 = entry.s2; break; }
      }
    }
    if (s1 === 0 || s2 === 0) {
      for (const p of packets) {
        if (p.LapNumber !== completedLapNum) continue;
        if ((p.f1?.sector1Time ?? 0) > 0) s1 = p.f1!.sector1Time;
        if ((p.f1?.sector2Time ?? 0) > 0) s2 = p.f1!.sector2Time;
      }
    }
    if (s1 === 0 || s2 === 0) return null;
    const s3 = lapTime - s1 - s2;
    if (s3 <= 0) return null;
    return [s1, s2, s3];
  }
  const accLiveSectors = options.accLiveSectors;
  if (s1 === 0 && s2 === 0 && gameId === "acc" && accLiveSectors && accLiveSectors.s1 > 0 && accLiveSectors.s2 > 0) { s1 = accLiveSectors.s1; s2 = accLiveSectors.s2; }
  if (s1 === 0 && s2 === 0 && gameId === "acc") {
    let prevIdx = packets[0].acc?.currentSectorIndex ?? -1;
    let sectorStart = packets[0].CurrentLap;
    for (const p of packets) {
      const idx = p.acc?.currentSectorIndex ?? prevIdx;
      if (idx !== prevIdx) {
        const elapsed = p.CurrentLap - sectorStart;
        if (prevIdx === 0) s1 = elapsed;
        else if (prevIdx === 1) s2 = elapsed;
        sectorStart = p.CurrentLap;
        prevIdx = idx;
      }
    }
  }
  if (s1 === 0 || s2 === 0) {
    if (packets[0].CurrentLap > 10) return null;
    return computeDistanceSectorTimes(packets, lapTime, s1End, s2End);
  }
  const s3 = lapTime - s1 - s2;
  if (s3 > 0) return [s1, s2, s3];
  return computeDistanceSectorTimes(packets, lapTime, s1End, s2End);
}
