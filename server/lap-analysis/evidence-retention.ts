import { eq } from "drizzle-orm";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { EligibilityDecisionSet, EligibilityPolicyId, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isEligibilitySnapshotCurrent, QUALITY_POLICY_CONFIG_V1, replaceWithUnknownEligibilityDecision } from "../../shared/racing/quality/policies";
import { EVIDENCE_RETENTION_POLICY_VERSION, type EvidenceAvailability, type EvidenceRetentionAssessment } from "../../shared/racing/quality/retention";
import { db } from "../db/index";
import { laps } from "../db/schema";

const RAW_REDECODE_POLICIES = ["lap-comparison", "corner-trace", "transient-event", "ml-training"] as const satisfies readonly EligibilityPolicyId[];

const ELIGIBILITY_POLICY_IDS = Object.keys(QUALITY_POLICY_CONFIG_V1.requiredChannels) as EligibilityPolicyId[];

function availableArchiveSemanticIds(availability: EvidenceAvailability): ReadonlySet<TelemetryVariableId> {
  return new Set(availability.canonicalArchive.state === "available" ? availability.canonicalArchive.semanticIds : []);
}

function unavailableEligibilityDecisions(): EligibilityDecisionSet {
  return Object.fromEntries(
    ELIGIBILITY_POLICY_IDS.map((policyId) => [
      policyId,
      replaceWithUnknownEligibilityDecision(
        {
          policyId,
          policyVersion: QUALITY_POLICY_CONFIG_V1.version,
        },
        "quality_not_rebuilt",
      ),
    ]),
  ) as unknown as EligibilityDecisionSet;
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
  quality?: LapQualitySummary | null;
  qualityGeneration?: string | null;
  qualityStale?: boolean;
  qualitySchemaVersion?: string | null;
  qualityPolicyVersion?: string | null;
  qualityConfigVersion?: string | null;
}

export function evaluateEvidenceRetention(sessionId: number, availability: EvidenceAvailability, rows: readonly EvidenceRetentionLapRow[]): EvidenceRetentionAssessment {
  const canonicalIds = availableArchiveSemanticIds(availability);
  const blockedBy = RAW_REDECODE_POLICIES.filter((policyId) => QUALITY_POLICY_CONFIG_V1.requiredChannels[policyId].some((semanticId) => !canonicalIds.has(semanticId)));
  const currentDecisions = rows.map((row) => (isEligibilitySnapshotCurrent(row) ? row.eligibility! : unavailableEligibilityDecisions()));
  const hasMissingEligibility = currentDecisions.some((current, index) => current !== rows[index]?.eligibility);
  const lapDecisions = rows.map((row, index) => {
    const current = currentDecisions[index]!;
    return {
      lapId: row.id,
      current,
      postRawRemoval: current === row.eligibility ? postRemovalDecisions(current, canonicalIds) : current,
    };
  });
  const canDeleteRaw = rows.length > 0 && !hasMissingEligibility && availability.rawCapture && availability.canonicalArchive.state === "available" && blockedBy.length === 0;
  return {
    sessionId,
    policyVersion: EVIDENCE_RETENTION_POLICY_VERSION,
    action:
      rows.length === 0 || hasMissingEligibility
        ? "quality_unavailable"
        : !availability.rawCapture
          ? "raw_unavailable"
          : canDeleteRaw
            ? "raw_removal_safe"
            : "retain_raw",
    canDeleteRaw,
    reasons: rows.length === 0 || hasMissingEligibility ? ["quality_not_rebuilt"] : blockedBy.length > 0 ? ["raw_redecode_required"] : [],
    blockedBy: rows.length === 0 || hasMissingEligibility ? [] : blockedBy,
    availability,
    laps: lapDecisions,
  };
}

export async function assessEvidenceRetention(sessionId: number, availability: EvidenceAvailability): Promise<EvidenceRetentionAssessment> {
  const rows = await db
    .select({
      id: laps.id,
      eligibility: laps.eligibility,
      quality: laps.quality,
      qualityGeneration: laps.qualityGeneration,
      qualitySchemaVersion: laps.qualitySchemaVersion,
      qualityPolicyVersion: laps.qualityPolicyVersion,
      qualityConfigVersion: laps.qualityConfigVersion,
    })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .all();
  return evaluateEvidenceRetention(sessionId, availability, rows);
}
