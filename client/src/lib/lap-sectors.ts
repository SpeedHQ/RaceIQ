export interface StoredSectorTimes {
  sectorTimes?: number[] | null;
}

export interface IdentifiedSectorTimes extends StoredSectorTimes {
  id: number;
  lapNumber: number;
}

export function bestSectorLapIds(laps: readonly IdentifiedSectorTimes[], sectorCount: number): (number | null)[] {
  const bestLapIds = Array<number | null>(sectorCount).fill(null);
  const bestTimes = Array<number>(sectorCount).fill(Infinity);
  const bestLapNumbers = Array<number>(sectorCount).fill(Infinity);

  for (const lap of laps) {
    for (let index = 0; index < sectorCount; index++) {
      const time = lap.sectorTimes?.[index] ?? 0;
      if (time <= 0) continue;

      const isFaster = time < bestTimes[index];
      const isEarlierTie = time === bestTimes[index] && (lap.lapNumber < bestLapNumbers[index] || (lap.lapNumber === bestLapNumbers[index] && lap.id < (bestLapIds[index] ?? Infinity)));
      if (!isFaster && !isEarlierTie) continue;

      bestTimes[index] = time;
      bestLapNumbers[index] = lap.lapNumber;
      bestLapIds[index] = lap.id;
    }
  }

  return bestLapIds;
}

export interface SectorTimeline {
  times: number[];
  sectorCount: number;
  boundaryIndices: number[];
  sectorStarts: number[];
  firstDist: number;
  lapDist: number;
}

export function storedLapSectorCount(lap: StoredSectorTimes): number {
  return lap.sectorTimes?.length ?? 0;
}

export function storedLapsSectorCount(laps: readonly StoredSectorTimes[]): number {
  return laps.reduce((count, lap) => Math.max(count, storedLapSectorCount(lap)), 0);
}

/** Invalid or incomplete laps must never establish recorded PBs. */
export function validLapBests(laps: readonly (StoredSectorTimes & { isValid: boolean; lapTime: number })[], sectorCount: number): { lapTime: number; sectors: number[] } {
  const valid = laps.filter((lap) => lap.isValid && Number.isFinite(lap.lapTime) && lap.lapTime > 0);
  const times = valid.map((lap) => lap.lapTime);
  return {
    lapTime: times.length ? Math.min(...times) : 0,
    sectors: Array.from({ length: sectorCount }, (_, index) => {
      const splits = valid.map((lap) => lap.sectorTimes?.[index] ?? 0).filter((time) => Number.isFinite(time) && time > 0);
      return splits.length ? Math.min(...splits) : 0;
    }),
  };
}
