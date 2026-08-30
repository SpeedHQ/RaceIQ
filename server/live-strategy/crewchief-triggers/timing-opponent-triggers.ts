import type { TelemetryVariableId } from "../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CrewChiefTriggerFunction, CrewChiefTriggerDraftV1 } from "./contracts";
import type { PreviousValueState } from "./common";

const nullTrigger = (): CrewChiefTriggerFunction<PreviousValueState> => () => null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arr = (v: unknown): readonly unknown[] | undefined => Array.isArray(v) ? v : undefined;
const draft = (eventKey: string, payload: Record<string, CrewChiefTriggerDraftV1["payload"][string]>, evidenceSemanticIds: TelemetryVariableId[]): CrewChiefTriggerDraftV1 => ({ eventKey, severity: "info", payload, evidenceSemanticIds });

export const triggerTimings = nullTrigger();
export const triggerWatchedOpponents = nullTrigger();
export const triggerRatings = nullTrigger();
export const triggerDriverSwaps = nullTrigger();

export const triggerLapTimes: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  const lap = input.frame.ok("timing.lap-number");
  const valid = input.frame.ok("timing.current-lap-valid");
  const pit = input.frame.ok("race.pit-status");
  const last = input.frame.ok("timing.last-lap");
  const current = { lap, valid, pit };
  const previous = state.previous as typeof current | undefined;
  if (!state.armed) { state.armed = true; state.previous = current; return null; }
  state.previous = current;
  const pitNow = pit === true || (typeof pit === "string" && pit.toLowerCase() !== "out");
  if (!previous || !finite(lap) || !finite(previous.lap) || lap <= previous.lap || previous.valid !== true || pitNow || !finite(last) || last <= 0) return null;
  return draft("lap-completed", { lap: previous.lap, time: last }, ["timing.lap-number", "timing.current-lap-valid", "timing.last-lap", "race.pit-status"]);
};

type OppState = { laps: Map<number, number> };
export const triggerOpponents: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  const cars = arr(input.frame.ok("race.competitor.car-index"));
  const laps = arr(input.frame.ok("race.competitor.laps-complete"));
  if (!cars || !laps || cars.length !== laps.length || cars.length > 64) return null;
  const s = (state.previous && typeof state.previous === "object" && "laps" in state.previous ? state.previous : { laps: new Map<number, number>() }) as OppState;
  if (!state.armed) { state.armed = true; state.previous = s; }
  const events: CrewChiefTriggerDraftV1[] = [];
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const lap = laps[i];
    if (!finite(car) || !finite(lap)) continue;
    const prior = s.laps.get(car);
    if (prior !== undefined && lap > prior) {
      for (let n = prior + 1; n <= lap; n++) {
        events.push(draft("opponent-lap-completed", { competitorIndex: car, lap: n }, ["race.competitor.car-index", "race.competitor.laps-complete"]));
      }
    }
    s.laps.set(car, lap);
  }
  state.previous = s;
  return events.length ? events : null;
};

type MultiState = { latched: Set<number> };
export const triggerMulticlassWarnings: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  const cls = input.frame.ok("identity.player-car-class-id");
  const px = input.frame.ok("motion.position-x");
  const pz = input.frame.ok("motion.position-z");
  const ps = input.frame.ok("motion.speed");
  const classes = arr(input.frame.ok("race.competitor.car-class-id"));
  const cars = arr(input.frame.ok("race.competitor.car-index"));
  const connected = arr(input.frame.ok("race.competitor.connected"));
  const pits = arr(input.frame.ok("race.competitor.pit-status"));
  const xs = arr(input.frame.ok("motion.competitor.position-x"));
  const zs = arr(input.frame.ok("motion.competitor.position-z"));
  const speeds = arr(input.frame.ok("motion.competitor.speed"));
  if (typeof cls !== "string" || !finite(px) || !finite(pz) || !finite(ps) || !classes || !cars || !connected || !pits || !xs || !zs || !speeds || classes.length > 64 || ![cars, connected, pits, xs, zs, speeds].every(a => a.length === classes.length)) return null;
  const s = (state.previous && typeof state.previous === "object" && "latched" in state.previous ? state.previous : { latched: new Set<number>() }) as MultiState;
  if (!state.armed) { state.armed = true; state.previous = s; return null; }
  const next = new Set<number>();
  let event: CrewChiefTriggerDraftV1 | null = null;
  for (let i = 0; i < classes.length; i++) {
    const competitorClass = classes[i];
    const car = cars[i];
    const isConnected = connected[i];
    const pit = pits[i];
    const x = xs[i];
    const z = zs[i];
    const speed = speeds[i];
    if (typeof competitorClass !== "string" || competitorClass === cls || !finite(car) || isConnected !== true || !finite(x) || !finite(z) || !finite(speed) || speed < ps + 5 || pit === true || (typeof pit === "string" && pit !== "out") || Math.hypot(x - px, z - pz) > 25) continue;
    next.add(i);
    if (!s.latched.has(i)) {
      event = event ?? draft("multiclass-traffic", { competitorIndex: car }, ["identity.player-car-class-id", "motion.position-x", "motion.position-z", "motion.speed", "race.competitor.car-index", "race.competitor.connected", "race.competitor.pit-status", "race.competitor.car-class-id", "motion.competitor.position-x", "motion.competitor.position-z", "motion.competitor.speed"]);
    }
  }
  s.latched.clear();
  next.forEach(i => s.latched.add(i));
  state.previous = s;
  return event;
};
