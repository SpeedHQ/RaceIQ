import type { RaceParticipantObservation } from "../../games/types";
import { damageVectorAtOrBelow, increasedDamageComponents } from "../../../shared/racing/quality/damage";
import { EVENT_ORDER_PRIORITY, type DetectorContext, type DetectorEventDraft } from "../types";

export const INCIDENT_PENALTY_DETECTOR_ID = "incident-damage-penalty";
export const INCIDENT_PENALTY_DETECTOR_VERSION = "2";

const DAMAGE_WARNING_DELTA = 1;
const DAMAGE_CLEAR_MAX = 0.5;

interface ParticipantIncidentState {
  participant: RaceParticipantObservation;
  damageWarningActive: boolean;
  penaltyActive: boolean;
  retired: boolean;
}

/** Shared damage-vector comparison used by quality and event projections. */
export function changedDamageComponents(previous: Readonly<Record<string, number>>, current: Readonly<Record<string, number>>, minimumIncrease = DAMAGE_WARNING_DELTA): string[] {
  return increasedDamageComponents(previous, current, minimumIncrease);
}

export function damageVectorCleared(current: Readonly<Record<string, number>>): boolean {
  return damageVectorAtOrBelow(current, DAMAGE_CLEAR_MAX);
}

function draft(
  context: DetectorContext,
  participant: RaceParticipantObservation,
  eventType: DetectorEventDraft["eventType"],
  payload: DetectorEventDraft["payload"],
  options: {
    evidenceKind?: DetectorEventDraft["evidenceKind"];
    qualityState?: DetectorEventDraft["qualityState"];
  } = {},
): DetectorEventDraft {
  return {
    eventType,
    payload,
    detectorId: INCIDENT_PENALTY_DETECTOR_ID,
    detectorVersion: INCIDENT_PENALTY_DETECTOR_VERSION,
    priority: EVENT_ORDER_PRIORITY.incidentDamagePenaltyReset,
    boundaryKey: `${context.boundaryKey}:${eventType}:${participant.participantId}`,
    participant,
    evidenceKind: options.evidenceKind ?? "observed",
    confidence: "high",
    qualityState: options.qualityState ?? "available",
  } as DetectorEventDraft;
}

export class IncidentPenaltyDetector {
  private readonly participants = new Map<string, ParticipantIncidentState>();

  reset(): void {
    this.participants.clear();
  }

  clearParticipant(participantId: string): void {
    this.participants.delete(participantId);
  }

  observe(context: DetectorContext): DetectorEventDraft[] {
    const drafts: DetectorEventDraft[] = [];
    for (const participant of context.observation.participants) {
      const previous = this.participants.get(participant.participantId);
      if (!previous || context.seed) {
        this.participants.set(participant.participantId, {
          participant,
          damageWarningActive: participant.damage != null && !damageVectorCleared(participant.damage),
          penaltyActive: participant.penaltyValue != null && participant.penaltyValue > 0,
          retired: participant.retirementStatus === "retired",
        });
        continue;
      }

      if (previous.participant.incidentCount != null && participant.incidentCount != null && participant.incidentCount > previous.participant.incidentCount) {
        drafts.push(
          draft(context, participant, "incident_observed", {
            previousCount: previous.participant.incidentCount,
            currentCount: participant.incidentCount,
            delta: participant.incidentCount - previous.participant.incidentCount,
          }),
        );
      }

      if (previous.participant.damage != null && participant.damage != null) {
        const changed = changedDamageComponents(previous.participant.damage, participant.damage);
        if (changed.length > 0 && !previous.damageWarningActive) {
          drafts.push(
            draft(
              context,
              participant,
              "damage_warning_started",
              {
                previousComponents: previous.participant.damage,
                currentComponents: participant.damage,
                changedComponents: changed,
              },
              { evidenceKind: "derived" },
            ),
          );
          previous.damageWarningActive = true;
        } else if (previous.damageWarningActive && damageVectorCleared(participant.damage)) {
          drafts.push(
            draft(
              context,
              participant,
              "damage_warning_cleared",
              {
                previousComponents: previous.participant.damage,
                currentComponents: participant.damage,
                changedComponents: Object.keys(participant.damage).sort(),
              },
              { evidenceKind: "derived" },
            ),
          );
          previous.damageWarningActive = false;
        }
      }

      const previousPenalty = previous.participant.penaltyValue;
      const currentPenalty = participant.penaltyValue;
      if (currentPenalty != null && (previousPenalty == null || currentPenalty > previousPenalty) && currentPenalty > 0) {
        drafts.push(
          draft(context, participant, "penalty_issued", {
            previousValue: previousPenalty,
            currentValue: currentPenalty,
            nativeCode: null,
          }),
        );
        previous.penaltyActive = true;
      } else if (previousPenalty != null && previous.penaltyActive && currentPenalty != null && currentPenalty < previousPenalty) {
        drafts.push(
          draft(context, participant, "penalty_cleared", {
            previousValue: previousPenalty,
            currentValue: currentPenalty,
            nativeCode: null,
            resolution: "unknown",
          }),
        );
        previous.penaltyActive = currentPenalty > 0;
      }

      if (!previous.retired && participant.retirementStatus === "retired" && participant.nativeRetirementCode != null) {
        drafts.push(
          draft(context, participant, "retirement_observed", {
            nativeCode: participant.nativeRetirementCode,
            status: participant.retirementStatus,
          }),
        );
        previous.retired = true;
      }
      previous.participant = participant;
    }
    return drafts;
  }
}
