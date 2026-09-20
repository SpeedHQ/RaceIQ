import type { TelemetryVariableId } from "../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CrewChiefTriggerFunction, CrewChiefTriggerDraftV1, CrewChiefTriggerInputV1 } from "./contracts";
import type { PreviousValueState } from "./common";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arr = (v: unknown): readonly unknown[] | undefined => Array.isArray(v) ? v : undefined;
const draft = (eventKey: string, payload: Record<string, CrewChiefTriggerDraftV1["payload"][string]>, evidenceSemanticIds: TelemetryVariableId[]): CrewChiefTriggerDraftV1 => ({ eventKey, severity: "info", payload, evidenceSemanticIds });

const index = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 0;
const outOfPits = (value: unknown): boolean => value === false || value === "out";
const disarm = (state: PreviousValueState): null => { state.armed = false; state.previous = undefined; return null; };
const roster = (
  input: CrewChiefTriggerInputV1,
  columns: readonly (readonly unknown[] | undefined)[],
): { cars: readonly number[]; drivers: readonly string[] } | null => {
  const cars = arr(input.frame.ok("race.competitor.car-index"));
  const drivers = arr(input.frame.ok("race.competitor.driver-id"));
  if (!cars || !drivers || !cars.length || cars.length > 64 || drivers.length !== cars.length ||
      !columns.every(column => column?.length === cars.length)) return null;
  const seen = new Set<number>();
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const driver = drivers[i];
    if (!index(car) || seen.has(car) || typeof driver !== "string" || !driver.trim()) return null;
    seen.add(car);
  }
  return { cars: cars as readonly number[], drivers: drivers as readonly string[] };
};

type GapTrend = "closing" | "growing";
type GapSample = {
  car: number; driver: string; gap: number; sampledAt: number;
  announcedTrend: GapTrend | null; announcedAt: number;
};
type TimingState = {
  player: number; driver: string; position: number; observedAt: number;
  ahead?: GapSample; behind?: GapSample;
};
const timingEvidence = [
  "session.session-type", "session.session-state", "identity.player-car-index", "race.pit-status",
  "race.competitor.car-index", "race.competitor.driver-id", "race.competitor.position", "race.competitor.pit-status",
] satisfies TelemetryVariableId[];

export const triggerTimings: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  if (input.context.simulator !== "acc") return disarm(state);
  const phase = input.frame.ok("session.session-state");
  if (input.frame.ok("session.session-type") !== "race" || phase !== 5 ||
      !outOfPits(input.frame.ok("race.pit-status")) || input.context.caution || input.context.spectating) return disarm(state);
  const positions = arr(input.frame.ok("race.competitor.position"));
  const pits = arr(input.frame.ok("race.competitor.pit-status"));
  const connected = arr(input.frame.ok("race.competitor.connected"));
  const identity = roster(input, [positions, pits, connected]);
  const player = input.frame.ok("identity.player-car-index");
  const now = input.sessionTimeMs;
  if (!identity || !positions || !pits || !index(player) || !finite(now)) return disarm(state);
  const playerRow = identity.cars.indexOf(player);
  const position = positions[playerRow];
  if (playerRow < 0 || !index(position) || position < 1 || !outOfPits(pits[playerRow]) ||
      connected?.[playerRow] !== true) return disarm(state);
  const positivePositions = positions.filter((value) => index(value) && value > 0);
  if (new Set(positivePositions).size !== positivePositions.length) return disarm(state);
  const driver = identity.drivers[playerRow]!;
  let previous = state.armed ? state.previous as TimingState : undefined;
  if (!previous || now < previous.observedAt || previous.player !== player ||
      previous.driver !== driver || previous.position !== position) {
    previous = { player, driver, position, observedAt: now };
  }
  previous.observedAt = now;
  state.armed = true;
  state.previous = previous;
  const events: CrewChiefTriggerDraftV1[] = [];
  for (const side of ["ahead", "behind"] as const) {
    const row = positions.indexOf(position + (side === "ahead" ? -1 : 1));
    const rawGap = input.frame.ok(side === "ahead" ? "timing.gap-ahead-ms" : "timing.gap-behind-ms");
    const gap = finite(rawGap) ? rawGap / 1000 : undefined;
    if (row < 0 || !outOfPits(pits[row]) || connected?.[row] !== true ||
        !finite(gap) || gap < 0 || gap > 120) {
      delete previous[side];
      continue;
    }
    const car = identity.cars[row]!;
    const competitorDriver = identity.drivers[row]!;
    const sample = previous[side];
    if (!sample || sample.car !== car || sample.driver !== competitorDriver) {
      previous[side] = { car, driver: competitorDriver, gap, sampledAt: now, announcedTrend: null, announcedAt: now - 30_000 };
      continue;
    }
    if (now - sample.sampledAt < 10_000) continue;
    const previousGapSeconds = sample.gap;
    const changeSeconds = gap - previousGapSeconds;
    sample.gap = gap;
    sample.sampledAt = now;
    const trend: GapTrend | null = changeSeconds <= -1 ? "closing" : changeSeconds >= 1 ? "growing" : null;
    if (!trend || trend === sample.announcedTrend || now - sample.announcedAt < 30_000) continue;
    sample.announcedTrend = trend;
    sample.announcedAt = now;
    events.push({
      ...draft(`gap-${side}-${trend}`, { competitorIndex: car, gapSeconds: gap, previousGapSeconds, changeSeconds },
        [...timingEvidence, "race.competitor.connected", side === "ahead" ? "timing.gap-ahead-ms" : "timing.gap-behind-ms"]),
      subjectId: String(car),
    });
  }
  return events.length ? events : null;
};

// No watch selection exists in the engineer input/config; never invent watched cars.
export const triggerWatchedOpponents: CrewChiefTriggerFunction<PreviousValueState> = () => null;

// ACC, AC Evo and Forza do not publish a source-backed skill rating.
export const triggerRatings: CrewChiefTriggerFunction<PreviousValueState> = () => null;

type DriverState = { observedAt: number; drivers: Map<number, string> };
export const triggerDriverSwaps: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  if (input.context.simulator !== "acc") return disarm(state);
  const connected = arr(input.frame.ok("race.competitor.connected"));
  const identity = roster(input, [connected]);
  if (!identity || !finite(input.sessionTimeMs)) return disarm(state);
  const previous = state.armed ? state.previous as DriverState : undefined;
  const drivers = new Map<number, string>();
  const events: CrewChiefTriggerDraftV1[] = [];
  for (let i = 0; i < identity.cars.length; i++) {
    if (connected?.[i] !== true) continue;
    const car = identity.cars[i]!;
    const driver = identity.drivers[i]!;
    const prior = previous && input.sessionTimeMs >= previous.observedAt ? previous.drivers.get(car) : undefined;
    drivers.set(car, driver);
    if (prior === undefined || prior === driver) continue;
    events.push({
      ...draft("driver-changed", { competitorIndex: car, previousDriverId: prior, driverId: driver },
        ["race.competitor.car-index", "race.competitor.driver-id", "race.competitor.connected"]),
      subjectId: String(car),
    });
  }
  state.armed = true;
  state.previous = { observedAt: input.sessionTimeMs, drivers } satisfies DriverState;
  return events.length ? events : null;
};

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
