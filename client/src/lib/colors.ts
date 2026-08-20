/** Shared gear palette: gear-ratio sawtooth chart and track-speed trace use the same colors. */
export const GEAR_COLORS = ["#22d3ee", "#a855f7", "#fbbf24", "#34d399", "#f472b6", "#60a5fa", "#fb923c", "#a3a3a3"] as const;

/** Stable identities shared by sector visualizations. */
export const SECTOR_COLOR_VARS = ["var(--sector-1)", "var(--sector-2)", "var(--sector-3)", "var(--sector-4)", "var(--sector-5)", "var(--sector-6)"] as const;

/** Stable FL, FR, RL, RR identities shared by wheel visualizations. */
export const WHEEL_COLOR_VARS = ["var(--wheel-fl)", "var(--wheel-fr)", "var(--wheel-rl)", "var(--wheel-rr)"] as const;

/** Theme-controlled series for arbitrary multi-series visualizations. */
export const VISUALIZATION_COLOR_VARS = [
  "var(--visualization-series-1)",
  "var(--visualization-series-2)",
  "var(--visualization-series-3)",
  "var(--visualization-series-4)",
  "var(--visualization-series-5)",
  "var(--visualization-series-6)",
  "var(--visualization-series-7)",
  "var(--visualization-series-8)",
] as const;

export const DELTA_COLOR_VARS = ["var(--delta-gain)", "var(--delta-loss)"] as const;

export const TRACK_SPEED_COLOR_VARS = ["var(--track-speed-low)", "var(--track-speed-mid)", "var(--track-speed-high)"] as const;

export const TRACK_CORNER_COLOR_VARS = ["var(--track-corner-series-1)", "var(--track-corner-series-2)", "var(--track-corner-series-3)", "var(--track-corner-series-4)"] as const;

export const TRACK_STRAIGHT_COLOR_VARS = ["var(--track-straight-series-1)", "var(--track-straight-series-2)", "var(--track-straight-series-3)", "var(--track-straight-series-4)"] as const;

const SEVERITY_COLOR_VARS = ["var(--severity-nominal)", "var(--severity-caution)", "var(--severity-warning)", "var(--severity-critical)"] as const;

const OPERATING_RANGE_COLOR_VARS = ["var(--operating-cold)", "var(--severity-nominal)", "var(--severity-caution)", "var(--severity-critical)"] as const;

/** Return a theme-owned severity level without exposing palette names. */
export function severityColor(level: 0 | 1 | 2 | 3): string {
  return SEVERITY_COLOR_VARS[level];
}

/** Return a theme-owned operating-range level without exposing palette names. */
export function operatingColor(level: 0 | 1 | 2 | 3): string {
  return OPERATING_RANGE_COLOR_VARS[level];
}

/** Select from the theme-owned nominal-to-critical severity scale. */
export function severityRangeColor(value: number, thresholds: readonly number[]): string {
  const index = thresholds.findIndex((threshold) => value < threshold);
  return SEVERITY_COLOR_VARS[index < 0 ? SEVERITY_COLOR_VARS.length - 1 : index];
}

/** Select from the theme-owned cold/low-to-critical operating-range scale. */
export function operatingRangeColor(value: number, thresholds: readonly number[]): string {
  const index = thresholds.findIndex((threshold) => value < threshold);
  return OPERATING_RANGE_COLOR_VARS[index < 0 ? OPERATING_RANGE_COLOR_VARS.length - 1 : index];
}

export function deltaColor(value: number): string {
  return DELTA_COLOR_VARS[value <= 0 ? 0 : 1];
}

export function lapPaceColor(isBest: boolean, isOnTarget: boolean): string {
  if (isBest) return "var(--lap-pace-best)";
  return isOnTarget ? "var(--lap-pace-on-target)" : "var(--lap-pace-off-target)";
}

export function signedBalanceColor(value: number, deadzone: number): string {
  if (value > deadzone) return "var(--balance-positive)";
  if (value < -deadzone) return "var(--balance-negative)";
  return "var(--balance-neutral)";
}

export function suspColor(norm: number, thresholds: number[]): string {
  return operatingRangeColor(norm * 100, thresholds);
}
