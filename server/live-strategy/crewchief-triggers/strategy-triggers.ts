import type { TelemetryVariableId } from "../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CrewChiefTriggerDraftV1, CrewChiefTriggerFunction, CrewChiefTriggerInputV1 } from "./contracts";
import type { PreviousValueState } from "./common";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const draft = (eventKey: string, severity: CrewChiefTriggerDraftV1["severity"], payload: Record<string, CrewChiefTriggerDraftV1["payload"][string]>, evidence: readonly TelemetryVariableId[]): CrewChiefTriggerDraftV1 => ({ eventKey, severity, payload, evidenceSemanticIds: evidence });
export const triggerPitStops: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => { const current = input.frame.ok("race.pit-status"); if (!state.armed) { state.armed = true; state.previous = current; return null; } const previous = state.previous; state.previous = current; if (current === undefined || previous === undefined || Object.is(current, previous)) return null; const isPit = (value: unknown) => value === true || value === 1 || value === "pit" || value === "in-pit" || value === "pit_lane" || value === "in_pit" || value === "pit-stall"; const wasPit = isPit(previous), nowPit = isPit(current); if (wasPit === nowPit) return null; return draft(nowPit ? "pit-entry" : "pit-exit", "info", { status: nowPit ? "in-pit" : "out-of-pit" }, ["race.pit-status"]); };
type FuelState = PreviousValueState & { previousFuel?: number; lowLatched?: boolean; criticalLatched?: boolean };
export const triggerFuel: CrewChiefTriggerFunction<FuelState> = (input, state) => {
  const f1 = input.frame.simulator === "f1-2025";
  const value = f1 ? input.frame.ok("fuel.laps-remaining") : input.frame.ok("fuel.remaining-volume");
  const perLap = input.frame.ok("fuel.fuel-per-lap");
  if (!f1) {
    const laps = finite(value) && value >= 0 && finite(perLap) && perLap > 0 ? value / perLap : NaN;
    if (!finite(laps)) {
      state.armed = false;
      state.lowLatched = undefined;
      state.criticalLatched = undefined;
      return null;
    }
    if (!state.armed) {
      state.armed = true;
      state.previous = value;
      state.previousFuel = finite(value) ? value : undefined;
      state.lowLatched = laps < 2;
      state.criticalLatched = laps < 1;
      return null;
    }
  }
  if (!state.armed) {
    state.armed = true;
    state.previous = value;
    state.previousFuel = finite(value) ? value : undefined;
    return null;
  }
  if (!finite(value)) return null;
  const laps = f1 ? value : finite(perLap) && perLap > 0 ? value / perLap : NaN;
  state.previous = value;
  state.previousFuel = value;
  if (laps >= 2) {
    state.lowLatched = false;
    state.criticalLatched = false;
    return null;
  }
  const evidence = f1 ? ["fuel.laps-remaining"] as const : ["fuel.remaining-volume", "fuel.fuel-per-lap"] as const;
  if (laps < 1 && !state.criticalLatched) {
    state.criticalLatched = true;
    state.lowLatched = true;
    return draft("fuel-critical", "critical", f1 ? { remainingLaps: laps } : { remainingLaps: laps, remainingVolume: value, fuelPerLap: perLap as number }, evidence);
  }
  if (laps < 2 && !state.lowLatched) {
    state.lowLatched = true;
    return draft("fuel-low", "warning", f1 ? { remainingLaps: laps } : { remainingLaps: laps, remainingVolume: value, fuelPerLap: perLap as number }, evidence);
  }
  return null;
};
// No supported non-F1 packet exposes traction state of charge. Voltage is not SOC.
export const triggerBattery: CrewChiefTriggerFunction<PreviousValueState> = () => null;

type StrategyInput = CrewChiefTriggerInputV1;
type FinishProjection = {
  basis: "timed" | "laps";
  estimatedRaceLapsRemaining: number;
  fuelLapsRemaining: number;
  finalPushWindow: boolean;
  evidence: readonly TelemetryVariableId[];
};
const accFinishEvidence = [
  "timing.session-time-remain", "timing.last-lap", "fuel.remaining-volume", "fuel.fuel-per-lap",
] as const;
const evoTimedFinishEvidence = [
  "race.is-timed-race", "timing.session-time-left-ms", "timing.last-lap", "fuel.laps-remaining",
] as const;
const evoLapFinishEvidence = [
  "race.is-timed-race", "timing.total-laps", "timing.lap-number", "fuel.laps-remaining",
] as const;

