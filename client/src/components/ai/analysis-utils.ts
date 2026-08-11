import type { Segment } from "./analysis-types";

export const ASSESSMENT_COLORS = { good: "text-(--severity-nominal)", warning: "text-(--severity-caution)", critical: "text-(--severity-critical)" } as const;
export const ASSESSMENT_BG = {
  good: "bg-(--severity-nominal)/10 border-(--severity-nominal)/20",
  warning: "bg-(--severity-caution)/10 border-(--severity-caution)/20",
  critical: "bg-(--severity-critical)/10 border-(--severity-critical)/20",
} as const;
export const SEVERITY_COLORS = { minor: "bg-app-text-dim", moderate: "bg-(--severity-caution)", major: "bg-(--severity-critical)" } as const;

/** Find a segment whose name matches any of the search strings. */
export function findSegment(segments: Segment[] | null | undefined, ...texts: string[]): Segment | null {
  if (!segments || segments.length === 0) return null;
  const combined = texts.join(" ").toLowerCase();
  for (const s of segments) {
    const sn = s.name.toLowerCase();
    if (combined.includes(sn) || sn.includes(combined)) return s;
  }
  const words = combined.split(/\s+/).filter((w) => w.length > 2);
  for (const s of segments) {
    const sn = s.name.toLowerCase();
    if (words.some((w) => sn.includes(w))) return s;
  }
  return null;
}

const FIELD_RANGES: Record<string, { min: number; max: number }> = {
  frontwing: { min: 0, max: 50 },
  rearwing: { min: 0, max: 50 },
  fuelload: { min: 5, max: 100 },
  onthrottle: { min: 10, max: 100 },
  differentialonthrottle: { min: 10, max: 100 },
  differentialoffthrottle: { min: 10, max: 100 },
  enginebraking: { min: 0, max: 100 },
  frontcamber: { min: -3.5, max: -2.5 },
  rearcamber: { min: -2.0, max: -1.0 },
  fronttoe: { min: 0, max: 0.1 },
  reartoe: { min: 0, max: 0.4 },
  fronttoeout: { min: 0, max: 0.1 },
  reartoein: { min: 0, max: 0.4 },
  frontsuspension: { min: 1, max: 41 },
  rearsuspension: { min: 1, max: 41 },
  frontantirollbar: { min: 1, max: 41 },
  rearantirollbar: { min: 1, max: 41 },
  frontrideheight: { min: 20, max: 50 },
  rearrideheight: { min: 20, max: 50 },
  brakepressure: { min: 80, max: 100 },
  brakebias: { min: 50, max: 70 },
  frontbrakebias: { min: 50, max: 70 },
  fronttyrepressure: { min: 22.0, max: 29.5 },
  reartyrepressure: { min: 20.0, max: 26.5 },
  frontlefttyrepressure: { min: 22.0, max: 29.5 },
  frontrighttyrepressure: { min: 22.0, max: 29.5 },
  rearlefttyrepressure: { min: 20.0, max: 26.5 },
  rearrighttyrepressure: { min: 20.0, max: 26.5 },
};

export function lookupFieldRange(component: string | undefined): { min: number; max: number } | null {
  if (!component) return null;
  const key = component.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FIELD_RANGES[key] ?? null;
}
