import type { GameId } from "../../games/ids";

export const FINDING_SCHEMA_VERSION = "1" as const;
/** Maximum typed references retained on one finding; excess evidence must be explicitly limited upstream. */
export const MAX_FINDING_EVIDENCE_REFS = 64;
/** Maximum telemetry ranges retained as representative event evidence. */
export const MAX_FINDING_REPRESENTATIVE_RANGES = 32;
/** Stable limitation code when representative evidence is capped. */
export const EVIDENCE_TRUNCATED_LIMITATION_CODE = "evidence-truncated";

export type FindingStatus = "available" | "unavailable" | "indeterminate";
export type FindingSeverity = "informational" | "low" | "medium" | "high" | "critical";
export type FindingConfidence = "high" | "medium" | "low" | "unknown";
export type FindingScopeKind =
  | "session"
  | "participant"
  | "stint"
  | "pace-segment"
  | "lap"
  | "corner"
  | "segment"
  | "comparison";

/** JSON values accepted by deterministic canonicalisation. */
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

export interface FindingScope {
  kind: FindingScopeKind;
  gameId: GameId;
  sessionId: string;
  participantId?: string;
  stintId?: string;
  paceSegmentId?: string;
  lapId?: string;
  cornerId?: string;
  segmentId?: string;
}

export interface FindingNumericRange {
  min: number;
  max: number;
}

export type FindingMeasurementValue = number | string | boolean | FindingNumericRange | null;

export interface FindingMeasurement {
  id: string;
  type: string;
  value: FindingMeasurementValue;
  unit: string;
  sampleCount: number;
  confidence: FindingConfidence;
  semanticIds: string[];
  derivation: { id: string; version: string };
  uncertainty?: number | FindingNumericRange | null;
  unavailableReason?: string;
}

interface FindingEvidenceBase {
  id: string;
  semanticIds?: string[];
  sessionId?: string;
}

export interface LapFindingEvidence extends FindingEvidenceBase {
  kind: "lap";
  lapId: string;
}
export interface EventFindingEvidence extends FindingEvidenceBase {
  kind: "event";
  eventId: string;
}
export interface StintFindingEvidence extends FindingEvidenceBase {
  kind: "stint";
  stintId: string;
}
export interface PaceSegmentFindingEvidence extends FindingEvidenceBase {
  kind: "pace-segment";
  paceSegmentId: string;
}
export interface CornerFindingEvidence extends FindingEvidenceBase {
  kind: "corner";
  cornerId: string;
  lapId?: string;
}
export interface SegmentFindingEvidence extends FindingEvidenceBase {
  kind: "segment";
  segmentId: string;
  lapId?: string;
}
export interface TelemetryRangeFindingEvidence extends FindingEvidenceBase {
  kind: "telemetry-range";
  lapId?: string;
  startFrameIndex?: number;
  endFrameIndex?: number;
  startTimestampMs?: number;
  endTimestampMs?: number;
  channel?: string;
}
export interface ChannelFindingEvidence extends FindingEvidenceBase {
  kind: "channel";
  channel: string;
}
export interface MeasurementFindingEvidence extends FindingEvidenceBase {
  kind: "measurement";
  measurementId: string;
}
export interface QualityDecisionFindingEvidence extends FindingEvidenceBase {
  kind: "quality-decision";
  decisionId: string;
  decision: string;
}
export interface ComparisonReferenceFindingEvidence extends FindingEvidenceBase {
  kind: "comparison-reference";
  comparisonReferenceId: string;
}

export type FindingEvidenceRef =
  | LapFindingEvidence
  | EventFindingEvidence
  | StintFindingEvidence
  | PaceSegmentFindingEvidence
  | CornerFindingEvidence
  | SegmentFindingEvidence
  | TelemetryRangeFindingEvidence
  | ChannelFindingEvidence
  | MeasurementFindingEvidence
  | QualityDecisionFindingEvidence
  | ComparisonReferenceFindingEvidence;

export interface FindingLimitation {
  code: string;
  detail?: string;
  evidenceRefs?: FindingEvidenceRef[];
}

export interface FindingRule {
  id: string;
  version: string;
  inputs: Record<string, CanonicalJson>;
}

export interface ComparisonReference {
  id: string;
  kind: string;
  selectionReason: string;
  evidenceRefs: FindingEvidenceRef[];
}

export interface FindingRecord {
  schemaVersion: typeof FINDING_SCHEMA_VERSION;
  id: string;
  type: string;
  category: string;
  scope: FindingScope;
  status: FindingStatus;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  measurements: FindingMeasurement[];
  evidenceRefs: FindingEvidenceRef[];
  qualityRefs: FindingEvidenceRef[];
  limitations: FindingLimitation[];
  rule: FindingRule;
  analysisGenerationId: string;
  comparisonReference?: ComparisonReference;
  /** Convenience prose. Never used by identity or aggregation compatibility. */
  title?: string;
}

export interface FindingRecommendation {
  id: string;
  kind: string;
  text: string;
  supportingFindingIds: string[];
  confidence: FindingConfidence;
  status?: "proposed" | "accepted" | "rejected";
  policy?: Record<string, CanonicalJson>;
}

export interface FindingNarrative {
  id: string;
  findingIds: string[];
  text: string;
  generator: string;
  generationId: string;
  createdAt?: string;
}

export interface FindingDelivery {
  id: string;
  findingIds: string[];
  narrativeId?: string;
  recommendationIds?: string[];
  channel: string;
  policy: Record<string, CanonicalJson>;
  deliveredAt?: string;
}

export type FindingGenerationStatus =
  | "staging"
  | "current"
  | "stale-rebuild-available"
  | "stale-source-missing"
  | "verification-failed"
  | "incompatible"
  | "corrupt";

export interface FindingGenerationReceipt {
  generationId: string;
  sourceId: string;
  rule: { id: string; version: string };
  config: Record<string, CanonicalJson>;
  schemaVersion: typeof FINDING_SCHEMA_VERSION;
  status: FindingGenerationStatus;
  findingCount: number;
  availableCount: number;
  unavailableCount: number;
  indeterminateCount: number;
  contentHash: string;
  createdAt: string;
  activatedAt?: string;
  staleAt?: string;
  failureReason?: string;
}
