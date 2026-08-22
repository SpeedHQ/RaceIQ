import type { SemanticLapFrame } from "./semantic-frame";
import { wheelStatesFromSignals } from "./physics/vehicle";

/**
 * Time-loss estimation primitives for lap insights.
 *
 * Every estimate here is deliberately *within-window only*: it accounts for the
 * time lost between the first and last frame of a detected event and makes no
 * attempt to model the speed the car would have carried down the following
 * straight. That makes each number a conservative underestimate, which is the
 * safe direction — a detector that under-reports its cost is merely ranked too
 * low, whereas an over-reported cost poisons the weakness ranking and gets
 * narrated to the driver as fact.
 *
 * Consequently these values must never be summed into a "total time lost this
 * lap": separate detectors routinely fire on the same stretch of track (a
 * wheelspin event and a micro-lift, for example) and their costs overlap.
 */

/** Minimum clean samples needed in a speed bin before it can serve as a reference. */
const MIN_REFERENCE_SAMPLES = 10;
/** Speed bin width for the acceleration reference, m/s. */
const REFERENCE_BIN_M_S = 10;
/** Losses below this are indistinguishable from sampling noise. */
export const MIN_REPORTABLE_LOSS_S = 0.02;

/** Sum of the timesteps covering frames [start, end]. */
function windowDuration(dt: number[], start: number, end: number): number {
  let duration = 0;
  for (let i = start; i <= end; i++) {
    const step = dt[i];
    if (typeof step !== "number" || !Number.isFinite(step) || step < 0) return Number.NaN;
    duration += step;
  }
  return duration;
}

/** Distance covered over frames [start, end], metres (Speed is m/s). */
function windowDistance(telemetry: SemanticLapFrame[], dt: number[], start: number, end: number): number {
  let distance = 0;
  for (let i = start; i <= end; i++) {
    const frame = telemetry[i];
    const step = dt[i];
    const speed = frame?.speedMps;
    if (typeof speed !== "number" || !Number.isFinite(speed) || typeof step !== "number" || !Number.isFinite(step) || step < 0) return Number.NaN;
    distance += speed * step;
  }
  return distance;
}

/**
 * Time lost over [start, end] relative to covering the same ground at `vRef`.
 *
 * Used where the counterfactual is a *speed the driver demonstrably had* (or
 * was entitled to keep) rather than an acceleration the car could produce:
 * coasting, an over-slowed entry, a gap between brake release and throttle.
 *
 * Clamped to [0, window duration]: a window faster than the reference is not a
 * negative loss, it simply isn't a loss, and no in-window fault can cost more
 * time than the window itself took.
 */
export function speedDeficitLoss(telemetry: SemanticLapFrame[], dt: number[], start: number, end: number, vRef: number): number {
  if (end <= start || !Number.isFinite(vRef) || vRef <= 0) return 0;
  const actual = windowDuration(dt, start, end);
  const distance = windowDistance(telemetry, dt, start, end);
  if (!Number.isFinite(actual) || !Number.isFinite(distance)) return 0;
  const loss = actual - distance / vRef;
  return Math.max(0, Math.min(loss, actual));
}

/**
 * Median longitudinal acceleration the car achieves under clean full throttle,
 * binned by speed. This is the empirical "what this car can do here" curve, so
 * the counterfactual is measured from the same lap rather than assumed.
 */
export interface AccelReference {
  /** Median m/s² per speed bin; undefined where too few clean samples exist. */
  bins: (number | undefined)[];
}

export function buildAccelReference(telemetry: SemanticLapFrame[], dt: number[]): AccelReference {
  const samples: number[][] = [];
  for (let i = 0; i < telemetry.length - 1; i++) {
    const frame = telemetry[i];
    const next = telemetry[i + 1];
    const step = dt[i];
    if (!frame || !next || typeof step !== "number" || !Number.isFinite(step) || step <= 0) continue;
    // Clean reference frame: full throttle, no brake, no wheel slip, moving.
    if (
      typeof frame.throttleInput !== "number" ||
      !Number.isFinite(frame.throttleInput) ||
      typeof frame.brakeInput !== "number" ||
      !Number.isFinite(frame.brakeInput) ||
      typeof frame.speedMps !== "number" ||
      !Number.isFinite(frame.speedMps) ||
      typeof next.speedMps !== "number" ||
      !Number.isFinite(next.speedMps) ||
      frame.throttleInput <= 230 ||
      frame.brakeInput >= 5 ||
      frame.speedMps < 5
    )
      continue;
    const wheelStates = wheelStatesFromSignals(frame.speedMps, frame.steeringInput, frame.wheelRotationRadPerSec);
    if (wheelStates === null || wheelStates.fl.state === "spin" || wheelStates.fr.state === "spin" || wheelStates.rl.state === "spin" || wheelStates.rr.state === "spin") continue;

    const acceleration = (next.speedMps - frame.speedMps) / step;
    // Discard physically implausible steps (packet reordering, respawns).
    if (!Number.isFinite(acceleration) || Math.abs(acceleration) > 30) continue;

    const bin = Math.floor(frame.speedMps / REFERENCE_BIN_M_S);
    const binSamples = samples[bin] ?? (samples[bin] = []);
    binSamples.push(acceleration);
  }

  const bins: (number | undefined)[] = [];
  for (let bin = 0; bin < samples.length; bin++) {
    const binSamples = samples[bin];
    if (!binSamples || binSamples.length < MIN_REFERENCE_SAMPLES) continue;
    binSamples.sort((left, right) => left - right);
    const median = binSamples[Math.floor(binSamples.length / 2)];
    if (median !== undefined) bins[bin] = median;
  }
  return { bins };
}

