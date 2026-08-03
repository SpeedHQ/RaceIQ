/**
 * Pure vehicle dynamics calculations shared between server and client.
 * Uses established automotive engineering formulas. No UI/color concerns —
 * presentation helpers live in client/src/lib/vehicle-dynamics.ts.
 */

import type { TelemetryPacket } from "../../../../telemetry/types";

// ── Slip Ratio (longitudinal) ──────────────────────────────────────
// SAE J670 definition: SR = (Vwheel - Vground) / max(Vwheel, Vground)
// Positive = wheelspin (acceleration), Negative = lockup (braking)
// Range: -1 (full lock) to +inf (full spin on ice), 0 = no slip

export function slipRatio(wheelRotSpeed: number, groundSpeed: number, wheelRadius: number): number {
  const wheelSpeed = Math.abs(wheelRotSpeed) * wheelRadius;
  const vRef = Math.max(wheelSpeed, groundSpeed, 0.1); // avoid div/0
  return (wheelSpeed - groundSpeed) / vRef;
}

// ── Effective Wheel Radius ─────────────────────────────────────────
// Derived from average wheel speed vs ground speed when driving straight

export function effectiveWheelRadius(pkt: TelemetryPacket): number {
  // ACC publishes authoritative per-tire radius in the static page — use it
  // directly (averaged) instead of back-solving from rotation vs ground speed,
  // which is unreliable under slip/lockup and at low speed.
  const accRadii = pkt.acc?.tireRadius;
  if (accRadii && accRadii[0] > 0) {
    return (accRadii[0] + accRadii[1] + accRadii[2] + accRadii[3]) / 4;
  }

  const gs = pkt.Speed; // m/s
  const rotSpeeds = [Math.abs(pkt.WheelRotationSpeedFL), Math.abs(pkt.WheelRotationSpeedFR), Math.abs(pkt.WheelRotationSpeedRL), Math.abs(pkt.WheelRotationSpeedRR)];
  // Use the two slowest wheels — spinning wheels inflate the average and
  // skew slip ratios, causing false lockup detection on non-driven axle
  const sorted = [...rotSpeeds].sort((a, b) => a - b);
  const baseRot = (sorted[0] + sorted[1]) / 2;
  return baseRot > 5 && gs > 3 ? gs / baseRot : 0.33;
}

// ── All four wheel slip ratios ─────────────────────────────────────

