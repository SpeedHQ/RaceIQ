import type { QualityReasonCode, QualitySeverity } from "./contracts";

export type QualityReasonCategory = "recording" | "timeline" | "timing" | "coverage" | "channel" | "event" | "classification" | "source" | "policy" | "provenance" | "identity" | "retention";

export interface QualityReasonMetadata {
  category: QualityReasonCategory;
  defaultSeverity: QualitySeverity;
  messageKey: string;
  blocksStrictAnalysis: boolean;
}

export const QUALITY_REASON_META = {
  quality_not_rebuilt: { category: "provenance", defaultSeverity: "warning", messageKey: "quality.reason.quality_not_rebuilt", blocksStrictAnalysis: true },
  quality_stale: { category: "provenance", defaultSeverity: "warning", messageKey: "quality.reason.quality_stale", blocksStrictAnalysis: true },
  recording_unavailable: { category: "recording", defaultSeverity: "error", messageKey: "quality.reason.recording_unavailable", blocksStrictAnalysis: true },
  recording_incompatible: { category: "recording", defaultSeverity: "error", messageKey: "quality.reason.recording_incompatible", blocksStrictAnalysis: true },
  recording_corrupt: { category: "recording", defaultSeverity: "error", messageKey: "quality.reason.recording_corrupt", blocksStrictAnalysis: true },
  recording_incomplete: { category: "recording", defaultSeverity: "error", messageKey: "quality.reason.recording_incomplete", blocksStrictAnalysis: true },
  telemetry_gap_minor: { category: "timeline", defaultSeverity: "warning", messageKey: "quality.reason.telemetry_gap_minor", blocksStrictAnalysis: false },
  telemetry_gap_major: { category: "timeline", defaultSeverity: "error", messageKey: "quality.reason.telemetry_gap_major", blocksStrictAnalysis: true },
  duplicate_observations: { category: "timeline", defaultSeverity: "warning", messageKey: "quality.reason.duplicate_observations", blocksStrictAnalysis: true },
  out_of_order_observations: { category: "timeline", defaultSeverity: "error", messageKey: "quality.reason.out_of_order_observations", blocksStrictAnalysis: true },
  timeline_discontinuity: { category: "timeline", defaultSeverity: "error", messageKey: "quality.reason.timeline_discontinuity", blocksStrictAnalysis: true },
  source_reconnect: { category: "timeline", defaultSeverity: "warning", messageKey: "quality.reason.source_reconnect", blocksStrictAnalysis: true },
  writer_drop: { category: "recording", defaultSeverity: "error", messageKey: "quality.reason.writer_drop", blocksStrictAnalysis: true },
  lap_time_fallback: { category: "timing", defaultSeverity: "warning", messageKey: "quality.reason.lap_time_fallback", blocksStrictAnalysis: false },
  lap_time_unconfirmed: { category: "timing", defaultSeverity: "error", messageKey: "quality.reason.lap_time_unconfirmed", blocksStrictAnalysis: true },
  partial_track_coverage: { category: "coverage", defaultSeverity: "error", messageKey: "quality.reason.partial_track_coverage", blocksStrictAnalysis: true },
  position_unavailable: { category: "coverage", defaultSeverity: "warning", messageKey: "quality.reason.position_unavailable", blocksStrictAnalysis: false },
  channel_unavailable: { category: "channel", defaultSeverity: "error", messageKey: "quality.reason.channel_unavailable", blocksStrictAnalysis: true },
  channel_missing: { category: "channel", defaultSeverity: "error", messageKey: "quality.reason.channel_missing", blocksStrictAnalysis: true },
  channel_stale: { category: "channel", defaultSeverity: "error", messageKey: "quality.reason.channel_stale", blocksStrictAnalysis: true },
  channel_invalid: { category: "channel", defaultSeverity: "error", messageKey: "quality.reason.channel_invalid", blocksStrictAnalysis: true },
  channel_simplified: { category: "channel", defaultSeverity: "warning", messageKey: "quality.reason.channel_simplified", blocksStrictAnalysis: true },
  channel_derived: { category: "channel", defaultSeverity: "warning", messageKey: "quality.reason.channel_derived", blocksStrictAnalysis: true },
  pit_only_updates: { category: "channel", defaultSeverity: "warning", messageKey: "quality.reason.pit_only_updates", blocksStrictAnalysis: true },
  interpolated_channel: { category: "channel", defaultSeverity: "warning", messageKey: "quality.reason.interpolated_channel", blocksStrictAnalysis: true },
  fallback_channel: { category: "channel", defaultSeverity: "warning", messageKey: "quality.reason.fallback_channel", blocksStrictAnalysis: true },
  incident_lap: { category: "event", defaultSeverity: "warning", messageKey: "quality.reason.incident_lap", blocksStrictAnalysis: true },
  caution_context: { category: "event", defaultSeverity: "warning", messageKey: "quality.reason.caution_context", blocksStrictAnalysis: true },
  traffic_context: { category: "event", defaultSeverity: "warning", messageKey: "quality.reason.traffic_context", blocksStrictAnalysis: true },
  partial_lap: { category: "classification", defaultSeverity: "error", messageKey: "quality.reason.partial_lap", blocksStrictAnalysis: true },
  non_pace_classification: { category: "classification", defaultSeverity: "warning", messageKey: "quality.reason.non_pace_classification", blocksStrictAnalysis: false },
  structurally_invalid: { category: "classification", defaultSeverity: "error", messageKey: "quality.reason.structurally_invalid", blocksStrictAnalysis: true },
  imported_source: { category: "source", defaultSeverity: "info", messageKey: "quality.reason.imported_source", blocksStrictAnalysis: false },
  remote_packet_loss: { category: "timeline", defaultSeverity: "error", messageKey: "quality.reason.remote_packet_loss", blocksStrictAnalysis: true },
  opponent_channel_unavailable: { category: "channel", defaultSeverity: "warning", messageKey: "quality.reason.opponent_channel_unavailable", blocksStrictAnalysis: true },
  pace_segment_missing: { category: "policy", defaultSeverity: "warning", messageKey: "quality.reason.pace_segment_missing", blocksStrictAnalysis: true },
  insufficient_sample_pool: { category: "policy", defaultSeverity: "warning", messageKey: "quality.reason.insufficient_sample_pool", blocksStrictAnalysis: true },
  driver_inconsistent: { category: "policy", defaultSeverity: "warning", messageKey: "quality.reason.driver_inconsistent", blocksStrictAnalysis: false },
  provenance_missing: { category: "provenance", defaultSeverity: "error", messageKey: "quality.reason.provenance_missing", blocksStrictAnalysis: true },
  identity_unstable: { category: "identity", defaultSeverity: "error", messageKey: "quality.reason.identity_unstable", blocksStrictAnalysis: true },
  raw_redecode_required: { category: "retention", defaultSeverity: "warning", messageKey: "quality.reason.raw_redecode_required", blocksStrictAnalysis: true },
} as const satisfies Record<QualityReasonCode, QualityReasonMetadata>;
