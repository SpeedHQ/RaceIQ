import { z } from "zod";
import type { AnalysisData } from "./analysis-types";

const Assessment = z.enum(["good", "warning", "critical"]);
const MetricItem = z.object({
  label: z.string(),
  value: z.string(),
  assessment: Assessment,
  detail: z.string(),
});
const CornerItem = z.object({
  name: z.string(),
  issue: z.string(),
  fix: z.string(),
  severity: z.enum(["minor", "moderate", "major"]),
});
const TechniqueItem = z.object({ tip: z.string(), detail: z.string() });
const SetupItem = z.object({
  component: z.string(),
  symptom: z.string(),
  fix: z.string(),
  current: z.string(),
  target: z.string(),
  direction: z.enum(["increase", "decrease", "adjust"]),
});

const LapAnalysisForDisplay = z.object({
  verdict: z.string(),
  pace: z.array(MetricItem),
  handling: z.array(MetricItem),
  corners: z.array(CornerItem),
  technique: z.array(TechniqueItem),
  setup: z.array(SetupItem).optional(),
});

export function parseLapAnalysisForDisplay(text: string): AnalysisData | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("```") || trimmed.endsWith("```")) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const parsed = LapAnalysisForDisplay.safeParse(value);
  if (!parsed.success) return null;

  return {
    verdict: parsed.data.verdict,
    pace: parsed.data.pace,
    handling: parsed.data.handling,
    corners: parsed.data.corners,
    braking: [],
    throttle: [],
    coaching: parsed.data.technique,
    setup: parsed.data.setup ?? [],
  };
}
