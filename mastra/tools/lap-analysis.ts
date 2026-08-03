import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { getAnalysis } from "../../server/db/queries";

export type ParsedLapAnalysis =
  | { analysis: unknown; readable: string }
  | { error: string; readable: string };

export function parseCachedLapAnalysis(row: { analysis: string }): ParsedLapAnalysis {
  try {
    const analysis = JSON.parse(row.analysis);
    return { analysis, readable: JSON.stringify(analysis, null, 2) };
  } catch {
    return {
      error: "Cached analysis is invalid JSON",
      readable: "Cached analysis is invalid and cannot be used safely.",
    };
  }
}

const LapAnalysisInput = z.object({
  lapId: z.number().int().positive(),
});

const LapAnalysisOutput = z.object({
  available: z.boolean(),
  lapId: z.number(),
  analysis: z.unknown().optional(),
  readable: z.string(),
  model: z.string().optional(),
  error: z.string().optional(),
});

/** Read-only access to cached analysis. Never invents or regenerates results. */
export const getLapAnalysisTool = createTool({
  id: "get_lap_analysis",
  description:
    "Fetch the cached structured analysis for one lap. Call this before making lap-specific diagnoses or setup recommendations. " +
    "If available is false, do not claim findings from the missing analysis.",
  inputSchema: LapAnalysisInput,
  outputSchema: LapAnalysisOutput,
  execute: async ({ lapId }) => {
    try {
      const row = await getAnalysis(lapId);
      if (!row) {
        return {
          available: false,
          lapId,
          readable: `No cached analysis is available for lap ${lapId}. Do not make lap-specific claims from analysis.`,
          error: "Analysis not found",
        };
      }

      const parsed = parseCachedLapAnalysis(row);
      if ("error" in parsed) {
        return {
          available: false,
          lapId,
          readable: `Cached analysis for lap ${lapId} is invalid and cannot be used safely.`,
          model: row.model,
          error: parsed.error,
        };
      }

      return {
        available: true,
        lapId,
        analysis: parsed.analysis,
        readable: parsed.readable,
        model: row.model,
      };

    } catch (error) {
      return {
        available: false,
        lapId,
        readable: `Analysis lookup failed for lap ${lapId}; do not make lap-specific claims from it.`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
