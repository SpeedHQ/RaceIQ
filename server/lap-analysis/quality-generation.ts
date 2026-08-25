import { createHash } from "node:crypto";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type LapQualitySummary,
  type QualityFact,
  type QualityProvenance,
  type RecordingQualitySummary,
} from "../../shared/racing/quality/contracts";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function generation(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}
const FINALIZED_SOURCE_GENERATION_PATTERN = /^sha256:[0-9a-f]{64}$/;


const RECORDING_LAP_FACT_CODES: Partial<Record<QualityFact["code"], true>> = {
  recording_corrupt: true,
  recording_incompatible: true,
  recording_incomplete: true,
  recording_unavailable: true,
  source_reconnect: true,
  telemetry_gap_minor: true,
  telemetry_gap_major: true,
  timeline_discontinuity: true,
  out_of_order_observations: true,
  writer_drop: true,
};

const SESSION_WIDE_FACT_CODES: Partial<Record<QualityFact["code"], true>> = {
  recording_corrupt: true,
  recording_incompatible: true,
  recording_unavailable: true,
};

const LAP_MEASURED_FACT_CODES: Partial<Record<QualityFact["code"], true>> = {
  telemetry_gap_minor: true,
  telemetry_gap_major: true,
  timeline_discontinuity: true,
  out_of_order_observations: true,
};

function requireFinalizedSourceGeneration(
  sourceGeneration: string | null,
  subject: "recording" | "session",
): string {
  if (!sourceGeneration || !FINALIZED_SOURCE_GENERATION_PATTERN.test(sourceGeneration)) {
    throw new Error(`${subject} source generation must be sha256: plus 64 lowercase hex characters`);
  }
  return sourceGeneration;
}

function timeRangesOverlap(
  left: NonNullable<QualityFact["timeRange"]>,
  right: NonNullable<QualityFact["timeRange"]>,
): boolean {
  return left.startMs <= right.endMs && right.startMs <= left.endMs;
}

function factAppliesToLap(fact: QualityFact, lapRange: LapQualitySummary["timeRange"]): boolean {
  if (!RECORDING_LAP_FACT_CODES[fact.code]) return false;
  if (SESSION_WIDE_FACT_CODES[fact.code]) return true;
  if (!fact.timeRange || !lapRange) return true;
  return timeRangesOverlap(fact.timeRange, lapRange);
}

function isDuplicateLapMeasurement(fact: QualityFact, lapFacts: readonly QualityFact[]): boolean {
  return (
    LAP_MEASURED_FACT_CODES[fact.code] === true &&
    fact.timeRange != null &&
    lapFacts.some(
      (lapFact) =>
        lapFact.code === fact.code &&
        lapFact.timeRange != null &&
        timeRangesOverlap(lapFact.timeRange, fact.timeRange!),
    )
  );
}

function lifecycleWithoutSessionFacts(
  quality: LapQualitySummary,
  facts: readonly QualityFact[],
): LapQualitySummary["lifecycleState"] {
  if (!quality.complete) return "incomplete";
  if (quality.gapSummary.observedCount === 0) return "unavailable";
  if (
    facts.some(
      ({ code }) =>
        code === "telemetry_gap_major" ||
        code === "timeline_discontinuity" ||
        code === "out_of_order_observations" ||
        code === "writer_drop" ||
        code === "source_reconnect",
    )
  ) {
    return "degraded";
  }
  if (facts.some(({ code }) => code === "telemetry_gap_minor")) return "minor_gaps";
  return "exact";
}

function lifecycleWithRecordingFacts(
  quality: LapQualitySummary,
  facts: readonly QualityFact[],
): LapQualitySummary["lifecycleState"] {
  if (facts.some(({ code }) => code === "recording_corrupt")) return "corrupt";
  if (facts.some(({ code }) => code === "recording_incompatible")) return "incompatible";
  if (facts.some(({ code }) => code === "recording_unavailable")) return "unavailable";
  if (facts.some(({ code }) => code === "recording_incomplete")) return "incomplete";
  return lifecycleWithoutSessionFacts(quality, facts);
}

export function mergeRecordingQualityIntoLapQuality(
  recording: RecordingQualitySummary,
  lap: LapQualitySummary,
): LapQualitySummary {
  const lapFacts = lap.facts.filter(({ id }) => !id.startsWith("session:"));
  const sessionFacts = recording.facts
    .filter((fact) => factAppliesToLap(fact, lap.timeRange))
    .filter((fact) => !isDuplicateLapMeasurement(fact, lapFacts))
    .map((fact) => ({ ...fact, id: `session:${fact.id}` }));
  const facts = [...lapFacts, ...sessionFacts];
  return {
    ...lap,
    facts,
    lifecycleState: lifecycleWithRecordingFacts(lap, facts),
  };
}

function replaceFactProvenance(facts: readonly QualityFact[], provenance: QualityProvenance): QualityFact[] {
  return facts.map((fact) => ({ ...fact, provenance }));
}
export function combineQualityGenerations(generations: readonly string[]): string {
  return generation({ kind: "quality-cache", generations: [...generations].sort() });
}

export function finalizeRecordingQualityGeneration(
  summary: RecordingQualitySummary,
): RecordingQualitySummary {
  const sourceGeneration = requireFinalizedSourceGeneration(
    summary.canonicalVerification?.sourceGeneration ??
      summary.archiveVerification.sourceGeneration,
    "recording",
  );
  const draftProvenance: QualityProvenance = {
    ...summary.provenance,
    schemaVersion: QUALITY_SCHEMA_VERSION,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    configurationVersion: QUALITY_CONFIG_VERSION,
    sourceGeneration,
    outputGeneration: "",
  };
  const draft: RecordingQualitySummary = {
    ...summary,
    facts: replaceFactProvenance(summary.facts, draftProvenance),
    provenance: draftProvenance,
  };
  const outputGeneration = generation({ kind: "recording-quality", summary: draft });
  const provenance = { ...draftProvenance, outputGeneration };
  return {
    ...draft,
    facts: replaceFactProvenance(draft.facts, provenance),
    provenance,
  };
}

export function finalizeLapQualityGeneration(
  quality: LapQualitySummary,
  sessionSourceGeneration: string | null,
  identity: {
    lapNumber: number;
    rawByteOffset: number | null;
    rawFrameCount: number | null;
  },
): { quality: LapQualitySummary; eligibility: EligibilityDecisionSet } {
  const finalizedSessionSourceGeneration = requireFinalizedSourceGeneration(
    sessionSourceGeneration,
    "session",
  );
  const sourceGeneration = generation({
    identity,
    participant: quality.participant,
    sessionSourceGeneration: finalizedSessionSourceGeneration,
    sourceKind: quality.sourceKind,
    versionIdentity: quality.versionIdentity,
  });
  const draftProvenance: QualityProvenance = {
    ...quality.provenance,
    schemaVersion: QUALITY_SCHEMA_VERSION,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    configurationVersion: QUALITY_CONFIG_VERSION,
    sourceGeneration,
    outputGeneration: "",
  };
  const draftQuality: LapQualitySummary = {
    ...quality,
    facts: replaceFactProvenance(quality.facts, draftProvenance),
    provenance: draftProvenance,
  };
  const eligibility = evaluateAllEligibility(draftQuality);
  const outputGeneration = generation({
    eligibility,
    kind: "lap-quality",
    quality: draftQuality,
  });
  const provenance = { ...draftProvenance, outputGeneration };
  return {
    quality: {
      ...draftQuality,
      facts: replaceFactProvenance(draftQuality.facts, provenance),
      provenance,
    },
    eligibility,
  };
}
