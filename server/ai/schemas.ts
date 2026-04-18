/**
 * Shared output schema for the Lap Analyst agent.
 *
 * Single source of truth for the JSON shape the FM 2023 and F1 2025 adapter
 * prompts pin. Both the adapter system prompts
 * (`server/games/{fm-2023,f1-2025}/index.ts`) and the eval scorers
 * (`mastra/evals/scorers/*`) import this — so the model's instructions and
 * the gate that measures them stay in lockstep.
 *
 * Compare-engineer output is intentionally free-form (see
 * `compare-engineer.ts` — "Plain text — no JSON shape."), so no schema here
 * applies to that flow.
 */
import { z } from "zod";

const AssessmentEnum = z.enum(["good", "warning", "critical"]);
const SeverityEnum = z.enum(["minor", "moderate", "major"]);
const DirectionEnum = z.enum(["increase", "decrease", "adjust"]);

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

const SetupChange = z.object({
  change: z.string(),
  symptom: z.string(),
  fix: z.string(),
});

const TuningItem = z.object({
  component: z.string(),
  current: z.string(),
  direction: DirectionEnum,
  target: z.string(),
  reason: z.string(),
});

export const AnalystOutputSchema = z.object({
  verdict: z.string(),
  pace: z.array(MetricItem),
  handling: z.array(MetricItem),
  corners: z.array(CornerIssue),
  technique: z.array(TechniqueTip),
  setup: z.array(SetupChange),
  tuning: z.array(TuningItem),
});

export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

/**
 * Render the schema as a JSON skeleton to embed in an adapter system prompt.
 *
 * `tuningExampleComponent` varies per game (e.g. "Front Springs" for FM,
 * "Front Wing" for F1) — pass the game-appropriate example.
 */
export function renderAnalystSchemaForPrompt(
  opts: { tuningExampleComponent: string } = { tuningExampleComponent: "Front Springs" },
): string {
  return `{
  "verdict": "2-3 sentences assessing overall lap quality, pace, and where the biggest time gains are.",
  "pace": [
    { "label": "short metric name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "handling": [
    { "label": "short metric name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "corners": [
    { "name": "corner/zone name", "issue": "what's wrong in 1 sentence", "fix": "specific actionable fix in 1-2 sentences", "severity": "minor|moderate|major" }
  ],
  "technique": [
    { "tip": "short imperative title", "detail": "1-2 sentence explanation referencing specific data" }
  ],
  "setup": [
    { "change": "short imperative title", "symptom": "what the data shows", "fix": "specific tuning change with values" }
  ],
  "tuning": [
    { "component": "e.g. ${opts.tuningExampleComponent}", "current": "what the data suggests (e.g. Too stiff — 0.00m travel)", "direction": "increase|decrease|adjust", "target": "specific value or range to aim for", "reason": "1 sentence why" }
  ]
}`;
}

/**
 * Parse a raw model response (string or object) into the analyst schema.
 * Strips common model wrappers (markdown fences, leading prose) before parsing.
 */
export function parseAnalystOutput(raw: unknown): z.SafeParseReturnType<unknown, AnalystOutput> {
  if (typeof raw !== "string") return AnalystOutputSchema.safeParse(raw);

  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");

  const firstBrace = fenceStripped.indexOf("{");
  const lastBrace = fenceStripped.lastIndexOf("}");
  const jsonSlice =
    firstBrace >= 0 && lastBrace > firstBrace
      ? fenceStripped.slice(firstBrace, lastBrace + 1)
      : fenceStripped;

  try {
    return AnalystOutputSchema.safeParse(JSON.parse(jsonSlice));
  } catch (e) {
    return AnalystOutputSchema.safeParse(raw);
  }
}
