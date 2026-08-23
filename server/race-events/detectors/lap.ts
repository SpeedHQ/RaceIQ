import type { LapTimelineClassificationContext } from "../../../shared/racing/laps/classification";
import type { RaceParticipantObservation } from "../../games/types";
import {
  EVENT_ORDER_PRIORITY,
  type DetectorContext,
  type DetectorEventDraft,
  type RaceEventLapEvaluation,
} from "../types";

export const LAP_EVENT_DETECTOR_ID = "lap-timeline";
export const LAP_EVENT_DETECTOR_VERSION = "1";

export class LapEventDetector {
  private currentLapNumber: number | null = null;
  private lastCompletedPosition: number | null = null;

  reset(): void {
    this.currentLapNumber = null;
    this.lastCompletedPosition = null;
  }

  observe(
    context: DetectorContext,
    classification: LapTimelineClassificationContext,
  ): DetectorEventDraft[] {
    const nextLap = context.observation.lapNumber;
    if (nextLap == null) return [];
    if (this.currentLapNumber == null || context.seed) {
      this.currentLapNumber = nextLap;
      return [];
    }
    if (nextLap <= this.currentLapNumber) {
      this.currentLapNumber = nextLap;
      return [];
    }
    this.currentLapNumber = nextLap;
    return [
      {
        eventType: "lap_started",
        payload: {
          lapNumber: nextLap,
          phase: classification.pitPhase ??
            (classification.gridStart ? "grid_start" : "flying"),
          conditions: classification.conditions,
        },
        detectorId: LAP_EVENT_DETECTOR_ID,
        detectorVersion: LAP_EVENT_DETECTOR_VERSION,
        priority: EVENT_ORDER_PRIORITY.lap,
        boundaryKey: `${context.boundaryKey}:lap:${nextLap}:start`,
        participant: localParticipant(context.observation.participants),
        lapNumber: nextLap,
        evidenceKind: "observed",
        confidence: "high",
        qualityState: "available",
      },
    ];
  }

  evaluated(
    context: DetectorContext,
    input: RaceEventLapEvaluation,
  ): DetectorEventDraft[] {
    const participant = this.participant(context, input);
    const boundary = [
      context.boundaryKey,
      `lap:${input.lapNumber}`,
      `raw:${input.rawBoundaryOffset ?? "none"}`,
      `ordinal:${input.rawBoundaryOrdinal ?? context.sequence}`,
    ].join(":");
    const drafts: DetectorEventDraft[] = [
      {
        eventType: "lap_completed",
        payload: {
          lapNumber: input.lapNumber,
          lapTimeMs: input.lapTimeMs,
          isValid: input.isValid,
          phase: input.phase,
          conditions: input.conditions,
        },
        detectorId: LAP_EVENT_DETECTOR_ID,
        detectorVersion: LAP_EVENT_DETECTOR_VERSION,
        priority: EVENT_ORDER_PRIORITY.lap,
        boundaryKey: `${boundary}:completed`,
        participant,
        lapNumber: input.lapNumber,
        evidenceKind: "observed",
        confidence: "high",
        qualityState: "available",
      },
    ];

    if (!input.isValid && input.invalidReason != null) {
      drafts.push({
        eventType: "track_limit_or_lap_invalidated",
        payload: {
          lapNumber: input.lapNumber,
          reason: input.invalidReason,
        },
        detectorId: LAP_EVENT_DETECTOR_ID,
        detectorVersion: LAP_EVENT_DETECTOR_VERSION,
        priority: EVENT_ORDER_PRIORITY.lap,
        boundaryKey: `${boundary}:invalidated`,
        participant,
        lapNumber: input.lapNumber,
        evidenceKind: "observed",
        confidence: "high",
        qualityState: "degraded",
      });
    }

    for (let index = 0; index < (input.sectors?.length ?? 0); index += 1) {
      const sectorSeconds = input.sectors?.[index];
      if (sectorSeconds == null || !Number.isFinite(sectorSeconds) || sectorSeconds < 0) {
        continue;
      }
      drafts.push({
        eventType: "sector_completed",
        payload: {
          lapNumber: input.lapNumber,
          sectorIndex: index,
          sectorTimeMs: sectorSeconds * 1_000,
        },
        detectorId: LAP_EVENT_DETECTOR_ID,
        detectorVersion: LAP_EVENT_DETECTOR_VERSION,
        priority: EVENT_ORDER_PRIORITY.lap,
        boundaryKey: `${boundary}:sector:${index}`,
        participant,
        lapNumber: input.lapNumber,
        evidenceKind: "derived",
        confidence: "high",
        qualityState: "available",
      });
    }

    const position = input.position ?? participant?.position ?? null;
    if (
      participant?.participantKind === "player" &&
      position != null &&
      this.lastCompletedPosition != null &&
      position !== this.lastCompletedPosition
    ) {
      drafts.push({
        eventType: "position_changed",
        payload: {
          previousPosition: this.lastCompletedPosition,
          position,
        },
        detectorId: LAP_EVENT_DETECTOR_ID,
        detectorVersion: LAP_EVENT_DETECTOR_VERSION,
        priority: EVENT_ORDER_PRIORITY.participant,
        boundaryKey: `${boundary}:position`,
        participant,
        lapNumber: input.lapNumber,
        evidenceKind: "observed",
        confidence: "high",
        qualityState: "available",
      });
    }
    return drafts;
  }

  commitEvaluation(
    context: DetectorContext,
    input: RaceEventLapEvaluation,
  ): void {
    const participant = this.participant(context, input);
    const position = input.position ?? participant?.position ?? null;
    if (position != null) this.lastCompletedPosition = position;
  }

  private participant(
    context: DetectorContext,
    input: RaceEventLapEvaluation,
  ): RaceParticipantObservation | null {
    return input.participantId == null
      ? localParticipant(context.observation.participants)
      : context.observation.participants.find(
          ({ participantId }) => participantId === input.participantId,
        ) ?? null;
  }
}

function localParticipant(
  participants: readonly RaceParticipantObservation[],
): RaceParticipantObservation | null {
  return (
    participants.find(({ participantKind }) => participantKind === "player") ??
    null
  );
}
