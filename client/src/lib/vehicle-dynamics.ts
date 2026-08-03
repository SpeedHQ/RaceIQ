/**
 * Presentation helpers (colors, labels) for shared vehicle dynamics.
 */

import { SLIP_ANGLE_PEAK_RAD, SLIP_RATIO_PEAK } from "../../../shared/lap-analysis/physics/vehicle";
import { operatingColor, severityColor, severityRangeColor } from "./colors";

// ── Semantic Color Palette ────────────────────────────────────────
// Reads semantic custom properties from styles/theme.css.
// Canvas/WebGL callers resolve them only at the renderer boundary.

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
// All other color derivations must delegate to this.

const GRIP_WARN_UTIL = 0.9; // start warning at 90% of friction budget

export interface TireState {
  label: "LOCK" | "SPIN" | "IDLE" | "SLIDE" | "SLIP" | "GRIP";
  color: string; // CSS var — use in React inline styles / SVG
}

export function tireState(wheelStateLabel: string, slipRatio: number, slipAngleRad: number): TireState {
  if (wheelStateLabel === "lockup") return { label: "LOCK", color: severityColor(3) };
  if (wheelStateLabel === "idle") return { label: "IDLE", color: "var(--app-text-dim)" };

  const rNorm = Math.abs(slipRatio) / SLIP_RATIO_PEAK;
  const aNorm = Math.abs(slipAngleRad) / SLIP_ANGLE_PEAK_RAD;
  const util = Math.min(Math.hypot(rNorm, aNorm), 2.0);

  if (util < GRIP_WARN_UTIL) return { label: "GRIP", color: severityColor(0) };
  if (util < 1.0) return { label: "SLIP", color: severityColor(1) };

  // Past peak — classify by which axis carries more of the saturation
  if (wheelStateLabel === "spin") return { label: "SPIN", color: severityColor(2) };
  if (aNorm >= rNorm) return { label: "SLIDE", color: severityColor(3) };
  return { label: "SPIN", color: severityColor(2) };
}

// ── Color helpers ──────────────────────────────────────────────────

export function slipRatioColor(sr: number): string {
  return severityRangeColor(Math.abs(sr), [0.08, 0.15]);
}

export function frictionUtilColor(util: number): string {
  if (util <= 1.0) return severityColor(0);
  if (util <= 1.1) return severityColor(1);
  return severityColor(3);
}

export function balanceColor(state: "understeer" | "oversteer" | "neutral"): string {
  if (state === "neutral") return "var(--balance-neutral)";
  if (state === "understeer") return "var(--balance-positive)";
  return "var(--balance-negative)";
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
  if (temp < thresholds.cold) return operatingColor(0);
  if (temp < thresholds.warm) return severityColor(0);
  if (temp < thresholds.hot) return "var(--tire-temperature-hot)";
  return severityColor(3);
}

/** Human-readable temperature label and semantic color. */
export function tireTempLabel(temp: number, thresholds: TireTempThresholds): { label: string; color: string } {
  if (temp < thresholds.cold) return { label: "COLD", color: operatingColor(0) };
  if (temp < thresholds.warm) return { label: "OPT", color: severityColor(0) };
  if (temp < thresholds.hot) return { label: "HOT", color: "var(--tire-temperature-hot)" };
  return { label: "OVER", color: severityColor(3) };
}

// ── Tire Health Color ─────────────────────────────────────────────
// Health = 1 - wear (0 = dead, 1 = new). Thresholds are game-specific.

/** Color for tire health (wear is 0=new, 1=dead). Returns CSS var. */
export function tireHealthColor(wear: number, thresholds = { green: 0.7, yellow: 0.4 }): string {
  const health = 1 - wear;
  if (health >= thresholds.green) return severityColor(0);
  if (health >= thresholds.yellow) return severityColor(1);
  return severityColor(3);
}

/** Theme-owned severity color for a tire health percentage (0-100). */
export function tireHealthPctColor(healthPct: number, thresholds: number[] = [20, 40, 60, 80]): string {
  for (let i = 0; i < thresholds.length; i++) {
    if (healthPct <= thresholds[i]) {
      const level = Math.max(0, 3 - i) as 0 | 1 | 2 | 3;
      return severityColor(level);
    }
  }
  return severityColor(0);
}

// ── Wear Rate Color ──────────────────────────────────────────────

export function wearRateColor(rate: number | null): string {
  if (rate == null || rate < 0.01) return "var(--app-text-dim)";
  if (rate < 0.05) return severityColor(0);
  if (rate < 0.1) return severityColor(1);
  return severityColor(3);
}

// ── Brake Temp Color ─────────────────────────────────────────────

export type BrakeTempThresholds = {
  front: { warm: number; hot: number };
  rear: { warm: number; hot: number };
};

const DEFAULT_BRAKE_THRESHOLDS: BrakeTempThresholds = {
  front: { warm: 450, hot: 700 },
  rear: { warm: 450, hot: 700 },
};

/** Theme-owned brake temperature color for DOM, SVG, Canvas, or WebGL adapters. */
export function brakeTempColor(temp: number, isRear: boolean, thresholds?: BrakeTempThresholds): string {
  const { warm, hot } = isRear ? (thresholds ?? DEFAULT_BRAKE_THRESHOLDS).rear : (thresholds ?? DEFAULT_BRAKE_THRESHOLDS).front;
  if (temp > hot) return severityColor(3);
  if (temp > warm) return severityColor(2);
  return operatingColor(0);
}

/** Theme-owned tire pressure state color. */
export function tirePressureColor(psi: number, optimal?: { min: number; max: number }): string {
  if (psi <= 0 || !optimal) return "var(--app-text-dim)";
  if (psi < optimal.min) return operatingColor(0);
  if (psi > optimal.max) return severityColor(2);
  return severityColor(0);
}

// ── Slip Angle Color ──────────────────────────────────────────────

export function slipAngleColor(deg: number): string {
  return severityRangeColor(Math.abs(deg), [4, 8, 14]);
}