/** Reference acceleration at a given speed, or undefined if that bin is unsupported. */
function refAccelAt(ref: AccelReference, speed: number): number | undefined {
  return ref.bins[Math.floor(Math.max(0, speed) / REFERENCE_BIN_M_S)];
}

/**
 * Time lost over [start, end] because the car accelerated worse than it
 * demonstrably can at those speeds.
 *
 * Re-integrates the window using the reference acceleration wherever the car
 * actually did worse (never better — this only removes the deficit, it does not
 * invent performance the driver never showed), then reports how much sooner the
 * counterfactual run would have covered the same distance.
 *
 * Returns undefined when the reference has no data for the speeds involved, so
 * callers can omit the estimate instead of extrapolating one.
 */
export function accelDeficitLoss(telemetry: SemanticLapFrame[], dt: number[], start: number, end: number, ref: AccelReference): number | undefined {
  if (end <= start) return 0;

  const actualTime = windowDuration(dt, start, end);
  const distance = windowDistance(telemetry, dt, start, end);
  if (!Number.isFinite(actualTime) || !Number.isFinite(distance)) return undefined;
  if (distance <= 0) return 0;

  const startSpeed = telemetry[start]?.speedMps;
  if (typeof startSpeed !== "number" || !Number.isFinite(startSpeed)) return undefined;
  let speed = startSpeed;
  let covered = 0;
  let time = 0;
  let sawReference = false;

  for (let i = start; i <= end && covered < distance; i++) {
    const stepDuration = dt[i];
    const frame = telemetry[i];
    const next = telemetry[Math.min(i + 1, telemetry.length - 1)];
    const currentSpeed = frame?.speedMps;
    const nextSpeed = next?.speedMps;
    if (
      typeof currentSpeed !== "number" ||
      !Number.isFinite(currentSpeed) ||
      typeof nextSpeed !== "number" ||
      !Number.isFinite(nextSpeed) ||
      typeof stepDuration !== "number" ||
      !Number.isFinite(stepDuration) ||
      stepDuration <= 0
    )
      return undefined;
    const referenceAcceleration = refAccelAt(ref, speed);
    if (referenceAcceleration === undefined || !Number.isFinite(referenceAcceleration)) return undefined;
    sawReference = true;

    const actualAcceleration = (nextSpeed - currentSpeed) / stepDuration;
    const acceleration = Math.max(referenceAcceleration, Number.isFinite(actualAcceleration) ? actualAcceleration : referenceAcceleration);

    const step = Math.min(stepDuration, (distance - covered) / Math.max(speed, 1e-6));
    covered += speed * step;
    time += step;
    speed = Math.max(0, speed + acceleration * step);
  }

  if (!sawReference) return undefined;

  // Any distance the counterfactual has not yet covered is closed at its
  // (higher) exit speed — otherwise a faster run would be credited with less
  // distance rather than less time.
  if (covered < distance && speed > 0) time += (distance - covered) / speed;

  const loss = actualTime - time;
  return Math.max(0, Math.min(loss, actualTime));
}

/** Round for display/storage, dropping values indistinguishable from noise. */
export function reportableLoss(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < MIN_REPORTABLE_LOSS_S) return undefined;
  return Math.round(seconds * 100) / 100;
}

/** Sum of per-event losses, or undefined if no event could be quantified. */
export function sumLosses(losses: (number | undefined)[]): number | undefined {
  let total = 0;
  let any = false;
  for (const loss of losses) {
    if (typeof loss !== "number" || !Number.isFinite(loss)) continue;
    total += loss;
    any = true;
  }
  return any ? total : undefined;
}
