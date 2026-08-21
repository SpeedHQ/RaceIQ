import { createHash } from "node:crypto";

import type { PitObservationState, PitServiceAction } from "../../../shared/racing/events/contracts";
import type { FourCornerRaceEventValue, RaceParticipantObservation } from "../../games/types";
import { EVENT_ORDER_PRIORITY, type DetectorContext, type DetectorEventDraft } from "../types";

export const PIT_SERVICE_DETECTOR_ID = "pit-service";
export const PIT_SERVICE_DETECTOR_VERSION = "2";

const LOW_SPEED_MPS = 0.5;
const HIGH_SPEED_MPS = 2;
const STALL_CONFIRMATION_MS = 500;
const FUEL_INCREASE_LITRES = 0.1;
const TIRE_WEAR_DECREASE = 0.05;
const DAMAGE_DECREASE = 1;

interface TimedCandidate {
  timeMs: number;
  observations: number;
}

interface PitVisit {
  lifecycleId: string;
  startTimeMs: number;
  enteredObserved: boolean;
  stallObserved: boolean;
  stallEvidence: "observed" | "inferred" | null;
  serviceStarted: boolean;
  serviceStartTimeMs: number | null;
  observedActions: Set<PitServiceAction>;
}

interface PitParticipantState {
  state: PitObservationState;
  last: RaceParticipantObservation;
  visit: PitVisit | null;
  lowSpeed: TimedCandidate | null;
  highSpeed: TimedCandidate | null;
}

function lifecycleId(context: DetectorContext, participantId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([context.sessionId, participantId, context.timelineEpoch, context.boundaryKey]))
    .digest("hex");
  return `pit-visit:sha256:${digest}`;
}

function transitionDraft(
  context: DetectorContext,
  participant: RaceParticipantObservation,
  eventType: "pit_entry" | "pit_stall_arrival" | "pit_stall_departure" | "pit_exit",
  previousState: PitObservationState,
  state: PitObservationState,
  visit: PitVisit,
  evidenceKind: "observed" | "inferred" = "observed",
): DetectorEventDraft {
  return {
    eventType,
    payload: { previousState, state },
    detectorId: PIT_SERVICE_DETECTOR_ID,
    detectorVersion: PIT_SERVICE_DETECTOR_VERSION,
    priority: EVENT_ORDER_PRIORITY.pitVisit,
    boundaryKey: `${context.boundaryKey}:${eventType}:${participant.participantId}`,
    participant,
    lifecycleId: visit.lifecycleId,
    evidenceKind,
    confidence: evidenceKind === "observed" ? "high" : "medium",
    qualityState: "available",
  };
}

function serviceDraft(
  context: DetectorContext,
  participant: RaceParticipantObservation,
  visit: PitVisit,
  eventType: DetectorEventDraft["eventType"],
  payload: DetectorEventDraft["payload"],
  suffix: string = eventType ?? "event",
  qualityState: DetectorEventDraft["qualityState"] = "available",
): DetectorEventDraft {
  const rangedStart = eventType === "pit_service_completed" ? visit.serviceStartTimeMs : eventType === "drive_through_observed" || eventType === "pit_visit_incomplete" ? visit.startTimeMs : null;
  return {
    eventType,
    payload,
    detectorId: PIT_SERVICE_DETECTOR_ID,
    detectorVersion: PIT_SERVICE_DETECTOR_VERSION,
    priority: eventType === "pit_service_completed" || eventType === "drive_through_observed" || eventType === "pit_visit_incomplete" ? EVENT_ORDER_PRIORITY.pitVisit : EVENT_ORDER_PRIORITY.pitService,
    boundaryKey: `${context.boundaryKey}:${suffix}:${participant.participantId}`,
    participant,
    lifecycleId: visit.lifecycleId,
    sourceTimeMs: rangedStart ?? undefined,
    sourceEndTimeMs: rangedStart == null ? undefined : context.observation.sourceTimeMs,
    evidenceKind: "derived",
    confidence: qualityState === "ambiguous" ? "low" : "high",
    qualityState,
  } as DetectorEventDraft;
}

