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

function replaceFactProvenance(facts: readonly QualityFact[], provenance: QualityProvenance): QualityFact[] {
  return facts.map((fact) => ({ ...fact, provenance }));
}
export function combineQualityGenerations(generations: readonly string[]): string {
  return generation({ kind: "quality-cache", generations: [...generations].sort() });
}

export function finalizeRecordingQualityGeneration(summary: RecordingQualitySummary): RecordingQualitySummary {
  const archiveGeneration = summary.archiveVerification.sourceGeneration;
  const sourceGeneration =
    archiveGeneration === "legacy"
      ? "legacy"
      : generation({
          archiveGeneration,
          participant: summary.participant,
          sourceKind: summary.sourceKind,
          versionIdentity: summary.versionIdentity,
        });
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
  sessionSourceGeneration: string,
  identity: {
    lapNumber: number;
    rawByteOffset: number | null;
    rawFrameCount: number;
  },
): { quality: LapQualitySummary; eligibility: EligibilityDecisionSet } {
  const sourceGeneration =
    sessionSourceGeneration === "legacy"
      ? "legacy"
      : generation({
          identity,
          participant: quality.participant,
          sessionSourceGeneration,
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
