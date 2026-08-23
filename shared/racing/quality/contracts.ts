import type { LapClassification } from "@shared/racing/laps/classification";
import type { MappingStatus } from "@shared/telemetry/derivations/contracts";
import type { TelemetryGroupId, TelemetryVariableId } from "@shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { FreshnessState, ResolutionProvenance, ResolutionState } from "@shared/telemetry/resolver/contracts";
import type { TelemetryVersionIdentity } from "@shared/telemetry/version";

export const QUALITY_SCHEMA_VERSION = "1" as const;
export const ELIGIBILITY_POLICY_VERSION = "1" as const;
export const QUALITY_CONFIG_VERSION = "1" as const;

export type EvidenceSourceKind = "native-live" | "raceiq-raw" | "raceiq-archive" | "canonical-archive" | "iracing-ibt" | "motec" | "remote-collector" | "external-log" | "unknown";

const EVIDENCE_SOURCE_KINDS: Record<EvidenceSourceKind, true> = {
  "native-live": true,
  "raceiq-raw": true,
  "raceiq-archive": true,
  "canonical-archive": true,
  "iracing-ibt": true,
  motec: true,
  "remote-collector": true,
  "external-log": true,
  unknown: true,
};

export function normalizeEvidenceSourceKind(
  source: string | null | undefined,
): EvidenceSourceKind {
  return source != null && Object.hasOwn(EVIDENCE_SOURCE_KINDS, source)
    ? (source as EvidenceSourceKind)
    : "unknown";
}

export const SOURCE_CHANNEL_PROFILE_VERSION = "1" as const;

export type SourceChannelTreatment = "direct" | "held" | "resampled" | "dead-reckoned" | "assumed" | "absent";

export interface SourceChannelDescriptor {
  name: string;
  declaredHz: number | null;
  effectiveHz: number | null;
}

export interface SourceChannelProfileEvidence {
  schemaVersion: typeof SOURCE_CHANNEL_PROFILE_VERSION;
  sourceKind: EvidenceSourceKind;
  treatment: SourceChannelTreatment;
  sourceChannels: SourceChannelDescriptor[];
  evidenceId: string;
}

export interface SourceChannelProfileEntry {
  treatment: SourceChannelTreatment;
  mappingStatus: MappingStatus;
  sourceChannels: SourceChannelDescriptor[];
  limitations: string[];
  /** Deterministic evidence identity used to link quality facts to this declaration. */
  evidenceId: string;
}

/**
 * Session-wide fidelity contract supplied by the original evidence source.
 * Entries override native game-catalog mappings because transcoded frames can
 * carry weaker semantics than the native protocol fields they occupy.
 */
export interface SourceChannelProfile {
  schemaVersion: typeof SOURCE_CHANNEL_PROFILE_VERSION;
  sourceKind: EvidenceSourceKind;
  channels: Partial<Record<TelemetryVariableId, SourceChannelProfileEntry>>;
}

export type ParticipantKind = "player" | "opponent";

export interface ParticipantEvidence {
  kind: ParticipantKind;
  sourceId: string | null;
  stableId: string | null;
  identityState: "stable" | "session-scoped" | "unknown";
}

export const LOCAL_PLAYER_EVIDENCE: ParticipantEvidence = {
  kind: "player",
  sourceId: null,
  stableId: "local-player",
  identityState: "stable",
};

export type RecordingLifecycleState = "exact" | "minor_gaps" | "degraded" | "incomplete" | "incompatible" | "corrupt" | "unavailable";

export type QualityReasonCode =
  | "quality_not_rebuilt"
  | "quality_stale"
  | "recording_unavailable"
  | "recording_incompatible"
  | "recording_corrupt"
  | "recording_incomplete"
  | "telemetry_gap_minor"
  | "telemetry_gap_major"
  | "duplicate_observations"
  | "out_of_order_observations"
  | "timeline_discontinuity"
  | "source_reconnect"
  | "writer_drop"
  | "lap_time_fallback"
  | "lap_time_unconfirmed"
  | "partial_track_coverage"
  | "position_unavailable"
  | "channel_unavailable"
  | "channel_missing"
  | "channel_stale"
  | "channel_invalid"
  | "channel_simplified"
  | "channel_derived"
  | "pit_only_updates"
  | "interpolated_channel"
  | "fallback_channel"
  | "incident_lap"
  | "caution_context"
  | "traffic_context"
  | "partial_lap"
  | "non_pace_classification"
  | "structurally_invalid"
  | "imported_source"
  | "remote_packet_loss"
  | "opponent_channel_unavailable"
  | "pace_segment_missing"
  | "insufficient_sample_pool"
  | "driver_inconsistent"
  | "provenance_missing"
  | "identity_unstable"
  | "raw_redecode_required";

export type QualitySeverity = "info" | "warning" | "error";

export interface QualityTimeRange {
  startMs: number;
  endMs: number;
}

export interface QualityDistanceRange {
  startFraction: number;
  endFraction: number;
}

export interface QualityProvenance {
  schemaVersion: string;
  policyVersion: string;
  configurationVersion: string;
  sourceGeneration: string;
  outputGeneration: string;
}

