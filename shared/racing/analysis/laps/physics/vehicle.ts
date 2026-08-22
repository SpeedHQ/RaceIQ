/**
 * Pure vehicle dynamics calculations shared between server and client.
 * Uses established automotive engineering formulas. No UI/color concerns —
 * presentation helpers live in client/src/lib/vehicle-dynamics.ts.
 */

import type { SemanticLapFrame } from "../semantic-frame";

// ── Slip Ratio (longitudinal) ──────────────────────────────────────
// SAE J670 definition: SR = (Vwheel - Vground) / max(Vwheel, Vground)
// Positive = wheelspin (acceleration), Negative = lockup (braking)
// Range: -1 (full lock) to +inf (full spin on ice), 0 = no slip

export function slipRatio(wheelRotSpeed: number, groundSpeed: number, wheelRadius: number): number {
  if (!Number.isFinite(wheelRotSpeed) || !Number.isFinite(groundSpeed) || !Number.isFinite(wheelRadius)) return Number.NaN;
  const wheelSpeed = Math.abs(wheelRotSpeed) * wheelRadius;
  const vRef = Math.max(wheelSpeed, groundSpeed, 0.1);
  return (wheelSpeed - groundSpeed) / vRef;
}

// ── Effective Wheel Radius ─────────────────────────────────────────
// Derived from average wheel speed vs ground speed when driving straight

export function effectiveWheelRadiusFromSignals(
  speedMps: number | undefined,
  wheelRotationRadPerSec: readonly [number | undefined, number | undefined, number | undefined, number | undefined],
): number | null {
  if (typeof speedMps !== "number" || !Number.isFinite(speedMps) || !finiteWheels(wheelRotationRadPerSec)) return null;
  const fl = Math.abs(wheelRotationRadPerSec[0]);
  const fr = Math.abs(wheelRotationRadPerSec[1]);
  const rl = Math.abs(wheelRotationRadPerSec[2]);
  const rr = Math.abs(wheelRotationRadPerSec[3]);
  const baseRotation = (fl + fr + rl + rr - Math.min(fl, fr, rl, rr) - Math.max(fl, fr, rl, rr)) / 2;
  return baseRotation > 5 && speedMps > 3 ? speedMps / baseRotation : null;
}

export function wheelSlipRatiosFromSignals(
  speedMps: number | undefined,
  wheelRotationRadPerSec: readonly [number | undefined, number | undefined, number | undefined, number | undefined],
): { fl: number; fr: number; rl: number; rr: number } | null {
  if (typeof speedMps !== "number" || !Number.isFinite(speedMps)) return null;
  const wheelRadius = effectiveWheelRadiusFromSignals(speedMps, wheelRotationRadPerSec);
  if (wheelRadius === null || !finiteWheels(wheelRotationRadPerSec)) return null;
  return {
    fl: slipRatio(wheelRotationRadPerSec[0], speedMps, wheelRadius),
    fr: slipRatio(wheelRotationRadPerSec[1], speedMps, wheelRadius),
    rl: slipRatio(wheelRotationRadPerSec[2], speedMps, wheelRadius),
    rr: slipRatio(wheelRotationRadPerSec[3], speedMps, wheelRadius),
  };
}

// ── Friction Circle Utilization ────────────────────────────────────
// Physics-based: combine longitudinal slip ratio and lateral slip
// angle on their own scales. Each axis is normalized to its own peak
// (the point past which a racing tire starts losing grip), then taken
// in quadrature. 1.0 = at peak, >1 = past peak.
//
// Peak slip ratio  ~0.12–0.15  (race rubber on track, SAE J670)
// Peak slip angle  ~8–10°      (≈ 0.14–0.18 rad)
//
// The longitudinal slip is derived from wheel-rotation vs ground
// speed (wheelSlipRatios / slipRatio) — NOT from pkt.TireSlipRatio*,
// which each game reports in its own non-SAE scale. Physical slip-angle
// callers must provide radians.

export const SLIP_RATIO_PEAK = 0.12;
export const SLIP_ANGLE_PEAK_RAD = (8 * Math.PI) / 180; // 8°

export function frictionCircleUtil(slipRatio: number, slipAngleRad: number): number {
  if (!Number.isFinite(slipRatio) || !Number.isFinite(slipAngleRad)) return Number.NaN;
  const rNorm = Math.abs(slipRatio) / SLIP_RATIO_PEAK;
  const aNorm = Math.abs(slipAngleRad) / SLIP_ANGLE_PEAK_RAD;
  return Math.min(Math.hypot(rNorm, aNorm), 2.0);
}

