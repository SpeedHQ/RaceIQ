import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { InputsCompareSchema } from "../../server/ai/inputs-compare-prompt";
import { compareFindingGenerationCacheKey, getCompareAnalysis } from "../../server/db/analysis-queries";
import { getLapById } from "../../server/db/lap-read-queries";
import { getCurrentFindingGeneration } from "../../server/findings/store";

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

export interface CompareAnalysisToolDeps {
  getLapById?: typeof getLapById;
  getCurrentFindingGeneration?: typeof getCurrentFindingGeneration;
}

export function getCompareAnalysisToolFor(
  readAnalysis: typeof getCompareAnalysis = getCompareAnalysis,
  deps: CompareAnalysisToolDeps = {},
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
        const loadLap = deps.getLapById ?? getLapById;
        const [lapA, lapB] = await Promise.all([loadLap(lapAId), loadLap(lapBId)]);
        if (!lapA?.gameId || !lapB?.gameId || lapA.gameId !== lapB.gameId) {
          return {
            available: false,
            lapAId,
            lapBId,
            error: "Compared laps are unavailable or do not belong to the same game.",
          };
        }
        const loadGeneration = deps.getCurrentFindingGeneration ?? getCurrentFindingGeneration;
        const [findingGenerationA, findingGenerationB] = await Promise.all([
          loadGeneration({
            kind: "lap",
            gameId: lapA.gameId,
            sessionId: String(lapA.sessionId),
            lapId: String(lapA.id),
          }),
          loadGeneration({
            kind: "lap",
            gameId: lapB.gameId,
            sessionId: String(lapB.sessionId),
            lapId: String(lapB.id),
          }),
        ]);
        if (!findingGenerationA || !findingGenerationB) {
          return {
            available: false,
            lapAId,
            lapBId,
            error: "Current stored finding generations are unavailable for one or both compared laps.",
          };
        }
        const findingGenerationKey = compareFindingGenerationCacheKey([
          { lapId: lapA.id, receipt: findingGenerationA.receipt },
          { lapId: lapB.id, receipt: findingGenerationB.receipt },
        ]);
        const row = await readAnalysis(lapAId, lapBId, findingGenerationKey, "inputs");
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
