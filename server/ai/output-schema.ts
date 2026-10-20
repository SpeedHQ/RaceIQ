import type { GameId } from "@raceiq/shared/games/ids";
import { z } from "zod";

export interface AnalystSetupProvenance {
  gameId: GameId | null;
  gameVersion: string | null;
  carModel: string | null;
  carVersion: string | null;
  trackName: string | null;
  setupVersion: string | null;
  lapId: number | null;
}

const AnalystSetupProvenanceSchema = z.object({
  gameId: z.string().nullable(),
  gameVersion: z.string().nullish(),
  carModel: z.string().nullable(),
  carVersion: z.string().nullish(),
  trackName: z.string().nullable(),
  setupVersion: z.string().nullable(),
  lapId: z.number().int().nullable(),
}).strict();

const AssessmentEnum = z.enum(["good", "warning", "critical"]);
const SeverityEnum = z.enum(["minor", "moderate", "major"]);
const MetricItem = z.object({
  label: z.string(),
  value: z.string(),
  assessment: AssessmentEnum,
  detail: z.string(),
});
const CornerIssue = z.object({
  name: z.string(),
  issue: z.string(),
  fix: z.string(),
  severity: SeverityEnum,
});
const TechniqueTip = z.object({
  tip: z.string(),
  detail: z.string(),
});
export const AnalystSetupItemSchema = z.object({
  component: z.string(),
  symptom: z.string(),
  fix: z.string(),
  current: z.string(),
  target: z.string(),
  direction: z.enum(["increase", "decrease", "adjust"]),
});

export const AnalystOutputSchema = z.object({
  verdict: z.string(),
  pace: z.array(MetricItem),
  handling: z.array(MetricItem),
  corners: z.array(CornerIssue),
  technique: z.array(TechniqueTip),
  setup: z.array(AnalystSetupItemSchema),
  setupProvenance: AnalystSetupProvenanceSchema.optional(),
});

/** Model output excludes provenance, which is attached only by the server. */
export const AnalystModelOutputSchema = AnalystOutputSchema.omit({ setupProvenance: true });
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;
