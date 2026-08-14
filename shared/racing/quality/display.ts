import type { EligibilityDecision, QualityDistanceRange, QualityReasonCode, QualityTimeRange, RecordingLifecycleState } from "./contracts";

const QUALITY_REASON_TEXT = {
  quality_not_rebuilt: "Quality has not been rebuilt from source telemetry.",
  recording_unavailable: "Source recording is unavailable.",
  recording_incompatible: "Source recording is not compatible with this RaceIQ version.",
  recording_corrupt: "Source recording failed integrity checks.",
  recording_incomplete: "Source recording ended before a complete capture was available.",
  telemetry_gap_minor: "Telemetry contains a short gap.",
  telemetry_gap_major: "Telemetry contains a significant gap.",
  duplicate_observations: "Telemetry contains duplicate observations.",
  out_of_order_observations: "Telemetry observations arrived out of order.",
  timeline_discontinuity: "Telemetry timeline is discontinuous.",
  source_reconnect: "Telemetry source reconnected during recording.",
  writer_drop: "Recorder could not persist some telemetry.",
  lap_time_fallback: "Lap time uses telemetry elapsed time instead of simulator history.",
  lap_time_unconfirmed: "Lap time could not be confirmed by simulator timing.",
  partial_track_coverage: "Telemetry does not cover enough of the lap.",
  position_unavailable: "World position is unavailable.",
  channel_unavailable: "Required telemetry channel is unavailable.",
  channel_missing: "Required telemetry channel has missing values.",
  channel_stale: "Required telemetry channel is stale.",
  channel_invalid: "Required telemetry channel contains invalid values.",
  channel_simplified: "Telemetry channel has reduced source fidelity.",
  channel_derived: "Telemetry channel is derived rather than directly measured.",
  pit_only_updates: "Telemetry channel updates only in pit snapshots.",
  interpolated_channel: "Telemetry channel contains interpolated values.",
  fallback_channel: "Telemetry channel uses a fallback source.",
  incident_lap: "Incident or damage evidence affects this lap.",
  caution_context: "Lap occurred under caution, slow-zone, or formation conditions.",
  traffic_context: "Traffic evidence affects this range.",
  partial_lap: "Lap is incomplete.",
  non_pace_classification: "Lap is classified as non-pace evidence.",
  structurally_invalid: "Simulator or lap boundary marked this lap invalid.",
  imported_source: "Telemetry came from an imported recording.",
  remote_packet_loss: "Remote collector reported packet loss.",
  opponent_channel_unavailable: "Player-only telemetry is unavailable for this opponent.",
  pace_segment_missing: "Pace segment context is missing.",
  insufficient_sample_pool: "Not enough suitable laps are available.",
  driver_inconsistent: "Lap-time spread exceeds policy threshold.",
  provenance_missing: "Evidence provenance is incomplete.",
  identity_unstable: "Participant identity is not stable across sessions.",
  raw_redecode_required: "Raw telemetry must be retained to rebuild this analysis.",
} as const satisfies Record<QualityReasonCode, string>;

export const RECORDING_LIFECYCLE_LABEL = {
  exact: "Good",
  minor_gaps: "Minor gaps",
  degraded: "Limited",
  incomplete: "Incomplete",
  incompatible: "Unavailable",
  corrupt: "Unavailable",
  unavailable: "Unavailable",
} as const satisfies Record<RecordingLifecycleState, string>;

function rangeText(timeRange?: QualityTimeRange | null, distanceRange?: QualityDistanceRange | null): string {
  if (distanceRange) {
    const start = Math.round(distanceRange.startFraction * 100);
    const end = Math.round(distanceRange.endFraction * 100);
    return ` (${start}-${end}% of lap)`;
  }
  if (timeRange) {
    return ` (${(timeRange.startMs / 1000).toFixed(1)}-${(timeRange.endMs / 1000).toFixed(1)}s)`;
  }
  return "";
}

export function qualityReasonText(code: QualityReasonCode, timeRange?: QualityTimeRange | null, distanceRange?: QualityDistanceRange | null): string {
  return `${QUALITY_REASON_TEXT[code]}${rangeText(timeRange, distanceRange)}`;
}

export function eligibilityDecisionText(decision: EligibilityDecision): string {
  if (decision.status === "eligible") return "Suitable";
  if (decision.status === "eligible_with_warning") {
    const first = decision.reasons[0];
    return first ? `Suitable with limits: ${qualityReasonText(first.code, first.timeRange, first.distanceRange)}` : "Suitable with limits";
  }
  if (decision.status === "unknown") {
    const first = decision.reasons[0];
    return first ? `Suitability unknown: ${qualityReasonText(first.code, first.timeRange, first.distanceRange)}` : "Suitability unknown";
  }
  const first = decision.reasons[0];
  return first ? `Not suitable: ${qualityReasonText(first.code, first.timeRange, first.distanceRange)}` : "Not suitable";
}
