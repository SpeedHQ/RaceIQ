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

/**
 * Unified setup/tuning item. One card in the UI renders `component`,
 * `current → target` (with a `TuneBar`), direction chip, and `symptom`/`fix`
 * captions. Keeping this as one array (rather than a split setup/tuning pair)
 * matches the client layout — see `client/src/components/ai/analysis-display.tsx`.
 */
const SetupItem = z.object({
  component: z.string(),
  symptom: z.string(),
  fix: z.string(),
  current: z.string(),
  target: z.string(),
  direction: DirectionEnum,
});

export const AnalystOutputSchema = z.object({
  verdict: z.string(),
  pace: z.array(MetricItem),
  handling: z.array(MetricItem),
  corners: z.array(CornerIssue),
  technique: z.array(TechniqueTip),
  setup: z.array(SetupItem),
});

export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

/**
 * JSON Schema form of `AnalystOutputSchema`, for OpenAI-spec Structured
 * Outputs (`response_format: { type: "json_schema", ... }`). Grammar-
 * constrained decoding guarantees valid, complete JSON — critical for
 * local models (LM Studio) that otherwise truncate or emit bad chars.
 */
export function getAnalystJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AnalystOutputSchema) as Record<string, unknown>;
}

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
    { "label": "Short Metric Name (plain English, Title Case, words separated by spaces — never snake_case or camelCase)", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "handling": [
    { "label": "Short Metric Name (plain English, Title Case, words separated by spaces — never snake_case or camelCase)", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "corners": [
    { "name": "corner/zone name", "issue": "what's wrong in 1 sentence", "fix": "specific actionable fix in 1-2 sentences", "severity": "minor|moderate|major" }
  ],
  "technique": [
    { "tip": "short imperative title", "detail": "1-2 sentence explanation referencing specific data" }
  ],
  "setup": [
    { "component": "e.g. ${opts.tuningExampleComponent}", "symptom": "what the telemetry shows", "fix": "what to change and why in 1 sentence", "current": "numeric value with unit (e.g. 750 lb/in, 25, 22.5 psi)", "target": "numeric target with unit (e.g. 680 lb/in, 27, 23.0 psi)", "direction": "increase|decrease|adjust" }
  ]
}`;
}

/**
 * Parse a raw model response (string or object) into the analyst schema.
 * Strips common model wrappers (markdown fences, leading prose) before parsing.
 */
export function parseAnalystOutput(raw: unknown): ReturnType<typeof AnalystOutputSchema.safeParse> {
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