export function wheelSlipRatios(pkt: TelemetryPacket): { fl: number; fr: number; rl: number; rr: number } {
  const r = effectiveWheelRadius(pkt);
  const gs = pkt.Speed;
  return {
    fl: slipRatio(pkt.WheelRotationSpeedFL, gs, r),
    fr: slipRatio(pkt.WheelRotationSpeedFR, gs, r),
    rl: slipRatio(pkt.WheelRotationSpeedRL, gs, r),
    rr: slipRatio(pkt.WheelRotationSpeedRR, gs, r),
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
// which each game reports in its own non-SAE scale. Slip angle IS
// radians in all three games (FM/F1/ACC) so we use it directly.

export const SLIP_RATIO_PEAK = 0.12;
export const SLIP_ANGLE_PEAK_RAD = (8 * Math.PI) / 180; // 8°

export function frictionCircleUtil(slipRatio: number, slipAngleRad: number): number {
  const rNorm = Math.abs(slipRatio) / SLIP_RATIO_PEAK;
  const aNorm = Math.abs(slipAngleRad) / SLIP_ANGLE_PEAK_RAD;
  return Math.min(Math.hypot(rNorm, aNorm), 2.0);
}

export function allFrictionCircle(pkt: TelemetryPacket): { fl: number; fr: number; rl: number; rr: number } {
  const sr = wheelSlipRatios(pkt);
  return {
    fl: frictionCircleUtil(sr.fl, pkt.TireSlipAngleFL),
    fr: frictionCircleUtil(sr.fr, pkt.TireSlipAngleFR),
    rl: frictionCircleUtil(sr.rl, pkt.TireSlipAngleRL),
    rr: frictionCircleUtil(sr.rr, pkt.TireSlipAngleRR),
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

export function slipBalanceDeg(pkt: TelemetryPacket): number {
  const frontSlipDeg = ((Math.abs(pkt.TireSlipAngleFL) + Math.abs(pkt.TireSlipAngleFR)) / 2) * RAD2DEG;
  const rearSlipDeg = ((Math.abs(pkt.TireSlipAngleRL) + Math.abs(pkt.TireSlipAngleRR)) / 2) * RAD2DEG;
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
  // Normalized component signals (both scaled so ±1 = "full" severity)
  uSlip: number; // slip-angle signal: + = understeer, − = oversteer
  uYaw: number; // yaw-rate signal:  + = understeer, − = oversteer
  signalsAgree: boolean; // false = conflict → slip angle used alone
  // Combined normalized balance
  balance: number; // [-1, +1], + = understeer, − = oversteer
  state: "understeer" | "oversteer" | "neutral";
  severity: number; // 0-1, magnitude of |balance| past threshold
}

export function steerBalance(pkt: TelemetryPacket): SteerBalance {
  const frontSlipDeg = ((Math.abs(pkt.TireSlipAngleFL) + Math.abs(pkt.TireSlipAngleFR)) / 2) * RAD2DEG;
  const rearSlipDeg = ((Math.abs(pkt.TireSlipAngleRL) + Math.abs(pkt.TireSlipAngleRR)) / 2) * RAD2DEG;
  const slipDelta = slipBalanceDeg(pkt);

  const latG = -pkt.AccelerationX / G;
  const speed = Math.max(pkt.Speed, 0.1);
  const yawRate = pkt.AngularVelocityY;

  // Path-curvature yaw rate: in steady cornering, ω = Ay / V.
  // Compared in magnitudes to stay agnostic of per-game yaw/lat-g
  // sign conventions — the sign of the balance comes from slipDelta.
  const yawRatePath = Math.abs(latG * G) / speed;
  const yawError = Math.abs(yawRate) - yawRatePath;

  const gated = Math.abs(latG) < LAT_G_FLOOR || speed < SPEED_FLOOR;

  // Normalize both signals so positive = understeer, negative = oversteer.
  const uSlip = slipDelta / SLIP_DELTA_SCALE; // front > rear → positive
  const uYaw = -yawError / YAW_ERR_SCALE; // over-rotating → negative

  // Slip angle is lateral-only — unaffected by straight-line wheelspin, so
  // it doesn't need the latG gate. Gate only the yaw signal (which can
  // misread longitudinal yaw from acceleration/braking as oversteer).
  const yawContrib = gated ? 0 : uYaw;
  const signalsAgree = uSlip * yawContrib >= 0;
  // Only blend when yaw is actively contributing — otherwise it just dilutes
  // the slip signal. Use slip alone when yaw is gated or near zero.
  const yawActive = Math.abs(yawContrib) > 0.05;
  // When slip angles are nearly balanced (|uSlip| < 0.15), the tires are
  // reporting neutral. Don't let a yaw spike override that — yaw can be
  // driven by rear wheelspin / diff torque independent of cornering balance.
  const slipConfident = Math.abs(uSlip) >= 0.15;
  // Slip angle is always authoritative. Yaw can only amplify in the same
  // direction — never reduce. If the blend moves the result closer to zero
  // than slip alone, discard it and use slip alone.
  const blended = 0.5 * uSlip + 0.5 * yawContrib;
  const balanceRaw =
    speed < SPEED_FLOOR
      ? 0
      : !signalsAgree || !slipConfident
        ? uSlip // conflict or slip neutral → slip only
        : yawActive && Math.abs(blended) > Math.abs(uSlip)
          ? blended // yaw amplifies → use blend
          : uSlip; // yaw dilutes or silent → slip only
  const balance = Math.max(-1.5, Math.min(1.5, balanceRaw));

  const moving = speed >= SPEED_FLOOR;
  let state: SteerBalance["state"] = "neutral";
  if (moving) {
    if (balance > CLASSIFY_THRESHOLD) state = "understeer";
    else if (balance < -CLASSIFY_THRESHOLD) state = "oversteer";
  }

  const severity = moving ? Math.min(1, Math.max(0, (Math.abs(balance) - CLASSIFY_THRESHOLD) / (1 - CLASSIFY_THRESHOLD))) : 0;

  return {
    latG,
    yawRate,
    yawRatePath,
    yawError,
    frontSlipDeg,
    rearSlipDeg,
    slipDelta,
    uSlip,
    uYaw,
    signalsAgree,
    balance,
    state,
    severity,
  };
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

export function suspensionCompression(pkt: TelemetryPacket): SuspensionCompression {
  const fl = pkt.NormSuspensionTravelFL;
  const fr = pkt.NormSuspensionTravelFR;
  const rl = pkt.NormSuspensionTravelRL;
  const rr = pkt.NormSuspensionTravelRR;
  const total = fl + fr + rl + rr || 1;

  return {
    fl,
    fr,
    rl,
    rr,
    frontBias: (fl + fr) / total,
    leftBias: (fl + rl) / total,
  };
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

export function allWheelStates(pkt: TelemetryPacket): {
  fl: WheelState;
  fr: WheelState;
  rl: WheelState;
  rr: WheelState;
} {
  const r = effectiveWheelRadius(pkt);
  const gs = pkt.Speed;
  const steer = pkt.Steer; // -128 to 127
  // Determine which side is inner in the turn
  const turningRight = steer > 5;
  const turningLeft = steer < -5;

  return {
    fl: wheelState(pkt.WheelRotationSpeedFL, gs, r, steer, turningRight),
    fr: wheelState(pkt.WheelRotationSpeedFR, gs, r, steer, turningLeft),
    rl: wheelState(pkt.WheelRotationSpeedRL, gs, r, 0, turningRight),
    rr: wheelState(pkt.WheelRotationSpeedRR, gs, r, 0, turningLeft),
  };
}

// ── Cornering Efficiency ───────────────────────────────────────────
// Ratio of lateral acceleration to combined slip — higher = more efficient cornering.
// Drops when tires are beyond their peak slip angle.

export function corneringEfficiency(pkt: TelemetryPacket): number {
  const latG = Math.abs(pkt.AccelerationX) / 9.81;
  const avgCombinedSlip = (Math.abs(pkt.TireCombinedSlipFL) + Math.abs(pkt.TireCombinedSlipFR) + Math.abs(pkt.TireCombinedSlipRL) + Math.abs(pkt.TireCombinedSlipRR)) / 4;

  if (avgCombinedSlip < 0.01) return 1; // not cornering
  return Math.min(2, latG / avgCombinedSlip);
}
