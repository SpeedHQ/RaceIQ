import type { CanonicalArchiveAvailability as SharedCanonicalArchiveAvailability } from "../archives/contracts";
import type { EligibilityDecisionSet, EligibilityPolicyId, QualityReasonCode } from "./contracts";

export const EVIDENCE_RETENTION_POLICY_VERSION = "1";

export type CanonicalArchiveAvailability = SharedCanonicalArchiveAvailability;

export interface EvidenceAvailability {
  rawCapture: boolean;
  rawSourceIdentity?: string | null;
  canonicalArchive: CanonicalArchiveAvailability;
}


export interface RetentionLapDecision {
  lapId: number;
  current: EligibilityDecisionSet;
  postRawRemoval: EligibilityDecisionSet;
}

export interface EvidenceRetentionAssessment {
  sessionId: number;
  policyVersion: string;
  action: "retain_raw" | "raw_removal_safe" | "raw_unavailable" | "quality_unavailable";
  canDeleteRaw: boolean;
  reasons: QualityReasonCode[];
  blockedBy: EligibilityPolicyId[];
  availability: EvidenceAvailability;
  laps: RetentionLapDecision[];
}
