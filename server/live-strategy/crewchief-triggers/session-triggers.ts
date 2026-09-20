import type { CrewChiefTriggerFunction, CrewChiefTriggerResultV1 } from "./contracts";
import { createPreviousValueState, type PreviousValueState } from "./common";

export type SessionTriggerState = PreviousValueState;

const unavailable = (): CrewChiefTriggerResultV1 => null;

// ACC broadcast phases are native values: Session=5, SessionOver=6.
const sessionPhase = (frame: Parameters<CrewChiefTriggerFunction<SessionTriggerState>>[0]["frame"]): number | undefined => {
  const maximum = frame.simulator === "acc" ? 8 : undefined;
  const phase = frame.hasFresh("session.session-state") ? frame.ok<number>("session.session-state") : undefined;
  return maximum !== undefined && typeof phase === "number" && Number.isInteger(phase) && phase >= 1 && phase <= maximum
    ? phase
    : undefined;
};

interface StartState {
  phase: number;
  formationAnnounced: boolean;
  greenAnnounced: boolean;
}

interface RaceTimeState {
  nextMilestone: number;
}

const TIME_MILESTONES_SECONDS = [900, 600, 300, 120, 60] as const;

interface SessionEndState {
  phase: number;
  ended: boolean;
}

const position: CrewChiefTriggerFunction<SessionTriggerState> = (input, state): CrewChiefTriggerResultV1 => {
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
  if (frame.simulator === "fm-2023") {
    if (typeof previous !== "number" || !Number.isInteger(previous) || previous < 1) return null;
    return {
      eventKey: "position-changed",
      severity: "info",
      payload: { position: current, scope: "overall" },
      evidenceSemanticIds: ["race.race-position"],
    };
  }
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
  if (frame.simulator === "f1-2025") {
    const currentLap = frame.hasFresh("timing.lap-number") ? frame.ok<number>("timing.lap-number") : undefined;
    const totalLaps = frame.hasFresh("timing.total-laps") ? frame.ok<number>("timing.total-laps") : undefined;
    const current: { currentLap: number; totalLaps: number } | undefined =
      Number.isInteger(currentLap) && Number.isInteger(totalLaps) && (totalLaps as number) > 0
        ? { currentLap: currentLap as number, totalLaps: totalLaps as number }
        : undefined;
    if (!state.armed) {
      state.armed = true;
      state.previous = current;
      return null;
    }
    const previous = state.previous as typeof current;
    state.previous = current;
    if (!current || !previous || current.currentLap !== current.totalLaps || previous.currentLap >= current.totalLaps) return null;
    const event: CrewChiefTriggerResultV1 = {
      eventKey: "final-lap",
      severity: "info",
      payload: { lap: current.currentLap, totalLaps: current.totalLaps },
      evidenceSemanticIds: ["timing.lap-number", "timing.total-laps"],
    };
    return event;
  }
  if (frame.simulator === "iracing") {
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
  }

  const current = sessionPhase(frame);
  if (current === undefined) {
    state.armed = false;
    state.previous = undefined;
    return null;
  }
  const runningPhase = 5;
  if (!state.armed) {
    state.armed = true;
    state.previous = { phase: current, formationAnnounced: current >= 3, greenAnnounced: current >= runningPhase } satisfies StartState;
    return null;
  }
  const previous = state.previous as StartState;
  const eventKey = !previous.formationAnnounced && previous.phase === 2 && current === 3
    ? "pre-lights"
    : !previous.greenAnnounced && previous.phase < runningPhase && current === runningPhase
      ? "green-flag"
      : null;
  previous.phase = current;
  previous.formationAnnounced ||= current >= 3;
  previous.greenAnnounced ||= current >= runningPhase;
  if (eventKey === null) return null;
  return { eventKey, severity: "info", payload: { sessionPhase: eventKey === "pre-lights" ? "formation" : "green" }, evidenceSemanticIds: ["session.session-state"] };
};