export function frictionCircleFromSignals(
  speedMps: number | undefined,
  wheelRotationRadPerSec: readonly [number | undefined, number | undefined, number | undefined, number | undefined],
  tireSlipAngleRad: readonly [number | undefined, number | undefined, number | undefined, number | undefined],
): { fl: number; fr: number; rl: number; rr: number } | null {
  const slipRatios = wheelSlipRatiosFromSignals(speedMps, wheelRotationRadPerSec);
  if (slipRatios === null || !finiteWheels(tireSlipAngleRad)) return null;
  return {
    fl: frictionCircleUtil(slipRatios.fl, tireSlipAngleRad[0]),
    fr: frictionCircleUtil(slipRatios.fr, tireSlipAngleRad[1]),
    rl: frictionCircleUtil(slipRatios.rl, tireSlipAngleRad[2]),
    rr: frictionCircleUtil(slipRatios.rr, tireSlipAngleRad[3]),
  };
}

// ── Understeer / Oversteer Detection ───────────────────────────────
// Physics-based hybrid using two independent signals. Avoids the
// combined-slip trap where RWD drive wheelspin on a straight line
// shows up as "rear grip utilization" and gets called oversteer.
//
// Signal A — Yaw rate vs path curvature (MoTeC/VBox approach):
//   Steady-state circular motion: ω = Ay / V. If the body rotates
//   faster than that, heading has outrun the velocity vector →
//   oversteer onset. Slower → understeer.
//   No wheelbase, no steering calibration required.
//
// Signal B — Front/rear slip-angle delta (VBox/OptimumG/trophi):
//   Racing tyres peak at ~6–10° slip angle. Whichever axle is
//   running the larger slip angle is the one giving up grip first.
//   front − rear > 0 → understeer, < 0 → oversteer.
//
// Gates — must be cornering to classify anything:
//   • |latG| ≥ LAT_G_FLOOR — straight-line wheelspin/lockup produce
//     no lateral load and never count as balance.
//   • V ≥ SPEED_FLOOR — ignore parking manoeuvres.
//
// Combined signal is normalized so positive = understeer, negative
// = oversteer, magnitude ≈ severity. Classification requires both
// signals to agree (or one of them to be far past its threshold).

const RAD2DEG = 180 / Math.PI;
const G = 9.81; // m/s²
export const LAT_G_FLOOR = 0.25; // g — below this, not really cornering
export const SPEED_FLOOR = 5; // m/s (~18 km/h)
const YAW_ERR_SCALE = 0.3; // rad/s yaw-rate error that counts as "full" severity
const SLIP_DELTA_SCALE = 6; // degrees front-rear slip delta that counts as "full" severity
const CLASSIFY_THRESHOLD = 0.3; // combined-signal magnitude to leave "neutral"

type FiniteWheelValues = readonly [number, number, number, number];

function finiteWheels(values: readonly [number | undefined, number | undefined, number | undefined, number | undefined]): values is FiniteWheelValues {
  return Number.isFinite(values[0]) && Number.isFinite(values[1]) && Number.isFinite(values[2]) && Number.isFinite(values[3]);
}
export function slipBalanceDegFromAngles(slipAngles: readonly [number | undefined, number | undefined, number | undefined, number | undefined]): number | null {
  if (!finiteWheels(slipAngles)) return null;
  const frontSlipDeg = ((Math.abs(slipAngles[0]) + Math.abs(slipAngles[1])) / 2) * RAD2DEG;
  const rearSlipDeg = ((Math.abs(slipAngles[2]) + Math.abs(slipAngles[3])) / 2) * RAD2DEG;
  return frontSlipDeg - rearSlipDeg;
}

export interface SteerBalance {
  // Physics signals
  latG: number; // g, signed (right-positive, matches existing convention)
  yawRate: number; // rad/s, raw body yaw rate
  yawRatePath: number; // rad/s, expected from |latG|·g / V
  yawError: number; // rad/s, |yawRate| − yawRatePath (>0 = over-rotating → oversteer)
  frontSlipDeg: number; // avg front slip angle magnitude (degrees)
  rearSlipDeg: number; // avg rear slip angle magnitude (degrees)
  slipDelta: number; // front − rear (degrees, >0 = understeer, <0 = oversteer)
  slipAvailable: boolean; // whether per-wheel slip-angle signal was available
  // Normalized component signals (both scaled so ±1 = "full" severity)
  uSlip: number; // slip-angle signal: + = understeer, − = oversteer
  uYaw: number; // yaw-rate signal:  + = understeer, − = oversteer
  signalsAgree: boolean; // false = conflict → slip angle used alone
  // Combined normalized balance
  balance: number; // [-1, +1], + = understeer, − = oversteer
  state: "understeer" | "oversteer" | "neutral";
  severity: number; // 0-1, magnitude of |balance| past threshold
}

