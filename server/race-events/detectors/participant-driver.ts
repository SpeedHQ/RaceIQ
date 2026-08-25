import type { RaceParticipantObservation } from "../../games/types";
import {
  EVENT_ORDER_PRIORITY,
  type DetectorContext,
  type DetectorEventDraft,
} from "../types";

export const PARTICIPANT_DETECTOR_ID = "participant-driver";
export const PARTICIPANT_DETECTOR_VERSION = "1";

interface ParticipantState {
  participant: RaceParticipantObservation;
  available: boolean;
  consecutiveMissing: number;
}

export interface ParticipantDetectionResult {
  drafts: DetectorEventDraft[];
  unavailableParticipantIds: string[];
  returnedParticipantIds: string[];
}

function participantPayload(participant: RaceParticipantObservation) {
  return {
    sourceId: participant.sourceId,
    identityState: participant.identityState,
    displayName: participant.displayName,
    vehicleId: participant.vehicleId,
  } as const;
}

function participantDraft(
  context: DetectorContext,
  participant: RaceParticipantObservation,
  eventType:
    | "participant_joined"
    | "participant_became_unavailable"
    | "participant_returned",
): DetectorEventDraft {
  return {
    eventType,
    payload: participantPayload(participant),
    detectorId: PARTICIPANT_DETECTOR_ID,
    detectorVersion: PARTICIPANT_DETECTOR_VERSION,
    priority: EVENT_ORDER_PRIORITY.participant,
    boundaryKey: `${context.boundaryKey}:${eventType}:${participant.participantId}`,
    participant,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: eventType === "participant_became_unavailable" ? "unavailable" : "available",
  };
}

function driverDraft(
  context: DetectorContext,
  participant: RaceParticipantObservation,
  eventType: "driver_started_stint" | "driver_changed",
  previous: RaceParticipantObservation | null,
): DetectorEventDraft {
  return {
    eventType,
    payload: {
      previousDriverId: previous?.driverId ?? null,
      driverId: participant.driverId,
      previousDisplayName: previous?.displayName ?? null,
      displayName: participant.displayName,
    },
    detectorId: PARTICIPANT_DETECTOR_ID,
    detectorVersion: PARTICIPANT_DETECTOR_VERSION,
    priority: EVENT_ORDER_PRIORITY.driver,
    boundaryKey: `${context.boundaryKey}:${eventType}:${participant.participantId}`,
    participant,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
  };
}

export class ParticipantDriverDetector {
  private readonly participants = new Map<string, ParticipantState>();
  private readonly knownParticipantIds = new Set<string>();

  reset(preserveKnownIdentity = false): void {
    this.participants.clear();
    if (!preserveKnownIdentity) this.knownParticipantIds.clear();
  }

  clearParticipant(participantId: string): void {
    const state = this.participants.get(participantId);
    if (!state) return;
    state.participant = {
      ...state.participant,
      pitState: "unknown",
      position: null,
      speedMps: null,
      fuelLitres: null,
      tireCompound: null,
      tireWear: null,
      damage: null,
      penaltyValue: null,
      incidentCount: null,
      retirementStatus: "unknown",
      nativeRetirementCode: null,
    };
  }

  observe(context: DetectorContext): ParticipantDetectionResult {
    const drafts: DetectorEventDraft[] = [];
    const unavailableParticipantIds: string[] = [];
    const returnedParticipantIds: string[] = [];
    const seen = new Set<string>();

    for (const participant of context.observation.participants) {
      seen.add(participant.participantId);
      const state = this.participants.get(participant.participantId);
      if (!state) {
        this.participants.set(participant.participantId, {
          participant,
          available: true,
          consecutiveMissing: 0,
        });
        const previouslyKnown = this.knownParticipantIds.has(
          participant.participantId,
        );
        this.knownParticipantIds.add(participant.participantId);
        if (context.seed && previouslyKnown) continue;
        drafts.push(participantDraft(context, participant, "participant_joined"));
        if (participant.driverId != null) {
          drafts.push(
            driverDraft(context, participant, "driver_started_stint", null),
          );
        }
        continue;
      }

      state.consecutiveMissing = 0;
      if (!state.available) {
        state.available = true;
        returnedParticipantIds.push(participant.participantId);
        drafts.push(participantDraft(context, participant, "participant_returned"));
        if (participant.driverId != null) {
          drafts.push(
            driverDraft(context, participant, "driver_started_stint", null),
          );
        }
      } else if (
        participant.driverId != null &&
        state.participant.driverId != null &&
        participant.driverId !== state.participant.driverId
      ) {
        drafts.push(driverDraft(context, participant, "driver_changed", state.participant));
      } else if (
        participant.driverId != null &&
        state.participant.driverId == null
      ) {
        drafts.push(
          driverDraft(context, participant, "driver_started_stint", null),
        );
      }
      state.participant = {
        ...participant,
        driverId: participant.driverId ?? state.participant.driverId,
        teamId: participant.teamId ?? state.participant.teamId,
        displayName: participant.displayName ?? state.participant.displayName,
        vehicleId: participant.vehicleId ?? state.participant.vehicleId,
        sourceId: participant.sourceId ?? state.participant.sourceId,
      };
    }

    if (context.observation.rosterAuthoritative) {
      for (const [participantId, state] of this.participants) {
        if (!state.available || seen.has(participantId)) continue;
        state.consecutiveMissing += 1;
        if (state.consecutiveMissing < 2) continue;
        state.available = false;
        unavailableParticipantIds.push(participantId);
        drafts.push(
          participantDraft(
            context,
            state.participant,
            "participant_became_unavailable",
          ),
        );
      }
    }

    return { drafts, unavailableParticipantIds, returnedParticipantIds };
  }
}
