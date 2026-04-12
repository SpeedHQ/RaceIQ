/**
 * Vehicle dynamics calculations for telemetry analysis.
 * Uses established automotive engineering formulas.
 */

import type { TelemetryPacket } from "@shared/types";

// ── Semantic Color Palette ────────────────────────────────────────
// Reads from CSS custom properties defined in index.css (--dynamics-*).
// Use COLORS for inline styles / SVG attributes, COLOR_VARS for CSS var() refs.

// CSS var() references — use in inline styles and DOM SVG attributes
export const COLOR_VARS = {
  green:  "var(--dynamics-green)",
  yellow: "var(--dynamics-yellow)",
  amber:  "var(--dynamics-amber)",
  orange: "var(--dynamics-orange)",
  red:    "var(--dynamics-red)",
  blue:   "var(--dynamics-blue)",
  gray:   "var(--dynamics-gray)",
} as const;

// Raw hex values — use in canvas, WebGL, Three.js, or anywhere
// CSS var() can't be resolved. Keep in sync with index.css :root --dynamics-*.
export const COLORS_HEX = {
  green:  "#34d399",
  yellow: "#fbbf24",
  amber:  "#f59e0b",
  orange: "#fb923c",
  red:    "#ef4444",
  blue:   "#3b82f6",
  gray:   "#94a3b8",
} as const;

// Default export uses CSS vars — works in React inline styles and SVG
export const COLORS = COLOR_VARS;

// Tailwind utility classes using the theme tokens
export const COLOR_CLASSES = {
  green:  "text-dynamics-green",
  yellow: "text-dynamics-yellow",
  amber:  "text-dynamics-amber",
  orange: "text-dynamics-orange",
  red:    "text-dynamics-red",
  blue:   "text-dynamics-blue",
  gray:   "text-dynamics-gray",
} as const;

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
  const rotSpeeds = [
    Math.abs(pkt.WheelRotationSpeedFL),
    Math.abs(pkt.WheelRotationSpeedFR),
    Math.abs(pkt.WheelRotationSpeedRL),
    Math.abs(pkt.WheelRotationSpeedRR),
  ];
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

const SLIP_RATIO_PEAK = 0.12;
const SLIP_ANGLE_PEAK_RAD = 8 * Math.PI / 180;  // 8°

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

// ── Tire Traction State ───────────────────────────────────────────
// Single source of truth for tire grip state labels and colors.
// Driven by Grip Ask (friction-circle utilization) so labels and %
// stay consistent — under 100% = within grip budget, over = past peak.
//   LOCK   — wheel rotation has stopped or is dragging (rot-speed pipeline)
//   SPIN   — util > 1 with longitudinal axis dominant
//   SLIDE  — util > 1 with lateral axis dominant
//   SLIP   — 0.90 ≤ util < 1.0 (warning — at the edge of grip)
//   GRIP   — util < 0.90 (operating in the linear region)
//   IDLE   — stationary
//
// All other color derivations (hex, Three.js) must delegate to this.

const GRIP_WARN_UTIL = 0.90;  // start warning at 90% of friction budget

export interface TireState {
  label: "LOCK" | "SPIN" | "IDLE" | "SLIDE" | "SLIP" | "GRIP";
  color: string;   // CSS var — use in React inline styles / SVG
  hex: string;     // Raw hex — use in canvas, WebGL, Three.js
}