export interface SemanticBalanceSignals {
  speedMps: number;
  accelerationX: number;
  yawRate: number;
  slipAngles?: readonly [number, number, number, number];
}

/** Packet-free equivalent of steerBalance for canonical semantic replay values. */
export function steerBalanceFromSignals(signals: SemanticBalanceSignals): SteerBalance | null {
  if (!Number.isFinite(signals.speedMps) || !Number.isFinite(signals.accelerationX) || !Number.isFinite(signals.yawRate)) return null;
  const slipAngles = signals.slipAngles;
  const slipAvailable = slipAngles !== undefined && finiteWheels(slipAngles);
  let frontSlipDeg = Number.NaN;
  let rearSlipDeg = Number.NaN;
  let slipDelta = Number.NaN;
  let uSlip = Number.NaN;
  if (slipAvailable) {
    frontSlipDeg = ((Math.abs(slipAngles[0]) + Math.abs(slipAngles[1])) / 2) * RAD2DEG;
    rearSlipDeg = ((Math.abs(slipAngles[2]) + Math.abs(slipAngles[3])) / 2) * RAD2DEG;
    slipDelta = frontSlipDeg - rearSlipDeg;
    uSlip = slipDelta / SLIP_DELTA_SCALE;
  }
  const latG = -signals.accelerationX / G;
  const speed = Math.max(signals.speedMps, 0.1);
  const yawRatePath = Math.abs(latG * G) / speed;
  const yawError = Math.abs(signals.yawRate) - yawRatePath;
  const yawContrib = Math.abs(latG) < LAT_G_FLOOR || speed < SPEED_FLOOR ? 0 : -yawError / YAW_ERR_SCALE;
  const signalsAgree = !slipAvailable || uSlip * yawContrib >= 0;
  const yawActive = Math.abs(yawContrib) > 0.05;
  const slipConfident = slipAvailable && Math.abs(uSlip) >= 0.15;
  const blended = slipAvailable ? 0.5 * uSlip + 0.5 * yawContrib : Number.NaN;
  const balanceRaw = speed < SPEED_FLOOR ? 0 : !slipAvailable ? yawContrib : !signalsAgree || !slipConfident ? uSlip : yawActive && Math.abs(blended) > Math.abs(uSlip) ? blended : uSlip;
  const balance = Math.max(-1.5, Math.min(1.5, balanceRaw));
  const moving = speed >= SPEED_FLOOR;
  const state: SteerBalance["state"] = moving && balance > CLASSIFY_THRESHOLD ? "understeer" : moving && balance < -CLASSIFY_THRESHOLD ? "oversteer" : "neutral";
  return {
    latG,
    yawRate: signals.yawRate,
    yawRatePath,
    yawError,
    frontSlipDeg,
    rearSlipDeg,
    slipDelta,
    slipAvailable,
    uSlip,
    uYaw: -yawError / YAW_ERR_SCALE,
    signalsAgree,
    balance,
    state,
    severity: moving ? Math.min(1, Math.max(0, (Math.abs(balance) - CLASSIFY_THRESHOLD) / (1 - CLASSIFY_THRESHOLD))) : 0,
  };
}

export function wheelStatesFromSignals(
  speedMps: number | undefined,
  steer: number | undefined,
  wheelRotationRadPerSec: readonly [number | undefined, number | undefined, number | undefined, number | undefined],
): { fl: WheelState; fr: WheelState; rl: WheelState; rr: WheelState } | null {
  if (typeof speedMps !== "number" || !Number.isFinite(speedMps) || typeof steer !== "number" || !Number.isFinite(steer) || !finiteWheels(wheelRotationRadPerSec)) return null;
  const wheelRadiusM = effectiveWheelRadiusFromSignals(speedMps, wheelRotationRadPerSec);
  if (wheelRadiusM === null) return null;
  return wheelDynamicsFrame({
    speedMps,
    steer,
    wheelRotationRadS: {
      fl: wheelRotationRadPerSec[0],
      fr: wheelRotationRadPerSec[1],
      rl: wheelRotationRadPerSec[2],
      rr: wheelRotationRadPerSec[3],
    },
    wheelRadiusM,
  });
}

