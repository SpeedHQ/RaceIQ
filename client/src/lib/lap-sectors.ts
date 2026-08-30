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
    if (lap.sectorTimes?.length !== sectorCount) continue;
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
