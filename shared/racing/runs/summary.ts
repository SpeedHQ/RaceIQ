import type { RaceEventId } from "../events/contracts";
import type { LapCondition, LapPhase } from "../laps/classification";
import { repeatabilityStats, stintStats } from "../laps/stint-stats";
import type {
  EligibilityDecisionSet,
  LapQualitySummary,
} from "../quality/contracts";
import {
  evaluateAllEligibility,
  evaluateGroupEligibility,
  isEligibilityUsable,
  resolveEligibilityDecision,
} from "../quality/policies";
import type { LapMeta } from "../sessions/types";
import type {
  SessionRunId,
  SessionRunKind,
  SessionRunSummary,
} from "./contracts";

export interface CompletedSessionRunLap {
  lapEventId: RaceEventId;
  lapId: number | null;
  lapNumber: number;
  lapTimeMs: number | null;
  isValid: boolean;
  phase: LapPhase;
  conditions: readonly LapCondition[];
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
  qualityGeneration?: string | null;
  qualityStale?: boolean;
  qualitySchemaVersion?: string | null;
  qualityPolicyVersion?: string | null;
  qualityConfigVersion?: string | null;
}

export interface SessionRunSummaryInput {
  runId: SessionRunId;
  runKind: SessionRunKind;
  laps: readonly CompletedSessionRunLap[];
  membershipCount?: number;
  qualityLimitations?: readonly string[];
}

const NON_DATA_QUALITY_EXCLUSIONS: Record<string, true> = {
  caution_context: true,
  traffic_context: true,
  incident_lap: true,
  non_pace_classification: true,
  structurally_invalid: true,
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function deriveSessionRunSummary({
  runId,
  runKind,
  laps,
  membershipCount = laps.length,
  qualityLimitations = [],
}: SessionRunSummaryInput): SessionRunSummary {
  const limitations = new Set(qualityLimitations);
  const lapMetadata: LapMeta[] = [];
  const normalPaceTimes: number[] = [];
  let validLapCount = 0;
  let normalPaceLapCount = 0;
  let cautionLapCount = 0;
  let outLapCount = 0;
  let inLapCount = 0;
  let pitLapCount = 0;
  let trafficLapCount = 0;
  let incidentLapCount = 0;
  let dataQualityExcludedLapCount = 0;

  for (const lap of laps) {
    if (lap.isValid) validLapCount += 1;
    if (lap.conditions.includes("caution")) cautionLapCount += 1;
    if (lap.phase === "out") outLapCount += 1;
    if (lap.phase === "in") inLapCount += 1;
    if (lap.phase === "pit") pitLapCount += 1;

    const qualityCodes = new Set(
      lap.quality?.facts.map((fact) => fact.code) ?? [],
    );
    if (qualityCodes.has("traffic_context")) trafficLapCount += 1;
    if (qualityCodes.has("incident_lap")) incidentLapCount += 1;

    const lapTimeS = lap.lapTimeMs == null ? Number.NaN : lap.lapTimeMs / 1_000;
    const normalPace = resolveEligibilityDecision(lap, "normal-pace");
    if (
      Number.isFinite(lapTimeS) &&
      lapTimeS > 0 &&
      isEligibilityUsable(normalPace)
    ) {
      normalPaceLapCount += 1;
      normalPaceTimes.push(lapTimeS);
    } else if (
      normalPace.reasons.some(
        ({ code }) => !NON_DATA_QUALITY_EXCLUSIONS[code],
      )
    ) {
      dataQualityExcludedLapCount += 1;
    }

    lapMetadata.push({
      id: lap.lapId ?? -(lap.lapNumber + 1),
      sessionId: 0,
      lapNumber: lap.lapNumber,
      lapTime: lapTimeS,
      isValid: lap.isValid,
      createdAt: "1970-01-01T00:00:00.000Z",
      phase: lap.phase,
      conditions: [...lap.conditions],
      paceEligibility:
        lap.phase === "flying" && lap.conditions.length === 0
          ? "eligible"
          : "excluded",
      quality: lap.quality ?? undefined,
      eligibility: lap.eligibility ?? undefined,
      qualityGeneration: lap.qualityGeneration ?? undefined,
      qualityStale: lap.qualityStale,
    });
  }

  if (laps.length < membershipCount) limitations.add("lap_metadata_unavailable");
  if (normalPaceTimes.length === 0) limitations.add("normal_pace_unavailable");
  if (normalPaceTimes.length < 2) limitations.add("repeatability_unavailable");

  const repeatability = repeatabilityStats(normalPaceTimes);
  const statistics = stintStats(
    lapMetadata,
    runKind === "pace" ? runId : null,
  );
  const falloffLaps = laps.flatMap((lap) => {
    if (!lap.quality || lap.lapTimeMs == null || lap.lapTimeMs <= 0) return [];
    const normalPace = resolveEligibilityDecision(lap, "normal-pace");
    return [
      {
        lapId: lap.lapId ?? undefined,
        lapTime: lap.lapTimeMs / 1_000,
        quality: lap.quality,
        eligibility: {
          ...evaluateAllEligibility(lap.quality),
          ...lap.eligibility,
          "normal-pace": normalPace,
        },
      },
    ];
  });
  const falloffEligibility = evaluateGroupEligibility(
    "stint-falloff",
    falloffLaps,
    { paceSegmentId: runKind === "pace" ? runId : null },
  ) as SessionRunSummary["falloffEligibility"];
  const falloffUsable =
    falloffEligibility.status === "eligible" ||
    falloffEligibility.status === "eligible_with_warning";
  const degradationSlopeSPerLap =
    runKind === "pace" && falloffUsable
      ? (statistics.degSlopeSPerLap ?? null)
      : null;
  if (degradationSlopeSPerLap === null) limitations.add("falloff_unavailable");

  return {
    membershipCount,
    completedLapCount: laps.length,
    validLapCount,
    normalPaceLapCount,
    cautionLapCount,
    outLapCount,
    inLapCount,
    pitLapCount,
    trafficLapCount,
    incidentLapCount,
    dataQualityExcludedLapCount,
    bestLapTimeS:
      normalPaceTimes.length === 0 ? null : Math.min(...normalPaceTimes),
    medianLapTimeS: median(normalPaceTimes),
    meanLapTimeS: repeatability.mean,
    standardDeviationS: repeatability.sd,
    consistency: repeatability.consistency,
    degradationSlopeSPerLap,
    falloffEligibility,
    qualityLimitations: [...limitations].sort(),
  };
}