// ── Suspension Compression Distribution ────────────────────────────
// Share of the current normalized shock compression. This can show chassis
// movement, but it is not a measured or estimated tire load.

export interface SuspensionCompression {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
  frontBias: number; // 0-1: share of compression at the front axle
  leftBias: number; // 0-1: share of compression on the left side
}

export function suspensionCompressionBias([fl, fr, rl, rr]: readonly [number, number, number, number]): { front: number; left: number } {
  const total = fl + fr + rl + rr || 1;
  return {
    front: (fl + fr) / total,
    left: (fl + rl) / total,
  };
}

export function suspensionCompression(pkt: SemanticLapFrame): SuspensionCompression | null {
  const travel = pkt.normalizedSuspensionTravel;
  if (!finiteWheels(travel)) return null;
  const { front, left } = suspensionCompressionBias(travel);
  return { fl: travel[0], fr: travel[1], rl: travel[2], rr: travel[3], frontBias: front, leftBias: left };
}

// ── Lockup / Spin Detection (speed-aware) ──────────────────────────
// Uses proper slip ratio instead of percentage comparison.
// Accounts for cornering differential (inner wheels slower).

export interface WheelState {
  state: "grip" | "lockup" | "spin" | "idle";
  slipRatio: number;
}

export function wheelState(
  wheelRotSpeed: number,
  groundSpeed: number,
  wheelRadius: number,
  steerAngle: number, // 0 for rear wheels
  isInnerWheel: boolean,
): WheelState {
  if (groundSpeed < 1.5) return { state: "idle", slipRatio: 0 };

  const sr = slipRatio(wheelRotSpeed, groundSpeed, wheelRadius);

  // Lockup = full stop OR wheel rotating far slower than free-roll
  // (negative slip ratio past peak means tire is dragging, not rolling)
  if (groundSpeed > 3 && (Math.abs(wheelRotSpeed) < 0.5 || sr < -0.2)) {
    return { state: "lockup", slipRatio: sr };
  }

  // In turns, inner wheels naturally rotate slower — widen the threshold
  const steerFactor = Math.abs(steerAngle) / 127; // 0-1
  const spinThreshold = 0.1 + (isInnerWheel ? 0 : steerFactor * 0.05);

  if (sr > spinThreshold) return { state: "spin", slipRatio: sr };
  return { state: "grip", slipRatio: sr };
}

export interface WheelDynamicsFrame {
  speedMps: number;
  steer: number;
  wheelRotationRadS: { fl: number; fr: number; rl: number; rr: number };
  wheelRadiusM: number;
}

/** Semantic wheel-dynamics primitive. Units are canonical SI (m/s, rad/s, m). */
export function wheelDynamicsFrame(frame: WheelDynamicsFrame): {
  fl: WheelState;
  fr: WheelState;
  rl: WheelState;
  rr: WheelState;
} {
  const { speedMps: gs, steer } = frame;
  const turningRight = steer > 5;
  const turningLeft = steer < -5;
  return {
    fl: wheelState(frame.wheelRotationRadS.fl, gs, frame.wheelRadiusM, steer, turningRight),
    fr: wheelState(frame.wheelRotationRadS.fr, gs, frame.wheelRadiusM, steer, turningLeft),
    rl: wheelState(frame.wheelRotationRadS.rl, gs, frame.wheelRadiusM, 0, turningRight),
    rr: wheelState(frame.wheelRotationRadS.rr, gs, frame.wheelRadiusM, 0, turningLeft),
  };
}

// ── Cornering Efficiency ───────────────────────────────────────────
// Ratio of lateral acceleration to combined slip — higher = more efficient cornering.
// Drops when tires are beyond their peak slip angle.

export function corneringEfficiency(pkt: SemanticLapFrame): number | null {
  const accelerationX = pkt.accelerationXMps2;
  const combinedSlip = pkt.tireCombinedSlip;
  if (typeof accelerationX !== "number" || !Number.isFinite(accelerationX) || !finiteWheels(combinedSlip)) return null;
  const latG = Math.abs(accelerationX) / 9.81;
  const avgCombinedSlip = (Math.abs(combinedSlip[0]) + Math.abs(combinedSlip[1]) + Math.abs(combinedSlip[2]) + Math.abs(combinedSlip[3])) / 4;
  if (avgCombinedSlip < 0.01) return 1;
  return Math.min(2, latG / avgCombinedSlip);
}
