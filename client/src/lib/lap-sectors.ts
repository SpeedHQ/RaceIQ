export interface StoredSectorTimes {
  sectorTimes?: number[] | null;
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
