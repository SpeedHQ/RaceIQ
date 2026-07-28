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

// ─── Driver profile / improvement plan ──────────────────────────────────────

/**
 * Output shape for the Driving Coach agent (POST /api/drivers/profile).
 *
 * Deliberately narrower than the analyst schema. The coach is not re-analysing
 * telemetry — the deterministic aggregator has already done that and handed it
 * a ranked list. Its job is to explain *why* the top faults happen and what to
 * practise, so every field here is prose keyed to a detector the aggregator
 * actually reported.
 */
const FocusArea = z.object({
  /** Detector id from the fingerprint. Pins the prose to a measured fault. */
  detectorId: z.string(),
  title: z.string(),
  /** What the driver is doing, in their terms. */
  whatHappens: z.string(),
  /** Why it costs time — the mechanism, not a restatement of the number. */
  whyItCosts: z.string(),
  /** A concrete practice drill with a way to tell it worked. */
  drill: z.string(),
  /**
   * Verbatim from the fingerprint when the aggregator quantified a cost, and
   * omitted when it did not. The model must not invent one: an unquantified
   * fault is "cost not measured", never "costs nothing".
   */
  estimatedGainS: z.number().optional(),
});

const ProfileStrength = z.object({
  title: z.string(),
  detail: z.string(),
});

export const DriverProfileOutputSchema = z.object({
  /** 2–3 sentences: the driver's style in plain language, then the headline. */
  summary: z.string(),
  /** One short phrase naming the style, e.g. "committed but inconsistent on entry". */
  styleLabel: z.string(),
  strengths: z.array(ProfileStrength),
  /** Ranked, most valuable first. Mirrors the aggregator's ordering. */
  focusAreas: z.array(FocusArea),
  /** What to actually do in the next session, in order. */
  sessionPlan: z.array(z.string()),
});

export type DriverProfileOutput = z.infer<typeof DriverProfileOutputSchema>;

export function getDriverProfileJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(DriverProfileOutputSchema) as Record<string, unknown>;
}

/** JSON skeleton for embedding in the coach system prompt. */
export function renderDriverProfileSchemaForPrompt(): string {
  return `{
  "summary": "2-3 sentences: how this driver drives, then the single biggest opportunity.",
  "styleLabel": "short phrase naming the style, e.g. 'committed but loose on entry'",
  "strengths": [
    { "title": "short phrase", "detail": "1 sentence, referencing the measured evidence" }
  ],
  "focusAreas": [
    {
      "detectorId": "exact id from the FOCUS AREAS table — never invented",
      "title": "short imperative phrase",
      "whatHappens": "1-2 sentences describing the driver's actual input pattern",
      "whyItCosts": "1-2 sentences on the mechanism — why this loses time",
      "drill": "a concrete practice exercise plus how to tell it worked",
      "estimatedGainS": 0.25
    }
  ],
  "sessionPlan": [
    "one instruction for the next session, in the order to do them"
  ]
}
Omit "estimatedGainS" entirely for any focus area whose table row says the cost was not measured. Do not write 0.`;
}

export function parseDriverProfileOutput(raw: unknown): ReturnType<typeof DriverProfileOutputSchema.safeParse> {
  if (typeof raw !== "string") return DriverProfileOutputSchema.safeParse(raw);

  const fenceStripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");

  const firstBrace = fenceStripped.indexOf("{");
  const lastBrace = fenceStripped.lastIndexOf("}");
  const jsonSlice =
    firstBrace >= 0 && lastBrace > firstBrace ? fenceStripped.slice(firstBrace, lastBrace + 1) : fenceStripped;

  try {
    return DriverProfileOutputSchema.safeParse(JSON.parse(jsonSlice));
  } catch {
    return DriverProfileOutputSchema.safeParse(raw);
  }
}
