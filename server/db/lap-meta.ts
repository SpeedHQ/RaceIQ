import type { GameId } from "../../shared/games/ids";
import type { LapMeta } from "../../shared/sessions/types";

type StoredLapMetaRow = {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean | number;
  invalidReason: string | null;
  notes: string | null;
  pi: number | null;
  carSetup: string | null;
  createdAt: string;
  carOrdinal: number;
  trackOrdinal: number;
  tuneId: number | null;
  tuneName: string | null;
  gameId: string;
  sectorTimes: number[] | null;
  source: string | null;
  experimentId: number | null;
  experimentVersionId: number | null;
  experimentExcluded: boolean | number | null;
  experimentExcludedSource: string | null;
  fuelPerLap: number | null;
  tyreWear: number | null;
  catalogVersion?: string | null;
  catalogHash?: string | null;
  catalogSchemaVersion?: string | null;
  parserVersion?: string | null;
  resolverVersion?: string | null;
  derivationVersion?: string | null;
  rawFrameCount?: number | null;
};

/** Normalize nullable SQLite fields into the public LapMeta representation. */
export function toLapMeta(row: StoredLapMetaRow): LapMeta {
  const {
    isValid,
    invalidReason,
    notes,
    pi,
    carSetup,
    tuneId,
    tuneName,
    gameId,
    sectorTimes,
    source,
    experimentId,
    experimentVersionId,
    experimentExcluded,
    experimentExcludedSource,
    fuelPerLap,
    tyreWear,
    catalogVersion,
    catalogHash,
    catalogSchemaVersion,
    parserVersion,
    resolverVersion,
    derivationVersion,
    rawFrameCount,
    ...base
  } = row;

  const versionIdentity = "catalogVersion" in row
    ? {
        catalogVersion: catalogVersion ?? undefined,
        catalogHash: catalogHash ?? undefined,
        catalogSchemaVersion: catalogSchemaVersion ?? undefined,
        parserVersion: parserVersion ?? undefined,
        resolverVersion: resolverVersion ?? undefined,
        derivationVersion: derivationVersion ?? undefined,
      }
    : {};
  const frameCount = "rawFrameCount" in row
    ? { rawFrameCount: rawFrameCount ?? null }
    : {};

  return {
    ...base,
    isValid: Boolean(isValid),
    invalidReason: invalidReason ?? undefined,
    notes: notes ?? undefined,
    pi: pi ?? 0,
    carSetup: carSetup ?? undefined,
    tuneId: tuneId ?? undefined,
    tuneName: tuneName ?? undefined,
    gameId: gameId as GameId,
    sectorTimes: sectorTimes ?? undefined,
    source: (source as "motec" | null) ?? null,
    experimentId: experimentId ?? null,
    experimentVersionId: experimentVersionId ?? null,
    experimentExcluded: Boolean(experimentExcluded),
    // Manual provenance must travel with the flag or review selection can
    // incorrectly rank an excluded lap back into the fastest-N pool.
    experimentExcludedSource:
      (experimentExcludedSource as "auto" | "manual" | null) ?? null,
    fuelPerLap: fuelPerLap ?? null,
    tyreWear: tyreWear ?? null,
    ...versionIdentity,
    ...frameCount,
  };
}