function aggregateDamage(damage: Readonly<Record<string, number>> | null): number | null {
  if (damage == null) return null;
  const values = Object.values(damage).filter(Number.isFinite);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function changedTireCorners(previous: FourCornerRaceEventValue | null, current: FourCornerRaceEventValue | null): Array<keyof FourCornerRaceEventValue> {
  if (previous == null || current == null) return [];
  return (["fl", "fr", "rl", "rr"] as const).filter((corner) => previous[corner] - current[corner] >= TIRE_WEAR_DECREASE);
}

function repairedComponents(previous: Readonly<Record<string, number>> | null, current: Readonly<Record<string, number>> | null): string[] {
  if (previous == null || current == null) return [];
  return Object.keys(previous)
    .filter((component) => current[component] != null && previous[component]! - current[component]! >= DAMAGE_DECREASE)
    .sort();
}

export class PitServiceDetector {
  private readonly participants = new Map<string, PitParticipantState>();

  reset(): void {
    this.participants.clear();
  }

  clearParticipant(participantId: string): void {
    this.participants.delete(participantId);
  }

  observe(context: DetectorContext): DetectorEventDraft[] {
    const drafts: DetectorEventDraft[] = [];
    for (const participant of context.observation.participants) {
      drafts.push(...this.observeParticipant(context, participant));
    }
    return drafts;
  }

  finalize(context: DetectorContext): DetectorEventDraft[] {
    const drafts: DetectorEventDraft[] = [];
    for (const state of this.participants.values()) {
      const visit = state.visit;
      if (!visit) continue;
      drafts.push(
        serviceDraft(
          context,
          state.last,
          visit,
          "pit_visit_incomplete",
          {
            durationMs: Math.max(0, context.observation.sourceTimeMs - visit.startTimeMs),
            observedActions: [...visit.observedActions].sort(),
            state: state.state,
          },
          "incomplete",
          "ambiguous",
        ),
      );
      state.visit = null;
    }
    return drafts;
  }

  private observeParticipant(context: DetectorContext, participant: RaceParticipantObservation): DetectorEventDraft[] {
    const existing = this.participants.get(participant.participantId);
    if (!existing || context.seed) {
      const visit = participant.pitState === "pit-lane" || participant.pitState === "pit-stall" ? this.openVisit(context, participant, false) : null;
      this.participants.set(participant.participantId, {
        state: participant.pitState,
        last: participant,
        visit,
        lowSpeed: null,
        highSpeed: null,
      });
      return [];
    }
    if (participant.pitState === "unknown") {
      existing.last = mergeKnown(existing.last, participant);
      return [];
    }

    const drafts: DetectorEventDraft[] = [];
    let visit = existing.visit;
    const visitWasOpen = visit != null;
    let state = existing.state;

    if (state === "out" && (participant.pitState === "pit-lane" || participant.pitState === "pit-stall")) {
      visit = this.openVisit(context, participant, true);
      existing.visit = visit;
      drafts.push(transitionDraft(context, participant, "pit_entry", state, participant.pitState, visit));
      state = participant.pitState;
      if (state === "pit-stall") {
        drafts.push(...this.arriveAtStall(context, participant, existing, visit, "observed", "pit-lane"));
      }
    } else if (participant.pitState === "pit-stall" && state !== "pit-stall") {
      visit ??= this.openVisit(context, participant, false);
      existing.visit = visit;
      drafts.push(...this.arriveAtStall(context, participant, existing, visit, "observed", state));
      state = "pit-stall";
    }

    if (visit != null && visitWasOpen) {
      drafts.push(...this.detectServiceActions(context, participant, existing.last, visit));
    }

    if (state === "pit-lane" && participant.pitState === "pit-lane" && visit) {
      if (participant.speedMps != null && participant.speedMps <= LOW_SPEED_MPS) {
        existing.lowSpeed ??= {
          timeMs: context.observation.sourceTimeMs,
          observations: 0,
        };
        existing.lowSpeed.observations += 1;
        if (existing.lowSpeed.observations >= 2 && context.observation.sourceTimeMs - existing.lowSpeed.timeMs >= STALL_CONFIRMATION_MS) {
          drafts.push(...this.arriveAtStall(context, participant, existing, visit, "inferred", "pit-lane"));
          state = "pit-stall";
          existing.lowSpeed = null;
        }
      } else {
        existing.lowSpeed = null;
      }
    }

    if (state === "pit-stall" && participant.pitState !== "pit-stall" && visit) {
      const directExit = participant.pitState === "out";
      const directLaneDeparture = participant.pitState === "pit-lane" && visit.stallEvidence === "observed";
      if (directExit || directLaneDeparture) {
        drafts.push(...this.completeService(context, participant, visit, "pit-stall"));
        drafts.push(transitionDraft(context, participant, "pit_stall_departure", "pit-stall", "pit-lane", visit));
        state = "pit-lane";
      } else if (participant.speedMps != null && participant.speedMps >= HIGH_SPEED_MPS) {
        existing.highSpeed ??= {
          timeMs: context.observation.sourceTimeMs,
          observations: 0,
        };
        existing.highSpeed.observations += 1;
        if (existing.highSpeed.observations >= 2) {
          drafts.push(...this.completeService(context, participant, visit, "pit-stall"));
          drafts.push(transitionDraft(context, participant, "pit_stall_departure", "pit-stall", "pit-lane", visit, "inferred"));
          state = "pit-lane";
          existing.highSpeed = null;
        }
      } else {
        existing.highSpeed = null;
      }
    }

    if (participant.pitState === "out" && state !== "out" && visit) {
      if (visit.serviceStarted) {
        drafts.push(...this.completeService(context, participant, visit, state));
      } else if (!visit.stallObserved) {
        drafts.push(
          serviceDraft(context, participant, visit, "drive_through_observed", {
            durationMs: Math.max(0, context.observation.sourceTimeMs - visit.startTimeMs),
            observedActions: [],
            state,
          }),
        );
      }
      drafts.push(transitionDraft(context, participant, "pit_exit", state, "out", visit));
      state = "out";
      existing.visit = null;
    }

    existing.state = state;
    existing.last = participant;
    return drafts;
  }

  private openVisit(context: DetectorContext, participant: RaceParticipantObservation, enteredObserved: boolean): PitVisit {
    return {
      lifecycleId: lifecycleId(context, participant.participantId),
      startTimeMs: context.observation.sourceTimeMs,
      enteredObserved,
      stallObserved: participant.pitState === "pit-stall",
      stallEvidence: participant.pitState === "pit-stall" ? "observed" : null,
      serviceStarted: false,
      serviceStartTimeMs: null,
      observedActions: new Set(),
    };
  }

  private arriveAtStall(
    context: DetectorContext,
    participant: RaceParticipantObservation,
    state: PitParticipantState,
    visit: PitVisit,
    evidenceKind: "observed" | "inferred",
    previousState: PitObservationState,
  ): DetectorEventDraft[] {
    visit.stallObserved = true;
    visit.stallEvidence = evidenceKind;
    state.state = "pit-stall";
    const drafts = [transitionDraft(context, participant, "pit_stall_arrival", previousState, "pit-stall", visit, evidenceKind)];
    if (!visit.serviceStarted) {
      visit.serviceStarted = true;
      visit.serviceStartTimeMs = context.observation.sourceTimeMs;
      drafts.push(
        serviceDraft(context, participant, visit, "pit_service_started", {
          trigger: "stall",
        }),
      );
    }
    return drafts;
  }

  private detectServiceActions(context: DetectorContext, current: RaceParticipantObservation, previous: RaceParticipantObservation, visit: PitVisit): DetectorEventDraft[] {
    const drafts: DetectorEventDraft[] = [];
    const fuelAdded = current.fuelLitres != null && previous.fuelLitres != null ? current.fuelLitres - previous.fuelLitres : 0;
    if (fuelAdded >= FUEL_INCREASE_LITRES && !visit.observedActions.has("fuel")) {
      drafts.push(...this.ensureServiceStarted(context, current, visit));
      visit.observedActions.add("fuel");
      drafts.push(
        serviceDraft(context, current, visit, "fuel_service_observed", {
          beforeLitres: previous.fuelLitres!,
          afterLitres: current.fuelLitres!,
          addedLitres: fuelAdded,
        }),
      );
    }

    const corners = changedTireCorners(previous.tireWear, current.tireWear);
    const compoundChanged = previous.tireCompound != null && current.tireCompound != null && previous.tireCompound !== current.tireCompound;
    if ((compoundChanged || corners.length > 0) && !visit.observedActions.has("tires")) {
      drafts.push(...this.ensureServiceStarted(context, current, visit));
      visit.observedActions.add("tires");
      drafts.push(
        serviceDraft(context, current, visit, "tire_service_observed", {
          changedCorners: corners,
          previousCompound: previous.tireCompound,
          currentCompound: current.tireCompound,
          beforeWear: previous.tireWear,
          afterWear: current.tireWear,
        }),
      );
    }

    const previousDamage = aggregateDamage(previous.damage);
    const currentDamage = aggregateDamage(current.damage);
    const repaired = repairedComponents(previous.damage, current.damage);
    if (previousDamage != null && currentDamage != null && previousDamage - currentDamage >= DAMAGE_DECREASE && !visit.observedActions.has("repair")) {
      drafts.push(...this.ensureServiceStarted(context, current, visit));
      visit.observedActions.add("repair");
      drafts.push(
        serviceDraft(context, current, visit, "repair_service_observed", {
          previousComponents: previous.damage ?? {},
          currentComponents: current.damage ?? {},
          repairedComponents: repaired,
        }),
      );
    }

    if (previous.driverId != null && current.driverId != null && previous.driverId !== current.driverId && !visit.observedActions.has("driver")) {
      drafts.push(...this.ensureServiceStarted(context, current, visit));
      visit.observedActions.add("driver");
      drafts.push(
        serviceDraft(context, current, visit, "driver_service_observed", {
          previousDriverId: previous.driverId,
          driverId: current.driverId,
        }),
      );
    }
    return drafts;
  }

  private ensureServiceStarted(context: DetectorContext, participant: RaceParticipantObservation, visit: PitVisit): DetectorEventDraft[] {
    if (visit.serviceStarted) return [];
    visit.serviceStarted = true;
    visit.serviceStartTimeMs = context.observation.sourceTimeMs;
    return [
      serviceDraft(context, participant, visit, "pit_service_started", {
        trigger: "service-observation",
      }),
    ];
  }

  private completeService(context: DetectorContext, participant: RaceParticipantObservation, visit: PitVisit, state: PitObservationState): DetectorEventDraft[] {
    if (!visit.serviceStarted || visit.serviceStartTimeMs == null) return [];
    const actions = [...visit.observedActions].sort();
    visit.serviceStarted = false;
    return [
      serviceDraft(
        context,
        participant,
        visit,
        "pit_service_completed",
        {
          durationMs: Math.max(0, context.observation.sourceTimeMs - visit.serviceStartTimeMs),
          observedActions: actions,
          state,
        },
        "completed",
        actions.length === 0 ? "ambiguous" : "available",
      ),
    ];
  }
}

function mergeKnown(previous: RaceParticipantObservation, current: RaceParticipantObservation): RaceParticipantObservation {
  return {
    ...current,
    pitState: previous.pitState,
    nativePitCode: current.nativePitCode ?? previous.nativePitCode,
    position: current.position ?? previous.position,
    speedMps: current.speedMps ?? previous.speedMps,
    fuelLitres: current.fuelLitres ?? previous.fuelLitres,
    tireCompound: current.tireCompound ?? previous.tireCompound,
    tireWear: current.tireWear ?? previous.tireWear,
    damage: current.damage ?? previous.damage,
    penaltyValue: current.penaltyValue ?? previous.penaltyValue,
    incidentCount: current.incidentCount ?? previous.incidentCount,
  };
}
