import type { EligibilityDecisionSet, EligibilityPolicyId, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { eligibilityDecisionText, qualityReasonText } from "../../shared/racing/quality/display";
import { resolveEligibilityDecision } from "../../shared/racing/quality/policies";

export interface QualityPromptEvidence {
  quality?: LapQualitySummary | null;
  eligibility?: Partial<EligibilityDecisionSet> | null;
  qualityGeneration?: string | null;
}

export function buildQualityPromptContext(evidence: QualityPromptEvidence, policyIds: readonly EligibilityPolicyId[]): string {
  const lines = ["--- TELEMETRY QUALITY AND ANALYSIS LIMITS ---"];
  for (const policyId of policyIds) {
    const decision = resolveEligibilityDecision(evidence, policyId);
    lines.push(`${policyId}: ${decision.status}; confidence=${decision.confidence.level}; ${eligibilityDecisionText(decision)}`);
    for (const reason of decision.reasons) {
      lines.push(`- ${reason.code}: ${qualityReasonText(reason.code, reason.timeRange, reason.distanceRange)}`);
    }
  }
  lines.push(`quality-generation: ${evidence.qualityGeneration ?? evidence.quality?.provenance.outputGeneration ?? "unknown"}`);
  lines.push("Do not make conclusions from ineligible or unknown evidence. For warning decisions, state limits and avoid claims inside affected ranges.");
  return lines.join("\n");
}
