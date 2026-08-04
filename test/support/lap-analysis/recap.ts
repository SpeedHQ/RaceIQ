import { computeRecap, type RecapLapInput, type RecapSessionInput } from "../../../server/lap-analysis/recap";

export const baseSession: RecapSessionInput = {
  id: 1,
  carOrdinal: 10,
  trackOrdinal: 20,
  gameId: "fm-2023",
  createdAt: "2026-07-15T12:00:00.000Z",
};

export function lap(overrides: Partial<RecapLapInput>): RecapLapInput {
  const merged = {
    lapNumber: 1,
    lapTime: 100,
    isValid: true,
    sectorTimes: null,
    ...overrides,
  };
  return { id: overrides.id ?? merged.lapNumber, ...merged };
}

export function run(
  laps: RecapLapInput[],
  opts: Partial<{
    trackLengthM: number | null;
    allTimeBestSec: number | null;
    allTimeBestSectors: Array<number | null> | null;
    carName: string;
    trackName: string;
  }> = {},
) {
  return computeRecap({
    session: baseSession,
    laps,
    carName: opts.carName ?? "2019 Mazda MX-5",
    trackName: opts.trackName ?? "Maple Valley",
    trackLengthM: opts.trackLengthM ?? null,
    allTimeBestSec: opts.allTimeBestSec ?? null,
    allTimeBestSectors: opts.allTimeBestSectors ?? null,
  });
}
