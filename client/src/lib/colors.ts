const SUSP_COLORS_BG = ["bg-blue-500", "bg-emerald-400", "bg-yellow-400", "bg-red-500"];

export function suspColor(norm: number, thresholds: number[]): string {
  const pct = norm * 100;
  for (let i = 0; i < thresholds.length; i++) {
    if (pct < thresholds[i]) return SUSP_COLORS_BG[i] ?? SUSP_COLORS_BG[0];
  }
  return SUSP_COLORS_BG[thresholds.length] ?? SUSP_COLORS_BG[SUSP_COLORS_BG.length - 1];
}
