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


export const AnalystOutputSchema = z.object({
  verdict: z.string(),
  pace: z.array(MetricItem),
  handling: z.array(MetricItem),
  corners: z.array(CornerIssue),
  technique: z.array(TechniqueTip),
  setup: z.array(z.object({
    component: z.string(),
    symptom: z.string(),
    fix: z.string(),
    current: z.string(),
    target: z.string(),
    direction: z.enum(["increase", "decrease", "adjust"]),
  })).optional(),
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
 * Render analyst output shape as a JSON skeleton for adapter prompts.
 */
export function renderAnalystSchemaForPrompt(): string {
  return `{
  "verdict": "2-3 sentences assessing overall lap quality, pace, and where the biggest time gains are.",
  "pace": [
    { "label": "Short Metric Name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "handling": [
    { "label": "Short Metric Name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "corners": [
    { "name": "corner/zone name", "issue": "what's wrong", "fix": "specific actionable fix", "severity": "minor|moderate|major" }
  ],
  "technique": [
    { "tip": "short imperative title", "detail": "explanation referencing specific data" }
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

// ─── Auto-tune pipeline ─────────────────────────────────────────────────────
//
// telemetryToSymptoms (deterministic) → buildTunePrompt → requestTuneIntents
// (LLM, grammar-constrained) → applyIntents (deterministic rules) →
// writeSetupFile. The LLM only picks *intents* (which knob, which way, how
// much) — never raw numbers — so the concrete setup math stays testable.

/** Which way to move a setup value. Fresh 2-value enum (no "adjust"). */
const TuneDirectionEnum = z.enum(["increase", "decrease"]);
const TuneMagnitudeEnum = z.enum(["small", "medium", "large"]);

/**
 * One high-level change the tuner wants. `component` must be one of the
 * keys the rules table (`server/ai/tune-rules.ts`) knows how to apply; the
 * rules layer clamps unknown/out-of-range components to a no-op.
 */
const TuneIntentSchema = z.object({
  component: z.string(),
  direction: TuneDirectionEnum,
  magnitude: TuneMagnitudeEnum,
  reason: z.string(),
});

export const TuneIntentsSchema = z.object({
  summary: z.string(),
  intents: z.array(TuneIntentSchema),
});

export type TuneDirection = z.infer<typeof TuneDirectionEnum>;
export type TuneMagnitude = z.infer<typeof TuneMagnitudeEnum>;
export type TuneIntent = z.infer<typeof TuneIntentSchema>;
export type TuneIntents = z.infer<typeof TuneIntentsSchema>;

/** JSON Schema form of `TuneIntentsSchema` for structured-output providers. */
export function getTuneIntentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TuneIntentsSchema) as Record<string, unknown>;
}

/**
 * Parse a raw model response (string or object) into the tune-intents schema.
 * Mirrors `parseAnalystOutput` — strips markdown fences / leading prose.
 */
export function parseTuneIntents(raw: unknown): ReturnType<typeof TuneIntentsSchema.safeParse> {
  if (typeof raw !== "string") return TuneIntentsSchema.safeParse(raw);

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
    return TuneIntentsSchema.safeParse(JSON.parse(jsonSlice));
  } catch {
    return TuneIntentsSchema.safeParse(raw);
  }
}

// ─── Driver profile trend summary ──────────────────────────────────────────

/**
 * Summary-only output for the Driver Profiler agent.
 *
 * The trend and advice are deterministic. The model may only explain their
 * credibility in a short, general summary; it must not add a plan or claims
 * about specific telemetry.
 */
export const DriverProfileSummarySchema = z
  .object({
    headline: z.string().min(1).max(80),
    summary: z.string().min(1).max(600),
  })
  .strict();

export type DriverProfileSummary = z.infer<typeof DriverProfileSummarySchema>;

export function getDriverProfileSummaryJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(DriverProfileSummarySchema) as Record<string, unknown>;
}

/** JSON skeleton for embedding in the summary-only profiler prompt. */
export function renderDriverProfileSummarySchemaForPrompt(): string {
  return `{
  "headline": "short trend headline (1-80 characters)",
  "summary": "2-3 sentences explaining the credibility of this driver's global trend from the supplied counts and normalized pace only (1-600 characters)"
}`;
}

export function parseDriverProfileSummary(raw: unknown): ReturnType<typeof DriverProfileSummarySchema.safeParse> {
  if (typeof raw !== "string") return DriverProfileSummarySchema.safeParse(raw);

  const fenceStripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");

  const firstBrace = fenceStripped.indexOf("{");
  const lastBrace = fenceStripped.lastIndexOf("}");
  const jsonSlice =
    firstBrace >= 0 && lastBrace > firstBrace ? fenceStripped.slice(firstBrace, lastBrace + 1) : fenceStripped;

  try {
    return DriverProfileSummarySchema.safeParse(JSON.parse(jsonSlice));
  } catch {
    return DriverProfileSummarySchema.safeParse(raw);
  }
}
