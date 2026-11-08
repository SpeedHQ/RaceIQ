import { z } from "zod";

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
export type DriverProfileSummaryParseResult = z.ZodSafeParseResult<DriverProfileSummary>;

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

export function parseDriverProfileSummary(raw: unknown): DriverProfileSummaryParseResult {
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
