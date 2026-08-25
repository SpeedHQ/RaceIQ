import { laps, sessions, tunes } from "./schema";

import type { GameId } from "../../shared/games/ids";
import type { LapCondition, LapPhase, PaceEligibility } from "../../shared/racing/laps/classification";
import type { LapMeta } from "../../shared/racing/sessions/types";
import {
  normalizeEvidenceSourceKind,
  type EligibilityDecisionSet,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { isEligibilitySnapshotCurrent } from "../../shared/racing/quality/policies";

export const lapMetaProjection = {
  id: laps.id,
  sessionId: laps.sessionId,
  lapNumber: laps.lapNumber,
  lapTime: laps.lapTime,
  isValid: laps.isValid,
  phase: laps.phase,
  conditions: laps.conditions,
  paceEligibility: laps.paceEligibility,
  invalidReason: laps.invalidReason,
  notes: laps.notes,
  pi: laps.pi,
  carSetup: laps.carSetup,
  createdAt: laps.createdAt,
  carOrdinal: sessions.carOrdinal,
  trackOrdinal: sessions.trackOrdinal,
  tuneId: laps.tuneId,
  tuneName: tunes.name,
  gameId: sessions.gameId,
  sectorTimes: laps.sectorTimes,
  source: sessions.source,
  ownership: sessions.ownership,
  experimentId: laps.experimentId,
  experimentVersionId: laps.experimentVersionId,
  experimentExcluded: laps.experimentExcluded,
  experimentExcludedSource: laps.experimentExcludedSource,
  fuelPerLap: laps.fuelPerLap,
  tyreWear: laps.tyreWear,
  catalogVersion: laps.catalogVersion,
  catalogHash: laps.catalogHash,
  catalogSchemaVersion: laps.catalogSchemaVersion,
  parserVersion: laps.parserVersion,
  resolverVersion: laps.resolverVersion,
  derivationVersion: laps.derivationVersion,
  rawFrameCount: laps.rawFrameCount,
  quality: laps.quality,
  eligibility: laps.eligibility,
  qualitySchemaVersion: laps.qualitySchemaVersion,
  qualityPolicyVersion: laps.qualityPolicyVersion,
  qualityConfigVersion: laps.qualityConfigVersion,
  qualityGeneration: laps.qualityGeneration,
};

type StoredLapMetaRow = {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean | number;
  phase: LapPhase;
  conditions: LapCondition[];
  paceEligibility: PaceEligibility;
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
  catalogVersion: string | null;
  catalogHash: string | null;
  catalogSchemaVersion: string | null;
  parserVersion: string | null;
  resolverVersion: string | null;
  derivationVersion: string | null;
  rawFrameCount: number | null;
  ownership: string | null;
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
  qualitySchemaVersion: string | null;
  qualityPolicyVersion: string | null;
  qualityConfigVersion: string | null;
  qualityGeneration: string | null;
};

/** Normalize nullable SQLite fields into the public LapMeta representation. */
export function toLapMeta(row: StoredLapMetaRow): LapMeta {
  const {
    isValid,
    phase,
    conditions,
    paceEligibility,
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
    ownership,
    rawFrameCount,
    quality,
    eligibility,
    qualitySchemaVersion,
    qualityPolicyVersion,
    qualityConfigVersion,
    qualityGeneration,
    ...base
  } = row;

  return {
    ...base,
    isValid: Boolean(isValid),
    phase,
    conditions,
    paceEligibility,
    invalidReason: invalidReason ?? undefined,
    notes: notes ?? undefined,
    pi: pi ?? 0,
    carSetup: carSetup ?? undefined,
    tuneId: tuneId ?? undefined,
    tuneName: tuneName ?? undefined,
    gameId: gameId as GameId,
    sectorTimes: sectorTimes ?? undefined,
    source: normalizeEvidenceSourceKind(source),
    ownership: ownership === "others" ? "others" : "mine",
    experimentId: experimentId ?? null,
    experimentVersionId: experimentVersionId ?? null,
    experimentExcluded: Boolean(experimentExcluded),
    // Manual provenance must travel with the flag or review selection can
    // incorrectly rank an excluded lap back into the fastest-N pool.
    experimentExcludedSource: (experimentExcludedSource as "auto" | "manual" | null) ?? null,
    fuelPerLap: fuelPerLap ?? null,
    tyreWear: tyreWear ?? null,
    catalogVersion: catalogVersion ?? undefined,
    catalogHash: catalogHash ?? undefined,
    catalogSchemaVersion: catalogSchemaVersion ?? undefined,
    parserVersion: parserVersion ?? undefined,
    resolverVersion: resolverVersion ?? undefined,
    derivationVersion: derivationVersion ?? undefined,
    rawFrameCount: rawFrameCount ?? null,
    quality: quality ?? undefined,
    eligibility: eligibility ?? undefined,
    qualityGeneration: qualityGeneration ?? undefined,
    qualityStale:
      quality != null &&
      !isEligibilitySnapshotCurrent({
        quality,
        eligibility,
        qualityGeneration,
        qualitySchemaVersion,
        qualityPolicyVersion,
        qualityConfigVersion,
      }),
  };
}
