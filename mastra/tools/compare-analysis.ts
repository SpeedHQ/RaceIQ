import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { InputsCompareSchema } from "../../server/ai/inputs-compare-prompt";
import { getCompareAnalysis } from "../../server/db/queries";

const CompareAnalysisInput = z.object({
  lapAId: z.number().int().positive(),
  lapBId: z.number().int().positive(),
});

const CompareAnalysisOutput = z.object({
  available: z.boolean(),
  lapAId: z.number(),
  lapBId: z.number(),
  analysis: z.unknown().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
});

export function getCompareAnalysisToolFor(
  readAnalysis: typeof getCompareAnalysis = getCompareAnalysis,
) {
  return createTool({
    id: "get_compare_analysis",
    description:
      "Fetch the cached Inputs comparison for two laps. Call this at the beginning of every comparison conversation. " +
      "If available is false, do not claim findings from the missing comparison.",
    inputSchema: CompareAnalysisInput,
    outputSchema: CompareAnalysisOutput,
    execute: async ({ lapAId, lapBId }) => {
      try {
        const row = await readAnalysis(lapAId, lapBId, "inputs");
        if (!row) {
          return {
            available: false,
            lapAId,
            lapBId,
            error: `No cached Inputs comparison is available for laps ${lapAId} and ${lapBId}.`,
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(row.analysis);
        } catch {
          return {
            available: false,
            lapAId,
            lapBId,
            model: row.model,
            error: "Cached Inputs comparison is invalid JSON.",
          };
        }
        const checked = InputsCompareSchema.safeParse(parsed);
        if (!checked.success) {
          return {
            available: false,
            lapAId,
            lapBId,
            model: row.model,
            error: "Cached Inputs comparison failed schema validation.",
          };
        }

        return {
          available: true,
          lapAId,
          lapBId,
          analysis: checked.data,
          model: row.model,
        };
      } catch (error) {
        return {
          available: false,
          lapAId,
          lapBId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export const getCompareAnalysisTool = getCompareAnalysisToolFor();
