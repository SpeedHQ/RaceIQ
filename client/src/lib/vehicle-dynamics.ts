/**
 * Presentation helpers (colors, labels) for vehicle dynamics.
 * Pure physics lives in shared/lib/vehicle-physics.ts and is re-exported
 * here so existing client imports keep working.
 */

export * from "../../../shared/lib/vehicle-physics";

import { SLIP_ANGLE_PEAK_RAD, SLIP_RATIO_PEAK } from "../../../shared/lib/vehicle-physics";

// ── Semantic Color Palette ────────────────────────────────────────
// Reads from CSS custom properties defined in index.css (--dynamics-*).
// Use COLORS for inline styles / SVG attributes, COLOR_VARS for CSS var() refs.

// CSS var() references — use in inline styles and DOM SVG attributes
export const COLOR_VARS = {
  green: "var(--dynamics-green)",
  yellow: "var(--dynamics-yellow)",
  amber: "var(--dynamics-amber)",
  orange: "var(--dynamics-orange)",
  red: "var(--dynamics-red)",
  blue: "var(--dynamics-blue)",
  gray: "var(--dynamics-gray)",
} as const;

// Raw hex values — use in canvas, WebGL, Three.js, or anywhere
// CSS var() can't be resolved. Keep in sync with index.css :root --dynamics-*.
export const COLORS_HEX = {
  green: "#34d399",
  yellow: "#fbbf24",
  amber: "#f59e0b",
  orange: "#fb923c",
  red: "#ef4444",
  blue: "#3b82f6",
  gray: "#94a3b8",
} as const;

// Default export uses CSS vars — works in React inline styles and SVG
export const COLORS = COLOR_VARS;

// Tailwind utility classes using the theme tokens
export const COLOR_CLASSES = {
  green: "text-dynamics-green",
  yellow: "text-dynamics-yellow",
  amber: "text-dynamics-amber",
  orange: "text-dynamics-orange",
  red: "text-dynamics-red",
  blue: "text-dynamics-blue",
  gray: "text-dynamics-gray",
} as const;

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

const GRIP_WARN_UTIL = 0.9; // start warning at 90% of friction budget

export interface TireState {
  label: "LOCK" | "SPIN" | "IDLE" | "SLIDE" | "SLIP" | "GRIP";
  color: string; // CSS var — use in React inline styles / SVG
  hex: string; // Raw hex — use in canvas, WebGL, Three.js
}

export function tireState(wheelStateLabel: string, slipRatio: number, slipAngleRad: number): TireState {
  if (wheelStateLabel === "lockup") return { label: "LOCK", color: COLORS.red, hex: COLORS_HEX.red };
  if (wheelStateLabel === "idle") return { label: "IDLE", color: COLORS.gray, hex: COLORS_HEX.gray };

  const rNorm = Math.abs(slipRatio) / SLIP_RATIO_PEAK;
  const aNorm = Math.abs(slipAngleRad) / SLIP_ANGLE_PEAK_RAD;
  const util = Math.min(Math.hypot(rNorm, aNorm), 2.0);

  if (util < GRIP_WARN_UTIL) return { label: "GRIP", color: COLORS.green, hex: COLORS_HEX.green };
  if (util < 1.0) return { label: "SLIP", color: COLORS.yellow, hex: COLORS_HEX.yellow };

  // Past peak — classify by which axis carries more of the saturation
  if (wheelStateLabel === "spin") return { label: "SPIN", color: COLORS.orange, hex: COLORS_HEX.orange };
  if (aNorm >= rNorm) return { label: "SLIDE", color: COLORS.red, hex: COLORS_HEX.red };
  return { label: "SPIN", color: COLORS.orange, hex: COLORS_HEX.orange };
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
export function tireHealthColor(wear: number, thresholds = { green: 0.7, yellow: 0.4 }): string {
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
  rear: { warm: number; hot: number };
};

const DEFAULT_BRAKE_THRESHOLDS: BrakeTempThresholds = {
  front: { warm: 450, hot: 700 },
  rear: { warm: 450, hot: 700 },
};

export type BrakeColor = "red" | "orange" | "blue";

export const BRAKE_COLOR_CLASSES: Record<BrakeColor, { text: string; bg: string }> = {
  red: { text: "text-red-400", bg: "bg-red-500" },
  orange: { text: "text-orange-400", bg: "bg-orange-400" },
  blue: { text: "text-blue-400", bg: "bg-blue-400" },
};

/** Returns a color key for a brake temperature reading. Use with BRAKE_COLOR_CLASSES. */
export function brakeTempColor(temp: number, isRear: boolean, thresholds?: BrakeTempThresholds): BrakeColor {
  const { warm, hot } = isRear ? (thresholds ?? DEFAULT_BRAKE_THRESHOLDS).rear : (thresholds ?? DEFAULT_BRAKE_THRESHOLDS).front;
  if (temp > hot) return "red";
  if (temp > warm) return "orange";
  return "blue";
}

export type PressureColor = "green" | "blue" | "orange" | "gray";

/** Tire pressure color key. Blue under-inflated, orange over-inflated,
 *  green in the optimal range, gray when no data or no thresholds. */
export function tirePressureColor(psi: number, optimal?: { min: number; max: number }): PressureColor {
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
