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
import type { GameId } from "@raceiq/shared/games/ids";
import { getAcEvoCarRanges, getRuleTable, getSetupCapabilities } from "../setups/rules/catalog";

export interface SetupValidationContext {
  gameId?: GameId;
  gameVersion?: string | null;
  carModel?: string;
  carVersion?: string | null;
  trackName?: string;
  setupSnapshot?: unknown;
  setupVersion?: string | number;
  lapId?: number;
}

const TARGET_VALUE = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*([^\d\s].*)?\s*$/;

function setupValue(snapshot: unknown, path: string): number | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  let value: unknown = snapshot;
  for (const part of path.split(".")) {
    if (Array.isArray(value)) value = value[Number(part)];
    else if (value && typeof value === "object") value = (value as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


export type AnalystOutputParseResult = z.ZodSafeParseResult<AnalystOutput>;

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
/** Keep only exact numeric recommendations supported by this car's rules and parsed setup. */
export function validateSetupRecommendations(recs: unknown, context: SetupValidationContext): AnalystOutput["setup"] {
  if (!Array.isArray(recs) || !context.gameId || !context.setupSnapshot) return [];
  if (context.gameId === "ac-evo" && !getAcEvoCarRanges(context.carModel)) return [];
  const table = getRuleTable(context.gameId, context.carModel);
  if (!table) return [];
  const capabilities = getSetupCapabilities(context.gameId, context.carModel);
  const accepted: AnalystOutput["setup"] = [];
  for (const raw of recs) {
    const parsed = SetupItem.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    const rule = table[item.component];
    if (!rule) continue;
    const control = rule.rangeKey ?? rule.paths[0]!;
    const capability = capabilities.find((candidate) => candidate.control === control);
    if (capability?.status !== "adjustable") continue;
    const match = TARGET_VALUE.exec(item.target);
    if (!match) continue;
    const target = Number(match[1]);
    const targetUnit = match[2]?.trim() ?? "";
    const unit = rule.unit;
    if (!targetUnit || !unit || targetUnit.toLowerCase() !== unit.toLowerCase()) continue;
    if (!Number.isFinite(target) || target < rule.min || target > rule.max) continue;
    if (rule.integer && !Number.isInteger(target)) continue;
    const step = rule.step.small;
    if (!(step > 0) || Math.abs((target - rule.min) / step - Math.round((target - rule.min) / step)) > 1e-7) continue;
    const current = rule.paths.map((path) => setupValue(context.setupSnapshot, path));
    if (current.some((value) => value === undefined)) continue;
    const numericCurrent = current as number[];
    if (numericCurrent.every((value) => target === value)) continue;
    if (item.direction === "increase" && numericCurrent.some((value) => target <= value)) continue;
    if (item.direction === "decrease" && numericCurrent.some((value) => target >= value)) continue;
    if (/\bfast[- ]?(?:bump|rebound)\b/i.test(`${item.component} ${item.symptom} ${item.fix}`)) continue;
    const currentText = current.length === 1 ? `${current[0]} ${unit}` : current.map((v) => `${v} ${unit}`).join(" / ");
    accepted.push({
      ...item,
      current: currentText,
      target: `${target} ${unit}`,
      fix: `${item.component}: ${currentText} → ${target} ${unit}`,
    });
  }
  return accepted;
}

/** Parse analyst output, replacing model-authored current values with snapshot values. */
export function sanitizeAnalystOutput(
  raw: unknown,
  context: SetupValidationContext,
  options: { requireMatchingProvenance?: boolean } = {},
): AnalystOutputParseResult {
  const parsed = parseAnalystOutput(raw);
  if (!parsed.success) return parsed;
  const provenance: AnalystSetupProvenance = {
    gameId: context.gameId ?? null,
    gameVersion: context.gameVersion ?? null,
    carModel: context.carModel ?? null,
    carVersion: context.carVersion ?? null,
    trackName: context.trackName ?? null,
    setupVersion: context.setupVersion == null ? null : String(context.setupVersion),
    lapId: context.lapId ?? null,
  };
  const cachedProvenance = parsed.data.setupProvenance;
  const provenanceMatches = !!cachedProvenance &&
    cachedProvenance.gameId === provenance.gameId &&
    cachedProvenance.gameVersion === provenance.gameVersion &&
    cachedProvenance.carModel === provenance.carModel &&
    cachedProvenance.carVersion === provenance.carVersion &&
    cachedProvenance.trackName === provenance.trackName &&
    cachedProvenance.setupVersion === provenance.setupVersion &&
    cachedProvenance.lapId === provenance.lapId;
  return AnalystOutputSchema.safeParse({
    ...parsed.data,
    setup: options.requireMatchingProvenance && !provenanceMatches
      ? []
      : validateSetupRecommendations(parsed.data.setup, context),
    setupProvenance: provenance,
  });
}

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

const SetupItem = z.object({
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
  setup: z.array(SetupItem),
  setupProvenance: AnalystSetupProvenanceSchema.optional(),
});

/** Model output excludes provenance, which is attached only by the server. */
export const AnalystModelOutputSchema = AnalystOutputSchema.omit({ setupProvenance: true });

export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

/**
 * JSON Schema for model-authored analysis, excluding server-owned provenance.
 */
export function getAnalystJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AnalystModelOutputSchema) as Record<string, unknown>;
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
  ],
  "setup": [
    { "component": "setup component", "symptom": "measured symptom", "fix": "specific actionable fix", "current": "current value", "target": "target value", "direction": "increase|decrease|adjust" }
  ]
}`;
}

function normalizeAnalystInput(raw: unknown): unknown {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !Object.prototype.hasOwnProperty.call(raw, "setup")
  ) {
    return { ...raw, setup: [] };
  }
  return raw;
}

/**
 * Parse a raw model response (string or object) into the analyst schema.
 * Strips common model wrappers (markdown fences, leading prose) before parsing.
 * Legacy cached objects omitting setup are normalized to setup: [].
 */
export function parseAnalystOutput(raw: unknown): AnalystOutputParseResult {
  if (typeof raw !== "string") return AnalystOutputSchema.safeParse(normalizeAnalystInput(raw));

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
    return AnalystOutputSchema.safeParse(normalizeAnalystInput(JSON.parse(jsonSlice)));
  } catch (_e) {
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
 * keys the setup rule catalog knows how to apply; the
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