export function tireState(
  wheelStateLabel: string,
  slipRatio: number,
  slipAngleRad: number,
): TireState {
  if (wheelStateLabel === "lockup") return { label: "LOCK", color: COLORS.red,  hex: COLORS_HEX.red };
  if (wheelStateLabel === "idle")   return { label: "IDLE", color: COLORS.gray, hex: COLORS_HEX.gray };

  const rNorm = Math.abs(slipRatio) / SLIP_RATIO_PEAK;
  const aNorm = Math.abs(slipAngleRad) / SLIP_ANGLE_PEAK_RAD;
  const util = Math.min(Math.hypot(rNorm, aNorm), 2.0);

  if (util < GRIP_WARN_UTIL) return { label: "GRIP", color: COLORS.green,  hex: COLORS_HEX.green };
  if (util < 1.0)            return { label: "SLIP", color: COLORS.yellow, hex: COLORS_HEX.yellow };

  // Past peak — classify by which axis carries more of the saturation
  if (wheelStateLabel === "spin") return { label: "SPIN",  color: COLORS.orange, hex: COLORS_HEX.orange };
  if (aNorm >= rNorm)             return { label: "SLIDE", color: COLORS.red,    hex: COLORS_HEX.red };
  return                                { label: "SPIN",  color: COLORS.orange, hex: COLORS_HEX.orange };
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
const G = 9.81;                      // m/s²
const LAT_G_FLOOR = 0.25;            // g — below this, not really cornering
const SPEED_FLOOR = 5;               // m/s (~18 km/h)
const YAW_ERR_SCALE = 0.3;           // rad/s yaw-rate error that counts as "full" severity
const SLIP_DELTA_SCALE = 6;          // degrees front-rear slip delta that counts as "full" severity
const CLASSIFY_THRESHOLD = 0.3;      // combined-signal magnitude to leave "neutral"

export interface SteerBalance {
  // Physics signals
  latG: number;            // g, signed (right-positive, matches existing convention)
  yawRate: number;         // rad/s, raw body yaw rate
  yawRatePath: number;     // rad/s, expected from |latG|·g / V
  yawError: number;        // rad/s, |yawRate| − yawRatePath (>0 = over-rotating → oversteer)
  frontSlipDeg: number;    // avg front slip angle magnitude (degrees)
  rearSlipDeg: number;     // avg rear slip angle magnitude (degrees)
  slipDelta: number;       // front − rear (degrees, >0 = understeer, <0 = oversteer)
  // Combined normalized balance
  balance: number;         // [-1, +1], + = understeer, − = oversteer
  state: "understeer" | "oversteer" | "neutral";
  severity: number;        // 0-1, magnitude of |balance| past threshold
}

export function steerBalance(pkt: TelemetryPacket): SteerBalance {
  const frontSlipDeg = (Math.abs(pkt.TireSlipAngleFL) + Math.abs(pkt.TireSlipAngleFR)) / 2 * RAD2DEG;
  const rearSlipDeg  = (Math.abs(pkt.TireSlipAngleRL) + Math.abs(pkt.TireSlipAngleRR)) / 2 * RAD2DEG;
  const slipDelta = frontSlipDeg - rearSlipDeg;

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
  const uSlip = slipDelta / SLIP_DELTA_SCALE;       // front > rear → positive
  const uYaw  = -yawError / YAW_ERR_SCALE;          // over-rotating → negative
  const balanceRaw = gated ? 0 : 0.5 * uSlip + 0.5 * uYaw;
  const balance = Math.max(-1.5, Math.min(1.5, balanceRaw));

  let state: SteerBalance["state"] = "neutral";
  if (!gated) {
    if (balance >  CLASSIFY_THRESHOLD) state = "understeer";
    else if (balance < -CLASSIFY_THRESHOLD) state = "oversteer";
  }

  const severity = gated
    ? 0
    : Math.min(1, Math.max(0, (Math.abs(balance) - CLASSIFY_THRESHOLD) / (1 - CLASSIFY_THRESHOLD)));

  return {
    latG, yawRate, yawRatePath, yawError,
    frontSlipDeg, rearSlipDeg, slipDelta,
    balance, state, severity,
  };
}

// ── Tire Load Estimation ───────────────────────────────────────────
// Approximate vertical load from normalized suspension travel.
// Higher suspension compression = more load on that wheel.
// Useful for detecting weight transfer during braking/cornering.

export interface TireLoads {
  fl: number; fr: number; rl: number; rr: number;
  frontBias: number;  // 0-1: 0.5 = balanced, >0.5 = front-heavy (braking)
  leftBias: number;   // 0-1: 0.5 = balanced, >0.5 = left-heavy (right turn)
}

export function tireLoads(pkt: TelemetryPacket): TireLoads {
  const fl = pkt.NormSuspensionTravelFL;
  const fr = pkt.NormSuspensionTravelFR;
  const rl = pkt.NormSuspensionTravelRL;
  const rr = pkt.NormSuspensionTravelRR;
  const total = fl + fr + rl + rr || 1;

  return {
    fl, fr, rl, rr,
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
  if (groundSpeed > 3 && (Math.abs(wheelRotSpeed) < 0.5 || sr < -0.20)) {
    return { state: "lockup", slipRatio: sr };
  }

  // In turns, inner wheels naturally rotate slower — widen the threshold
  const steerFactor = Math.abs(steerAngle) / 127; // 0-1
  const spinThreshold = 0.10 + (isInnerWheel ? 0 : steerFactor * 0.05);

  if (sr > spinThreshold) return { state: "spin", slipRatio: sr };
  return { state: "grip", slipRatio: sr };
}

export function allWheelStates(pkt: TelemetryPacket): {
  fl: WheelState; fr: WheelState; rl: WheelState; rr: WheelState;
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
  const avgCombinedSlip = (
    Math.abs(pkt.TireCombinedSlipFL) + Math.abs(pkt.TireCombinedSlipFR) +
    Math.abs(pkt.TireCombinedSlipRL) + Math.abs(pkt.TireCombinedSlipRR)
  ) / 4;

  if (avgCombinedSlip < 0.01) return 1; // not cornering
  return Math.min(2, latG / avgCombinedSlip);
}

// ── Color helpers ──────────────────────────────────────────────────

export function slipRatioColor(sr: number): string {
  const a = Math.abs(sr);
  if (a < 0.08) return COLORS.green;
  if (a < 0.15) return COLORS.yellow;
  return COLORS.red;
}

export function frictionUtilColor(util: number): string {
  if (util <= 1.0) return COLORS.green;
  if (util <= 1.1) return COLORS.yellow;
  return COLORS.red;
}

export function balanceColor(state: "understeer" | "oversteer" | "neutral"): string {
  if (state === "neutral") return COLORS.green;
  if (state === "understeer") return COLORS.amber;
  return COLORS.red;
}

// ── Tire Temperature Colors ───────────────────────────────────────
// 4-band: cold / optimal / hot / overheat
// Thresholds are unit-aware (passed in from settings).

export interface TireTempThresholds {
  cold: number;
  warm: number;
  hot: number;
}

/** CSS var color for tire temp (use in DOM/SVG inline styles) */
export function tireTempColor(temp: number, thresholds: TireTempThresholds): string {
  if (temp < thresholds.cold) return COLORS.blue;
  if (temp < thresholds.warm) return COLORS.green;
  if (temp < thresholds.hot) return COLORS.amber;
  return COLORS.red;
}

/** Raw hex color for tire temp (use in canvas/WebGL/Three.js) */
export function tireTempColorHex(temp: number, thresholds: TireTempThresholds): string {
  if (temp < thresholds.cold) return COLORS_HEX.blue;
  if (temp < thresholds.warm) return COLORS_HEX.green;
  if (temp < thresholds.hot) return COLORS_HEX.amber;
  return COLORS_HEX.red;
}

/** Tailwind class for tire temp (used in text elements) */
export function tireTempClass(temp: number, thresholds: TireTempThresholds): string {
  if (temp < thresholds.cold) return "text-dynamics-blue";
  if (temp < thresholds.warm) return "text-dynamics-green";
  if (temp < thresholds.hot) return "text-dynamics-amber";
  return "text-dynamics-red";
}

/** Tailwind bg class for tire temp (used for bar fills) */
export function tireTempBgClass(temp: number, thresholds: TireTempThresholds): string {
  if (temp < thresholds.cold) return "bg-dynamics-blue";
  if (temp < thresholds.warm) return "bg-dynamics-green";
  if (temp < thresholds.hot) return "bg-dynamics-amber";
  return "bg-dynamics-red";
}

/** Human-readable temp label + hex color */
export function tireTempLabel(temp: number, thresholds: TireTempThresholds): { label: string; color: string } {
  if (temp < thresholds.cold) return { label: "COLD", color: COLORS.blue };
  if (temp < thresholds.warm) return { label: "OPT", color: COLORS.green };
  if (temp < thresholds.hot) return { label: "HOT", color: COLORS.amber };
  return { label: "OVER", color: COLORS.red };
}

// ── Tire Health Color ─────────────────────────────────────────────
// Health = 1 - wear (0 = dead, 1 = new). Thresholds are game-specific.

/** Color for tire health (wear is 0=new, 1=dead). Returns CSS var. */
export function tireHealthColor(wear: number, thresholds = { green: 0.70, yellow: 0.40 }): string {
  const health = 1 - wear;
  if (health >= thresholds.green) return COLORS.green;
  if (health >= thresholds.yellow) return COLORS.yellow;
  return COLORS.red;
}

/** Tailwind text class for tire health percentage (0-100). */
export function tireHealthTextClass(healthPct: number, thresholds: number[] = [20, 40, 60, 80]): string {
  const classes = [COLOR_CLASSES.red, COLOR_CLASSES.orange, COLOR_CLASSES.yellow, COLOR_CLASSES.green, COLOR_CLASSES.green];
  for (let i = 0; i < thresholds.length; i++) {
    if (healthPct <= thresholds[i]) return classes[i];
  }
  return classes[classes.length - 1];
}

/** Tailwind bg class for tire health percentage (0-100). */
export function tireHealthBgClass(healthPct: number, thresholds: number[] = [20, 40, 60, 80]): string {
  const classes = ["bg-dynamics-red", "bg-dynamics-orange", "bg-dynamics-yellow", "bg-dynamics-green", "bg-dynamics-green"];
  for (let i = 0; i < thresholds.length; i++) {
    if (healthPct <= thresholds[i]) return classes[i];
  }
  return classes[classes.length - 1];
}

// ── Wear Rate Color ──────────────────────────────────────────────

export function wearRateColor(rate: number | null): string {
  if (rate == null || rate < 0.01) return COLORS.gray;
  if (rate < 0.05) return COLORS.green;
  if (rate < 0.1) return COLORS.yellow;
  return COLORS.red;
}

// ── Brake Temp Color ─────────────────────────────────────────────

export type BrakeTempThresholds = {
  front: { warm: number; hot: number };
  rear:  { warm: number; hot: number };
};

const DEFAULT_BRAKE_THRESHOLDS: BrakeTempThresholds = {
  front: { warm: 450, hot: 700 },
  rear:  { warm: 450, hot: 700 },
};

export type BrakeColor = "red" | "orange" | "blue";

export const BRAKE_COLOR_CLASSES: Record<BrakeColor, { text: string; bg: string }> = {
  red:    { text: "text-red-400",    bg: "bg-red-500"    },
  orange: { text: "text-orange-400", bg: "bg-orange-400" },
  blue:   { text: "text-blue-400",   bg: "bg-blue-400"   },
};

/** Returns a color key for a brake temperature reading. Use with BRAKE_COLOR_CLASSES. */
export function brakeTempColor(
  temp: number,
  isRear: boolean,
  thresholds?: BrakeTempThresholds
): BrakeColor {
  const { warm, hot } = isRear
    ? (thresholds ?? DEFAULT_BRAKE_THRESHOLDS).rear
    : (thresholds ?? DEFAULT_BRAKE_THRESHOLDS).front;
  if (temp > hot)  return "red";
  if (temp > warm) return "orange";
  return "blue";
}

export type PressureColor = "green" | "blue" | "orange" | "gray";

/** Tire pressure color key. Blue under-inflated, orange over-inflated,
 *  green in the optimal range, gray when no data or no thresholds. */
export function tirePressureColor(
  psi: number,
  optimal?: { min: number; max: number },
): PressureColor {
  if (psi <= 0) return "gray";
  if (!optimal) return "gray";
  if (psi < optimal.min) return "blue";
  if (psi > optimal.max) return "orange";
  return "green";
}

// ── Slip Angle Color ──────────────────────────────────────────────

export function slipAngleColor(deg: number): string {
  const a = Math.abs(deg);
  if (a < 4) return COLORS.green;
  if (a < 8) return COLORS.yellow;
  if (a < 14) return COLORS.orange;
  return COLORS.red;
}
