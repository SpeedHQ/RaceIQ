import { DEFAULT_LAP_CLASSIFICATION, type LapClassification } from "../../shared/racing/laps/classification";
import {
  LOCAL_PLAYER_EVIDENCE,
  type EligibilityDecisionSet,
  type EvidenceSourceKind,
  type LapQualitySummary,
  type ParticipantEvidence,
  type SourceChannelProfile,
} from "../../shared/racing/quality/contracts";
import { summarizeLapQuality } from "../../shared/racing/quality/measure";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";
import type { SessionOwnership } from "../../shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { TelemetryPacket } from "../../shared/telemetry/types";

export interface LapQualityResult {
  valid: boolean;
  reason: string | null;
}

/**
 * Assess recording quality of a completed lap.
 * Returns { valid: false, reason } when the telemetry indicates a bad recording.
 * Returns { valid: true, reason: null } when the lap looks clean.
 *
 * This is a pure function — no side effects, no DB access.
 */
export function assessLapRecording(packets: TelemetryPacket[], lapTime: number): LapQualityResult {
  if (packets.length < 30) {
    return { valid: false, reason: "too few telemetry packets" };
  }

  const first = packets[0];
  const last = packets[packets.length - 1];
  const lapDistance = last.DistanceTraveled - first.DistanceTraveled;

  if (lapDistance < 100) {
    return { valid: false, reason: "telemetry distance too short" };
  }

  // Lap time in telemetry should roughly match stored lapTime (within 2s).
  // Use peak CurrentLap across the buffer rather than the last packet — in ACC,
  // iCurrentTime can reset to ~0 and start counting the new lap before completedLaps
  // increments, so the last few packets may show the new lap's elapsed time instead.
  let peakTelemetryLapTime = -Infinity;
  for (const packet of packets) {
    peakTelemetryLapTime = Math.max(peakTelemetryLapTime, packet.CurrentLap);
  }
  if (peakTelemetryLapTime > 0 && Math.abs(peakTelemetryLapTime - lapTime) > 2) {
    return { valid: false, reason: "telemetry lap time mismatch" };
  }

  // Start and end positions must be close (circuit lap should return to start/finish).
  // ACC lap counter can reset to 0 after session changes, so only reject if it looks
  // like an actual formation lap (very short, < 30 seconds).
  if (first.gameId === "acc" && first.LapNumber === 0 && lapTime < 30) {
    return { valid: false, reason: "starting lap" };
  }

  // Start and end positions must be close (circuit lap should return to start/finish).
  // Skip for ACC — carCoordinates are in a different scale to DistanceTraveled.
  if (first.gameId !== "acc") {
    const dx = last.PositionX - first.PositionX;
    const dz = last.PositionZ - first.PositionZ;
    const gap = Math.sqrt(dx * dx + dz * dz);
    if (gap > lapDistance * 0.15 && gap > 100) {
      return { valid: false, reason: "start/end positions too far apart" };
    }
  }

  return { valid: true, reason: null };
}

export interface LapQualityCaptureContext {
  sourceKind: EvidenceSourceKind;
  participant: ParticipantEvidence;
  versionIdentity: TelemetryVersionIdentity;
  sourceChannelProfile?: SourceChannelProfile;
}

export interface LapQualityMeasurementInput {
  packets: readonly TelemetryPacket[];
  lapTime: number;
  timingSource: LapQualitySummary["timing"]["source"];
  complete: boolean;
  isValid: boolean;
  invalidReason: string | null;
  classification?: LapClassification;
  eventIds?: readonly string[];
}

export function participantEvidenceForOwnership(ownership?: SessionOwnership): ParticipantEvidence {
  return ownership === "others"
    ? {
        kind: "opponent",
        sourceId: null,
        stableId: null,
        identityState: "unknown",
      }
    : LOCAL_PLAYER_EVIDENCE;
}

function classificationForLap(invalidReason: string | null): LapClassification {
  switch (invalidReason) {
    case "outlap":
      return { phase: "out", conditions: [], paceEligibility: "excluded" };
    case "inlap":
      return { phase: "in", conditions: [], paceEligibility: "excluded" };
    case "pit lap":
      return { phase: "pit", conditions: [], paceEligibility: "excluded" };
    default:
      return DEFAULT_LAP_CLASSIFICATION;
  }
}

export function measureLapQuality(
  context: LapQualityCaptureContext,
  input: LapQualityMeasurementInput,
): {
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
} {
  const classification =
    input.classification ?? classificationForLap(input.invalidReason);
  const quality = summarizeLapQuality({
    packets: input.packets,
    lapTime: input.lapTime,
    timingSource: input.timingSource,
    complete: input.complete,
    structurallyValid: input.isValid || classification.paceEligibility === "excluded",
    invalidReason: classification.paceEligibility === "excluded" ? null : input.invalidReason,
    classification,
    sourceKind: context.sourceKind,
    participant: context.participant,
    versionIdentity: context.versionIdentity,
    sourceChannelProfile: context.sourceChannelProfile,
    eventIds: input.eventIds,
  });
  return {
    quality,
    eligibility: evaluateAllEligibility(quality),
  };
}