const raceTime: CrewChiefTriggerFunction<SessionTriggerState> = ({ frame }, state) => {
  const nativePhase = frame.hasFresh("session.session-state") ? frame.ok<number>("session.session-state") : undefined;
  const evo = frame.simulator === "ac-evo";
  const clockId = evo ? "timing.session-time-left-ms" : "timing.session-time-remain";
  const nativeRemaining = frame.hasFresh(clockId) ? frame.ok<number>(clockId) : undefined;
  const remainingSeconds = typeof nativeRemaining === "number" ? nativeRemaining / (evo ? 1000 : 1) : undefined;
  const raceOn = frame.hasFresh("race.is-race-on") ? frame.ok("race.is-race-on") : undefined;
  const active = (raceOn === true || raceOn === 1) && (frame.simulator === "acc"
    ? frame.hasFresh("session.session-type") && frame.ok("session.session-type") === "race" && (nativePhase === undefined || nativePhase === 5)
    : evo && frame.hasFresh("race.is-timed-race") && frame.ok("race.is-timed-race") === true);
  if (!active || remainingSeconds === undefined || !Number.isFinite(remainingSeconds) || remainingSeconds < 0) {
    state.armed = false;
    state.previous = undefined;
    return null;
  }
  const baseline = !state.armed;
  if (baseline) {
    state.armed = true;
    state.previous = { nextMilestone: 0 } satisfies RaceTimeState;
  }
  const previous = state.previous as RaceTimeState;
  let milestoneSeconds: number | undefined;
  while (previous.nextMilestone < TIME_MILESTONES_SECONDS.length && remainingSeconds <= TIME_MILESTONES_SECONDS[previous.nextMilestone]!) {
    milestoneSeconds = TIME_MILESTONES_SECONDS[previous.nextMilestone++];
  }
  // A joined-in-progress session never announces elapsed milestones. Sparse
  // samples announce only the latest crossing, not a burst of obsolete times.
  if (baseline || milestoneSeconds === undefined || remainingSeconds === 0) return null;
  return {
    eventKey: "race-time-remaining",
    severity: "info",
    payload: { remainingSeconds, milestoneSeconds, minutesRemaining: milestoneSeconds / 60 },
    evidenceSemanticIds: evo
      ? ["timing.session-time-left-ms", "race.is-timed-race", "race.is-race-on"]
      : nativePhase === undefined
        ? ["timing.session-time-remain", "race.is-race-on", "session.session-type"]
        : ["timing.session-time-remain", "race.is-race-on", "session.session-type", "session.session-state"],
  };
};

const sessionEndMessages: CrewChiefTriggerFunction<SessionTriggerState> = ({ frame }, state) => {
  const current = sessionPhase(frame);
  if (current === undefined) {
    state.armed = false;
    state.previous = undefined;
    return null;
  }
  // ACC SessionOver/PostSession/ResultUI are terminal.
  const ended = current >= 6;
  if (!state.armed) {
    state.armed = true;
    state.previous = { phase: current, ended } satisfies SessionEndState;
    return null;
  }
  const previous = state.previous as SessionEndState;
  const announce = ended && !previous.ended && previous.phase >= 5;
  previous.phase = current;
  previous.ended ||= ended;
  if (!announce) return null;
  return {
    eventKey: "session-ended",
    severity: "info",
    payload: { sessionPhase: "finished" },
    evidenceSemanticIds: ["session.session-state"],
  };
};

export const triggerPosition = position;
export const triggerLapCounter = lapCounter;
export const triggerRaceTime = raceTime;
// ACC/AC Evo/Forza do not expose an assigned frozen-order target.
export const triggerFrozenOrderMonitor: CrewChiefTriggerFunction<SessionTriggerState> = unavailable;
export const triggerSessionEndMessages = sessionEndMessages;
export { createPreviousValueState };
