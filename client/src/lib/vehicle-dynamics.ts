/**
 * Vehicle dynamics calculations for telemetry analysis.
 * Uses established automotive engineering formulas.
 */

import type { TelemetryPacket } from "@shared/types";

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
// How much of the tire's available grip is being used.
// Uses combined slip as a proxy: sqrt(longSlip² + latSlip²)
// Normalized: 0 = no demand, 1 = at limit, >1 = beyond limit

export function frictionCircleUtil(combinedSlip: number): number {
  // Combined slip of ~1.0 typically represents the grip limit
  return Math.min(combinedSlip / 1.0, 2.0);
}

export function allFrictionCircle(pkt: TelemetryPacket): { fl: number; fr: number; rl: number; rr: number } {
  return {
    fl: frictionCircleUtil(Math.abs(pkt.TireCombinedSlipFL)),
    fr: frictionCircleUtil(Math.abs(pkt.TireCombinedSlipFR)),
    rl: frictionCircleUtil(Math.abs(pkt.TireCombinedSlipRL)),
    rr: frictionCircleUtil(Math.abs(pkt.TireCombinedSlipRR)),
  };
}

// ── Understeer / Oversteer Detection ───────────────────────────────
// Based on front-vs-rear slip angle difference (Milliken method).
// delta = avg(front slip angle) - avg(rear slip angle)
// Positive = understeer (front sliding more), Negative = oversteer (rear sliding more)
// Near zero = neutral

const RAD2DEG = 180 / Math.PI;

export interface SteerBalance {
  frontAvgDeg: number;    // avg front slip angle (degrees)
  rearAvgDeg: number;     // avg rear slip angle (degrees)
  deltaDeg: number;       // front - rear (positive = understeer)
  state: "understeer" | "oversteer" | "neutral";
  severity: number;       // 0-1, how far from neutral
}

/** Slip angle threshold (°) for under/oversteer detection at a given speed */
export const BALANCE_THRESHOLDS = [
  { maxMph: 30, deg: 8 },
  { maxMph: 60, deg: 5 },
  { maxMph: Infinity, deg: 3 },
] as const;

export function balanceThreshold(speedMph: number): number {
  for (const t of BALANCE_THRESHOLDS) {
    if (speedMph <= t.maxMph) return t.deg;
  }
  return BALANCE_THRESHOLDS[BALANCE_THRESHOLDS.length - 1].deg;
}

/** SVG chart data for the balance threshold graph */
export interface BalanceChartData {
  polylinePoints: string;
  markerX: number;
  markerY: number;
  yLabels: { deg: number; y: number }[];
  xLabels: { mph: number; x: number }[];
  degToY: (d: number) => number;
}

export function balanceChartData(speedMph: number): BalanceChartData {
  const yScale = 10;
  const degToY = (d: number) => 65 - (d / yScale) * 60;
  const mphToX = (mph: number) => 30 + (Math.min(mph, 90) / 90) * 165;

  // Build polyline from thresholds
  const points: string[] = [];
  let prevMph = 0;
  for (const t of BALANCE_THRESHOLDS) {
    const endMph = Math.min(t.maxMph, 90);
    const y = degToY(t.deg);
    if (points.length > 0) points.push(`${mphToX(prevMph)},${y}`);
    points.push(`${mphToX(endMph)},${y}`);
    prevMph = endMph;
  }

  const thr = balanceThreshold(speedMph);

  return {
    polylinePoints: points.join(" "),
    markerX: mphToX(speedMph),
    markerY: degToY(thr),
    yLabels: BALANCE_THRESHOLDS.map(t => ({ deg: t.deg, y: degToY(t.deg) })),
    xLabels: [0, 30, 60, 90].map(v => ({ mph: v, x: mphToX(v) })),
    degToY,
  };
}

// EMA state for smoothing — persists across calls
let _smoothedDelta = 0;
const EMA_ALPHA = 0.15; // lower = smoother, less flicker

export function steerBalance(pkt: TelemetryPacket): SteerBalance {
  const frontAvg = (Math.abs(pkt.TireSlipAngleFL) + Math.abs(pkt.TireSlipAngleFR)) / 2 * RAD2DEG;
  const rearAvg = (Math.abs(pkt.TireSlipAngleRL) + Math.abs(pkt.TireSlipAngleRR)) / 2 * RAD2DEG;
  const rawDelta = frontAvg - rearAvg;

  // EMA smoothing to prevent frame-by-frame flickering
  _smoothedDelta = EMA_ALPHA * rawDelta + (1 - EMA_ALPHA) * _smoothedDelta;
  const delta = _smoothedDelta;

  const speedMph = pkt.Speed * 2.23694;
  const threshold = balanceThreshold(speedMph);

  const state = delta > threshold ? "understeer" : delta < -threshold ? "oversteer" : "neutral";
  const severity = Math.min(1, Math.abs(delta) / (threshold * 1.5));

  return { frontAvgDeg: frontAvg, rearAvgDeg: rearAvg, deltaDeg: delta, state, severity };
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

  // Lockup = wheel has fully stopped while car is moving
  if (Math.abs(wheelRotSpeed) < 0.5 && groundSpeed > 3) return { state: "lockup", slipRatio: sr };

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
  if (a < 0.08) return "#34d399"; // green — grip
  if (a < 0.15) return "#fbbf24"; // yellow — sliding
  return "#ef4444";               // red — beyond limit
}

export function frictionUtilColor(util: number): string {
  if (util <= 1.0) return "#34d399"; // green — within grip
  if (util <= 1.1) return "#fbbf24"; // yellow — just over limit
  return "#ef4444";                  // red — beyond limit
}

export function balanceColor(state: "understeer" | "oversteer" | "neutral"): string {
  if (state === "neutral") return "#34d399";
  if (state === "understeer") return "#f59e0b";
  return "#ef4444"; // oversteer
}
