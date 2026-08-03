import type { TelemetryPacket } from "../telemetry/types";
import { allWheelStates } from "./physics/vehicle";

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
  let t = 0;
  for (let i = start; i <= end; i++) t += dt[i];
  return t;
}

/** Distance covered over frames [start, end], metres (Speed is m/s). */
function windowDistance(telemetry: TelemetryPacket[], dt: number[], start: number, end: number): number {
  let d = 0;
  for (let i = start; i <= end; i++) d += telemetry[i].Speed * dt[i];
  return d;
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
export function speedDeficitLoss(telemetry: TelemetryPacket[], dt: number[], start: number, end: number, vRef: number): number {
  if (end <= start || vRef <= 0) return 0;
  const actual = windowDuration(dt, start, end);
  const distance = windowDistance(telemetry, dt, start, end);
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

export function buildAccelReference(telemetry: TelemetryPacket[], dt: number[]): AccelReference {
  const samples: number[][] = [];
  for (let i = 0; i < telemetry.length - 1; i++) {
    const p = telemetry[i];
    // Clean reference frame: full throttle, no brake, no wheel slip, moving.
    if (p.Accel <= 230 || p.Brake >= 5 || p.Speed < 5) continue;
    const ws = allWheelStates(p);
    if (ws.fl.state === "spin" || ws.fr.state === "spin" || ws.rl.state === "spin" || ws.rr.state === "spin") continue;

    const a = (telemetry[i + 1].Speed - p.Speed) / dt[i];
    // Discard physically implausible steps (packet reordering, respawns).
    if (!Number.isFinite(a) || Math.abs(a) > 30) continue;

    const bin = Math.floor(p.Speed / REFERENCE_BIN_M_S);
    (samples[bin] ??= []).push(a);
  }

  const bins: (number | undefined)[] = [];
  for (let b = 0; b < samples.length; b++) {
    const s = samples[b];
    if (!s || s.length < MIN_REFERENCE_SAMPLES) continue;
    s.sort((x, y) => x - y);
    bins[b] = s[Math.floor(s.length / 2)];
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
export function accelDeficitLoss(
  telemetry: TelemetryPacket[],
  dt: number[],
  start: number,
  end: number,
  ref: AccelReference,
): number | undefined {
  if (end <= start) return 0;

  const actualTime = windowDuration(dt, start, end);
  const distance = windowDistance(telemetry, dt, start, end);
  if (distance <= 0) return 0;

  let v = telemetry[start].Speed;
  let covered = 0;
  let time = 0;
  let sawReference = false;

  for (let i = start; i <= end && covered < distance; i++) {
    const refA = refAccelAt(ref, v);
    if (refA === undefined) return undefined; // unsupported speed range — do not guess
    sawReference = true;

    const actualA = (telemetry[Math.min(i + 1, telemetry.length - 1)].Speed - telemetry[i].Speed) / dt[i];
    const a = Math.max(refA, Number.isFinite(actualA) ? actualA : refA);

    const step = Math.min(dt[i], (distance - covered) / Math.max(v, 1e-6));
    covered += v * step;
    time += step;
    v = Math.max(0, v + a * step);
  }

  if (!sawReference) return undefined;

  // Any distance the counterfactual has not yet covered is closed at its
  // (higher) exit speed — otherwise a faster run would be credited with less
  // distance rather than less time.
  if (covered < distance && v > 0) time += (distance - covered) / v;

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
  for (const l of losses) {
    if (l === undefined) continue;
    total += l;
    any = true;
  }
  return any ? total : undefined;
}
