import { eq } from "drizzle-orm";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { EligibilityDecisionSet, EligibilityPolicyId } from "../../shared/racing/quality/contracts";
import { QUALITY_POLICY_CONFIG_V1, replaceWithUnknownEligibilityDecision } from "../../shared/racing/quality/policies";
import { EVIDENCE_RETENTION_POLICY_VERSION, type EvidenceAvailability, type EvidenceRetentionAssessment } from "../../shared/racing/quality/retention";
import { db } from "../db/index";
import { laps } from "../db/schema";

const RAW_REDECODE_POLICIES = ["lap-comparison", "corner-trace", "transient-event", "ml-training"] as const satisfies readonly EligibilityPolicyId[];

function availableArchiveSemanticIds(availability: EvidenceAvailability): ReadonlySet<TelemetryVariableId> {
  return new Set(availability.canonicalArchive.state === "available" ? availability.canonicalArchive.semanticIds : []);
}

function postRemovalDecisions(current: EligibilityDecisionSet, canonicalIds: ReadonlySet<TelemetryVariableId>): EligibilityDecisionSet {
  const postRemoval = { ...current };
  for (const policyId of RAW_REDECODE_POLICIES) {
    const required = QUALITY_POLICY_CONFIG_V1.requiredChannels[policyId];
    if (required.every((semanticId) => canonicalIds.has(semanticId))) continue;
    postRemoval[policyId] = replaceWithUnknownEligibilityDecision(
      current[policyId],
      "raw_redecode_required",
      required.filter((semanticId) => !canonicalIds.has(semanticId)),
    );
  }
  return postRemoval;
}

export interface EvidenceRetentionLapRow {
  id: number;
  eligibility: EligibilityDecisionSet | null;
}

export function evaluateEvidenceRetention(sessionId: number, availability: EvidenceAvailability, rows: readonly EvidenceRetentionLapRow[]): EvidenceRetentionAssessment {
  const qualityRows = rows.filter((row): row is EvidenceRetentionLapRow & { eligibility: EligibilityDecisionSet } => row.eligibility != null);
  if (qualityRows.length === 0) {
    return {
      sessionId,
      policyVersion: EVIDENCE_RETENTION_POLICY_VERSION,
      action: "quality_unavailable",
      canDeleteRaw: false,
      reasons: ["quality_not_rebuilt"],
      blockedBy: [],
      availability,
      laps: [],
    };
  }

  const canonicalIds = availableArchiveSemanticIds(availability);
  const blockedBy = RAW_REDECODE_POLICIES.filter((policyId) => QUALITY_POLICY_CONFIG_V1.requiredChannels[policyId].some((semanticId) => !canonicalIds.has(semanticId)));
  const lapDecisions = qualityRows.map((row) => ({
    lapId: row.id,
    current: row.eligibility,
    postRawRemoval: postRemovalDecisions(row.eligibility, canonicalIds),
  }));
  const canDeleteRaw = availability.rawCapture && availability.canonicalArchive.state === "available" && blockedBy.length === 0;
  return {
    sessionId,
    policyVersion: EVIDENCE_RETENTION_POLICY_VERSION,
    action: !availability.rawCapture ? "raw_unavailable" : canDeleteRaw ? "raw_removal_safe" : "retain_raw",
    canDeleteRaw,
    reasons: blockedBy.length > 0 ? ["raw_redecode_required"] : [],
    blockedBy,
    availability,
    laps: lapDecisions,
  };
}

export async function assessEvidenceRetention(sessionId: number, availability: EvidenceAvailability): Promise<EvidenceRetentionAssessment> {
  const rows = await db.select({ id: laps.id, eligibility: laps.eligibility }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  return evaluateEvidenceRetention(sessionId, availability, rows);
}
