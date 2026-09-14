// Tune form unit conversions.

const IMPERIAL = {
  tires: { factor: 14.50377, metric: "bar", imperial: "psi" },
  springs: { factor: 56.0, metric: "kgf/mm", imperial: "lb/in" },
  height: { factor: 0.393701, metric: "cm", imperial: "in" },
  aero: { factor: 2.20462, metric: "kgf", imperial: "lb" },
  speed: { factor: 0.621371, metric: "km/h", imperial: "mph" },
} as const;

export type ConvCategory = keyof typeof IMPERIAL;

export function toDisplay(value: number, cat: ConvCategory, isMetric: boolean): number {
  if (isMetric) return value;
  return Math.round(value * IMPERIAL[cat].factor * 1000) / 1000;
}

export function fromDisplay(value: number, cat: ConvCategory, isMetric: boolean): number {
  if (isMetric) return value;
  return Math.round((value / IMPERIAL[cat].factor) * 1000) / 1000;
}

export function unitLabel(cat: ConvCategory, isMetric: boolean): string {
  return isMetric ? IMPERIAL[cat].metric : IMPERIAL[cat].imperial;
}