const raceRunning = ({ frame, context }: StrategyInput): boolean => {
  if (frame.ok("session.session-type") !== "race" || context.pit || context.spectating || context.formation || context.caution) return false;
  switch (frame.simulator) {
    case "acc": return frame.ok("race.is-race-on") === true && (frame.ok("session.session-state") === undefined || frame.ok("session.session-state") === 5);
    case "ac-evo": return frame.ok("race.is-race-on") === true;
    default: return false;
  }
};

const finishProjection = ({ frame }: StrategyInput): FinishProjection | null => {
  const game = frame.simulator;
  if (game !== "acc" && game !== "ac-evo") return null;
  const nativeFuelLaps = frame.ok("fuel.laps-remaining");
  const volume = frame.ok("fuel.remaining-volume");
  const perLap = frame.ok("fuel.fuel-per-lap");
  const fuelLaps = game === "ac-evo" ? nativeFuelLaps : finite(volume) && volume >= 0 && finite(perLap) && perLap > 0 ? volume / perLap : undefined;
  if (!finite(fuelLaps) || fuelLaps < 0) return null;
  if (game === "ac-evo" && frame.ok("race.is-timed-race") === false) {
    const lap = frame.ok("timing.lap-number");
    const total = frame.ok("timing.total-laps");
    if (!finite(lap) || !finite(total) || !Number.isInteger(lap) || !Number.isInteger(total) || lap < 1 || total < lap) return null;
    const remaining = total - lap + 1;
    return { basis: "laps", estimatedRaceLapsRemaining: remaining, fuelLapsRemaining: fuelLaps, finalPushWindow: remaining <= 2, evidence: evoLapFinishEvidence };
  }
  if (game === "ac-evo" && frame.ok("race.is-timed-race") !== true) return null;
  const nativeTime = frame.ok(game === "acc" ? "timing.session-time-remain" : "timing.session-time-left-ms");
  const lastLap = frame.ok("timing.last-lap");
  if (!finite(nativeTime) || nativeTime <= 0 || !finite(lastLap) || lastLap <= 0) return null;
  const seconds = game === "acc" ? nativeTime : nativeTime / 1000;
  // Timed races finish at a subsequent line crossing, not when the timer hits zero.
  const remaining = seconds / lastLap + 1;
  if (!finite(remaining)) return null;
  return { basis: "timed", estimatedRaceLapsRemaining: remaining, fuelLapsRemaining: fuelLaps, finalPushWindow: seconds <= 2 * lastLap, evidence: game === "acc" ? accFinishEvidence : evoTimedFinishEvidence };
};

export const triggerStrategy: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  if (!raceRunning(input)) {
    state.armed = false;
    state.previous = undefined;
    return null;
  }
  const projection = finishProjection(input);
  if (!projection) { state.armed = false; state.previous = undefined; return null; }
  const reserveLaps = projection.fuelLapsRemaining - projection.estimatedRaceLapsRemaining;
  const wasShort = state.previous === true;
  // Half a lap of reserve is required to clear a deficit, avoiding boundary chatter.
  const short = wasShort ? reserveLaps < 0.5 : reserveLaps < 0;
  state.previous = short;
  if (!state.armed) { state.armed = true; return null; }
  if (short === wasShort) return null;
  return draft(short ? "fuel-save-required" : "fuel-to-finish", short ? "warning" : "info", {
    basis: projection.basis,
    estimatedRaceLapsRemaining: projection.estimatedRaceLapsRemaining,
    fuelLapsRemaining: projection.fuelLapsRemaining,
    reserveLaps,
  }, projection.evidence);
};

export const triggerPushNow: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  if (!raceRunning(input)) {
    state.armed = false;
    state.previous = undefined;
    return null;
  }
  const projection = finishProjection(input);
  if (!projection) { state.armed = false; state.previous = undefined; return null; }
  const reserveLaps = projection.fuelLapsRemaining - projection.estimatedRaceLapsRemaining;
  const push = projection.finalPushWindow && reserveLaps >= 0.5;
  const announced = state.previous === true;
  if (!state.armed) { state.armed = true; state.previous = push; return null; }
  if (!projection.finalPushWindow) state.previous = false;
  if (!push || announced) return null;
  state.previous = true;
  return draft("push-now", "info", {
    reason: "fuel-backed-finish",
    basis: projection.basis,
    estimatedRaceLapsRemaining: projection.estimatedRaceLapsRemaining,
    fuelLapsRemaining: projection.fuelLapsRemaining,
    reserveLaps,
  }, projection.evidence);
};
