import type { CrewChiefTriggerFunction, CrewChiefTriggerResultV1 } from "./contracts";
import { createPreviousValueState, type PreviousValueState } from "./common";

export type SessionTriggerState = PreviousValueState;

const unavailable = (): CrewChiefTriggerResultV1 => null;

const position: CrewChiefTriggerFunction<SessionTriggerState> = (input, state) => {
  const { frame } = input;
  const current = frame.hasFresh("race.race-position") ? frame.ok<number>("race.race-position") : undefined;
  if (!state.armed) {
    state.armed = true;
    state.previous = current;
    return null;
  }
  const previous = state.previous;
  state.previous = current;
  if (current === undefined || !Number.isInteger(current) || current < 1 || Object.is(current, previous)) return null;
  const playerClass = frame.hasFresh("identity.player-car-class-id") ? frame.ok("identity.player-car-class-id") : undefined;
  const competitorClasses = frame.hasFresh("race.competitor.car-class-id") ? frame.ok<unknown[]>("race.competitor.car-class-id") : undefined;
  if (playerClass === undefined || !Array.isArray(competitorClasses) || competitorClasses.length === 0 || !competitorClasses.every((value) => Object.is(value, playerClass))) return null;
  return {
    eventKey: "position-changed",
    severity: "info",
    payload: { position: current },
    evidenceSemanticIds: ["race.race-position", "identity.player-car-class-id", "race.competitor.car-class-id"],
  };
};

const lapCounter: CrewChiefTriggerFunction<SessionTriggerState> = (input, state) => {
  const { frame } = input;
  const current = frame.hasFresh("session.session-state") ? frame.ok<number>("session.session-state") : undefined;
  if (!state.armed) {
    state.armed = true;
    state.previous = current;
    return null;
  }
  const previous = state.previous;
  state.previous = current;
  if (current === undefined || !Number.isFinite(current) || Object.is(current, previous)) return null;
  const eventKey = previous === 2 && current === 3 ? "pre-lights" : current === 5 && previous !== 5 ? "green-flag" : null;
  if (eventKey === null) return null;
  return { eventKey, severity: "info", payload: { sessionPhase: eventKey === "pre-lights" ? "formation" : "green" }, evidenceSemanticIds: ["session.session-state"] };
};

export const triggerPosition = position;
export const triggerLapCounter = lapCounter;
export const triggerRaceTime: CrewChiefTriggerFunction<SessionTriggerState> = unavailable;
export const triggerFrozenOrderMonitor: CrewChiefTriggerFunction<SessionTriggerState> = unavailable;
export const triggerSessionEndMessages: CrewChiefTriggerFunction<SessionTriggerState> = unavailable;
export { createPreviousValueState };
