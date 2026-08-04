import { VISUALIZATION_COLOR_VARS } from "@/lib/colors";

const CAR_CLASS_ORDER = ["X", "P", "R", "S", "A", "B", "C", "D", "E"] as const;

export function carClassColor(carClass: string): string {
  const index = CAR_CLASS_ORDER.indexOf(carClass as (typeof CAR_CLASS_ORDER)[number]);
  return index < 0 ? "var(--app-text-secondary)" : VISUALIZATION_COLOR_VARS[index % VISUALIZATION_COLOR_VARS.length];
}

export function rangeBandGradient(p25Pct: number, p75Pct: number, baseOpacity: number, edgeOpacity: number, centerOpacity: number): string {
  const midpoint = (p25Pct + p75Pct) / 2;
  const fadedText = `color-mix(in srgb, var(--app-text) ${baseOpacity}%, transparent)`;
  const bandEdge = `color-mix(in srgb, var(--lap-pace-on-target) ${edgeOpacity}%, transparent)`;
  const bandCenter = `color-mix(in srgb, var(--lap-pace-on-target) ${centerOpacity}%, transparent)`;
  return `linear-gradient(to right, ${fadedText} 0%, ${fadedText} ${p25Pct}%, ${bandEdge} ${p25Pct}%, ${bandCenter} ${midpoint}%, ${bandEdge} ${p75Pct}%, ${fadedText} ${p75Pct}%, ${fadedText} 100%)`;
}