export interface QualityFact {
  id: string;
  code: QualityReasonCode;
  severity: QualitySeverity;
  timeRange: QualityTimeRange | null;
  distanceRange?: QualityDistanceRange | null;
  semanticIds: TelemetryVariableId[];
  channelFamilies: TelemetryGroupId[];
  provenance: QualityProvenance;
  eventIds: string[];
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface GapSummary {
  expectedCount: number;
  observedCount: number;
  totalMissingCount: number | null;
  totalMissingFraction: number | null;
  largestContiguousGapMs: number;
  countMethod: "native-sequence" | "timestamp-estimate" | "unavailable";
}

export interface ChannelIssueInterval {
  state: ResolutionState;
  freshness: FreshnessState;
  timeRange: QualityTimeRange;
  distanceRange: QualityDistanceRange | null;
  count: number;
}

export type ChannelResolutionProvenance = Omit<ResolutionProvenance, "observedAt" | "sourceObservation">;
export interface ChannelQualitySummary {
  semanticId: TelemetryVariableId;
  channelFamily: TelemetryGroupId;
  mappingStatus: MappingStatus;
  canonicalUnit: string | null;
  nativeUnit: string | null;
  resolutionCounts: Record<ResolutionState, number>;
  freshnessCounts: Record<FreshnessState, number>;
  expectedCount: number;
  observedCount: number;
  expectedCadenceMs: number | null;
  observedCadenceMs: number | null;
  coverage: number | null;
  confidenceMean: number | null;
  boundaryCoverage: {
    first500Ms: number | null;
    last500Ms: number | null;
  };
  issueIntervals: ChannelIssueInterval[];
  limitations: string[];
  provenance: ChannelResolutionProvenance | null;
  sourceProfile: SourceChannelProfileEvidence | null;
}

export interface QualityThresholdSnapshot {
  minorGapMaxMs: number;
  minorMissingFractionMax: number;
  degradedMissingFraction: number;
  lapComparisonCoverage: number;
  lapComparisonGapMaxMs: number;
  cornerTraceCoverage: number;
  cornerTraceGapMaxMs: number;
  transientCoverage: number;
  transientGapFloorMs: number;
  transientIntervalMultiplier: number;
}

export type LapTimingSource = "simulator-last-lap" | "simulator-history" | "telemetry-elapsed" | "estimated";

export interface LapTimingEvidence {
  source: LapTimingSource;
  lapTimeMs: number;
  peakTelemetryLapTimeMs: number | null;
  confirmed: boolean;
}

export interface LapQualitySummary {
  lifecycleState: RecordingLifecycleState;
  complete: boolean;
  structurallyValid: boolean;
  invalidReason: string | null;
  timing: LapTimingEvidence;
  timeRange?: QualityTimeRange | null;
  gapSummary: GapSummary;
  trackDistanceCoverage: number | null;
  worldPositionCoverage: number | null;
  channelQuality: ChannelQualitySummary[];
  facts: QualityFact[];
  sourceKind: EvidenceSourceKind;
  participant: ParticipantEvidence;
  classification: LapClassification;
  thresholds: QualityThresholdSnapshot;
  versionIdentity: TelemetryVersionIdentity;
  provenance: QualityProvenance;
}

export interface SourceLifecycleEvidence {
  kind: "start" | "stop" | "timeout" | "reconnect";
  timestampMs: number;
  eventId?: string;
  details?: string;
}

export interface ArchiveVerification {
  state: "verified" | "truncated" | "corrupt" | "unavailable" | "unknown";
  sourceGeneration: string | null;
  details?: string;
}

export interface RecordingQualitySummary {
  lifecycleState: RecordingLifecycleState;
  gapSummary: GapSummary;
  facts: QualityFact[];
  sourceKind: EvidenceSourceKind;
  participant: ParticipantEvidence;
  startTimestampMs: number | null;
  endTimestampMs: number | null;
  endReason: string;
  /** Verification and identity of original evidence source. */
  archiveVerification: ArchiveVerification;
  /** Verification applied while transporting original evidence, such as a RaceIQ ZIP member checksum. */
  transportVerification?: ArchiveVerification;
  /** Verification of RaceIQ's canonical capture or deterministic replay bytes. */
  canonicalVerification?: ArchiveVerification;
  thresholds: QualityThresholdSnapshot;
  versionIdentity: TelemetryVersionIdentity;
  provenance: QualityProvenance;
}

export type EligibilityStatus = "eligible" | "eligible_with_warning" | "ineligible" | "unknown";

export type EligibilityPolicyId =
  | "official-timing"
  | "normal-pace"
  | "lap-comparison"
  | "corner-trace"
  | "transient-event"
  | "fuel-burn"
  | "tire-analysis"
  | "stint-falloff"
  | "setup-analysis"
  | "driver-profile"
  | "ml-training";

export interface EligibilityReason {
  code: QualityReasonCode;
  severity: QualitySeverity;
  evidenceIds: string[];
  timeRange: QualityTimeRange | null;
  distanceRange: QualityDistanceRange | null;
  semanticIds: TelemetryVariableId[];
}

export interface EligibilityDecision {
  status: EligibilityStatus;
  policyId: EligibilityPolicyId;
  policyVersion: string;
  confidence: {
    level: "high" | "medium" | "low" | "unknown";
    score: number | null;
  };
  reasons: EligibilityReason[];
  evidenceIds: string[];
}

export type EligibilityDecisionSet = Record<EligibilityPolicyId, EligibilityDecision>;

export interface EligibilityEvaluationOptions {
  range?: QualityDistanceRange;
  tireMode?: "continuous" | "pit-snapshot";
  requiredSemanticIds?: readonly TelemetryVariableId[];
}

export interface GroupEligibilityContext {
  paceSegmentId?: string | null;
  combinationCount?: number;
  newestFirst?: boolean;
}

export interface GroupEligibilityLap {
  lapId?: number;
  lapTime: number;
  createdAt?: string;
  carTrackKey?: string;
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
}
