import type { TelemetryVariableId } from "@shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { EligibilityDecisionSet, EligibilityPolicyId, QualityReasonCode } from "./contracts";

export const EVIDENCE_RETENTION_POLICY_VERSION = "1";

export type CanonicalArchiveState = "available" | "unavailable" | "unknown";

export interface CanonicalArchiveProvenance {
  archiveIdentity: string;
  schemaIdentity: string;
  configIdentity: string;
  sourceIdentity: string;
  outputIdentity: string;
}

export interface CanonicalArchiveAvailability {
  state: CanonicalArchiveState;
  semanticIds: readonly TelemetryVariableId[];
  eventIds: readonly string[];
  provenance: CanonicalArchiveProvenance | null;
  details: string | null;
}

export interface EvidenceAvailability {
  rawCapture: boolean;
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
