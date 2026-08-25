import { and, eq, inArray } from "drizzle-orm";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { EligibilityDecisionSet, EligibilityPolicyId, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isEligibilitySnapshotCurrent, QUALITY_POLICY_CONFIG_V1, replaceWithUnknownEligibilityDecision } from "../../shared/racing/quality/policies";
import { EVIDENCE_RETENTION_POLICY_VERSION, type EvidenceAvailability, type EvidenceRetentionAssessment } from "../../shared/racing/quality/retention";
import { db } from "../db/index";
import { canonicalArchiveNodes, laps, sessions } from "../db/schema";
import { inspectRawCaptureIdentity } from "../session-capture/identity";

const RAW_REDECODE_POLICIES = ["lap-comparison", "corner-trace", "transient-event", "ml-training"] as const satisfies readonly EligibilityPolicyId[];

const ELIGIBILITY_POLICY_IDS = Object.keys(QUALITY_POLICY_CONFIG_V1.requiredChannels) as EligibilityPolicyId[];

function availableArchiveSemanticIds(availability: EvidenceAvailability): ReadonlySet<TelemetryVariableId> {
  return new Set(availability.canonicalArchive.state === "available" ? availability.canonicalArchive.semanticIds : []);
}

function rawMatchesArchiveSource(availability: EvidenceAvailability): boolean {
  const { canonicalArchive, rawSourceIdentity } = availability;
  return availability.rawCapture
    && rawSourceIdentity != null
    && canonicalArchive.state === "available"
    && canonicalArchive.provenance != null
    && rawSourceIdentity === canonicalArchive.provenance.sourceIdentity;
}

function unavailableEligibilityDecisions(reason: "quality_not_rebuilt" | "quality_stale"): EligibilityDecisionSet {
  return Object.fromEntries(
    ELIGIBILITY_POLICY_IDS.map((policyId) => [
      policyId,
      replaceWithUnknownEligibilityDecision(
        {
          policyId,
          policyVersion: QUALITY_POLICY_CONFIG_V1.version,
        },
        reason,
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

export function evaluateEvidenceRetention(
  sessionId: number,
  availability: EvidenceAvailability,
  rows: readonly EvidenceRetentionLapRow[],
  archiveLapsReadable = false,
): EvidenceRetentionAssessment {
  const canonicalIds = availableArchiveSemanticIds(availability);
  const blockedBy = RAW_REDECODE_POLICIES.filter((policyId) => QUALITY_POLICY_CONFIG_V1.requiredChannels[policyId].some((semanticId) => !canonicalIds.has(semanticId)));
  const snapshotCurrent = rows.map((row) => isEligibilitySnapshotCurrent(row));
  const qualityUnavailableReasons = [
    ...new Set(rows.flatMap((row, index) => (snapshotCurrent[index] ? [] : [row.qualityStale === true ? ("quality_stale" as const) : ("quality_not_rebuilt" as const)]))),
  ];
  const currentDecisions = rows.map((row, index) => (snapshotCurrent[index] ? row.eligibility! : unavailableEligibilityDecisions(row.qualityStale === true ? "quality_stale" : "quality_not_rebuilt")));
  const hasUnavailableEligibility = qualityUnavailableReasons.length > 0;
  const lapDecisions = rows.map((row, index) => {
    const current = currentDecisions[index]!;
    return {
      lapId: row.id,
      current,
      postRawRemoval: current === row.eligibility ? postRemovalDecisions(current, canonicalIds) : current,
    };
  });
  const archiveComplete = availability.canonicalArchive.completeness === "complete" && availability.canonicalArchive.status === "verified";
  const archiveSupportsCurrentLaps = rows.length > 0 && archiveLapsReadable;
  const canDeleteRaw = !hasUnavailableEligibility
    && rawMatchesArchiveSource(availability)
    && archiveComplete
    && archiveSupportsCurrentLaps
    && blockedBy.length === 0;
  return {
    sessionId,
    policyVersion: EVIDENCE_RETENTION_POLICY_VERSION,
    action: rows.length === 0 || hasUnavailableEligibility ? "quality_unavailable" : !availability.rawCapture ? "raw_unavailable" : canDeleteRaw ? "raw_removal_safe" : "retain_raw",
    canDeleteRaw,
    reasons: rows.length === 0
      ? ["quality_not_rebuilt"]
      : hasUnavailableEligibility
        ? qualityUnavailableReasons
        : blockedBy.length > 0 || !rawMatchesArchiveSource(availability) || !archiveSupportsCurrentLaps
          ? ["raw_redecode_required"]
          : [],
    blockedBy: rows.length === 0 || hasUnavailableEligibility ? [] : blockedBy,
    availability,
    laps: lapDecisions,
  };
}

export async function assessEvidenceRetention(sessionId: number, availability: EvidenceAvailability): Promise<EvidenceRetentionAssessment> {
  const [rows, session] = await Promise.all([
    db
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
      .all(),
    db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get(),
  ]);
  const raw = availability.rawCapture && session?.rawFile ? await inspectRawCaptureIdentity(session.rawFile) : undefined;
  const archiveId = availability.canonicalArchive.state === "available"
    ? availability.canonicalArchive.archiveId
    : null;
  const archiveNodes = archiveId && rows.length > 0
    ? await db
      .select({ lapId: canonicalArchiveNodes.lapId, startRow: canonicalArchiveNodes.startRow, endRow: canonicalArchiveNodes.endRow })
      .from(canonicalArchiveNodes)
      .where(and(
        eq(canonicalArchiveNodes.archiveId, archiveId),
        eq(canonicalArchiveNodes.level, "lap"),
        inArray(canonicalArchiveNodes.lapId, rows.map((row) => row.id)),
      ))
      .all()
    : [];
  const readableLapIds = new Set(
    archiveNodes.flatMap((node) => node.lapId != null && node.endRow > node.startRow ? [node.lapId] : []),
  );
  return evaluateEvidenceRetention(
    sessionId,
    { ...availability, rawCapture: raw != null, rawSourceIdentity: raw?.contentHash ?? null },
    rows,
    rows.length > 0 && rows.every((row) => readableLapIds.has(row.id)),
  );
}
