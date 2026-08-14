import { computeRecap, type RecapLapInput, type RecapSessionInput } from "../../../server/lap-analysis/recap";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type EligibilityStatus,
  type LapQualitySummary,
} from "../../../shared/racing/quality/contracts";

export const baseSession: RecapSessionInput = {
  id: 1,
  carOrdinal: 10,
  trackOrdinal: 20,
  gameId: "fm-2023",
  createdAt: "2026-07-15T12:00:00.000Z",
};

export function normalPaceEligibility(status: EligibilityStatus): EligibilityDecisionSet {
  return {
    "normal-pace": {
      policyId: "normal-pace",
      policyVersion: "1",
      status,
      confidence: { level: status === "unknown" ? "unknown" : "high", score: status === "unknown" ? null : 1 },
      reasons: [],
      evidenceIds: [],
    },
  } as unknown as EligibilityDecisionSet;
}
export function currentQualityEvidence(generation = "sha256:recap-quality"): Pick<
  RecapLapInput,
  "quality" | "qualityGeneration" | "qualitySchemaVersion" | "qualityPolicyVersion" | "qualityConfigVersion"
> {
  return {
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        sourceGeneration: "sha256:recap-source",
        outputGeneration: generation,
      },
    } as unknown as LapQualitySummary,
    qualityGeneration: generation,
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
  };
}

export function lap(overrides: Partial<RecapLapInput>): RecapLapInput {
  const isValid = overrides.isValid ?? true;
  const paceEligibility = overrides.paceEligibility ?? "eligible";
  const eligibility = overrides.eligibility ?? normalPaceEligibility(isValid && paceEligibility === "eligible" ? "eligible" : "ineligible");
  const merged = {
    lapNumber: 1,
    lapTime: 100,
    isValid,
    phase: "flying" as const,
    conditions: [],
    paceEligibility,
    eligibility,
    ...currentQualityEvidence(),
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
