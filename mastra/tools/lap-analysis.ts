import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { getAnalysis } from "../../server/db/analysis-queries";
import { AnalystOutputSchema } from "../../server/ai/schemas";
import type {
  AnalysisUsage,
  LapAnalysisResult,
} from "../../server/ai/generate-lap-analysis";

export type ParsedLapAnalysis =
  { analysis: unknown; readable: string } | { error: string; readable: string };
export function parseCachedLapAnalysis(row: {
  analysis: string;
}): ParsedLapAnalysis {
  try {
    const parsed = AnalystOutputSchema.safeParse(JSON.parse(row.analysis));
    if (!parsed.success) {
      return {
        error: "Cached analysis failed schema validation",
        readable:
          "Cached analysis has an invalid structure and cannot be used safely.",
      };
    }
    return {
      analysis: parsed.data,
      readable: JSON.stringify(parsed.data, null, 2),
    };
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
export function getLapAnalysisToolFor(
  readAnalysis: typeof getAnalysis = getAnalysis,
) {
  return createTool({
    id: "get_lap_analysis",
    description:
      "Fetch the cached structured analysis for one lap. Call this before making lap-specific diagnoses or setup recommendations. " +
      "If available is false, do not claim findings from the missing analysis.",
    inputSchema: LapAnalysisInput,
    outputSchema: LapAnalysisOutput,
    execute: async ({ lapId }) => {
      try {
        const row = await readAnalysis(lapId);
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
}

export const getLapAnalysisTool = getLapAnalysisToolFor();

const GenerateLapAnalysisInput = z.object({
  lapId: z.number().int().positive(),
  regenerate: z.boolean().optional(),
});

const AnalysisUsageOutput = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  model: z.string(),
});

const GenerateLapAnalysisOutput = z.object({
  available: z.boolean(),
  lapId: z.number(),
  analysis: z.unknown().optional(),
  readable: z.string(),
  cached: z.boolean(),
  usage: AnalysisUsageOutput.optional(),
  error: z.string().optional(),
});

async function defaultGenerateLapAnalysis(
  lapId: number,
  options?: { regenerate?: boolean },
): Promise<LapAnalysisResult> {
  // Keep service loading lazy to avoid the Mastra agent/tool import cycle.
  const { generateLapAnalysis } =
    await import("../../server/ai/generate-lap-analysis");
  return generateLapAnalysis(lapId, options);
}

type GenerateLapAnalysis = (
  lapId: number,
  options?: { regenerate?: boolean },
) => Promise<LapAnalysisResult>;

function unavailableLapAnalysis(
  lapId: number,
  cached: boolean,
  error: string,
  usage?: AnalysisUsage,
) {
  return {
    available: false,
    lapId,
    readable: `Lap analysis is unavailable for lap ${lapId}: ${error} Do not make lap-specific claims from it.`,
    cached,
    ...(usage ? { usage } : {}),
    error,
  };
}

/** Generate or retrieve structured analysis when the read-only cache lookup is unavailable. */
export function getGenerateLapAnalysisTool(
  generate: GenerateLapAnalysis = defaultGenerateLapAnalysis,
) {
  return createTool({
    id: "generate_lap_analysis",
    description:
      "Generate structured analysis for one lap when get_lap_analysis reports unavailable. " +
      "If this also reports unavailable, do not make lap-specific claims.",
    inputSchema: GenerateLapAnalysisInput,
    outputSchema: GenerateLapAnalysisOutput,
    execute: async ({ lapId, regenerate }) => {
      try {
        const result = await generate(lapId, { regenerate });
        if (!result.analysis) {
          return unavailableLapAnalysis(
            lapId,
            result.cached,
            result.error ?? "No analysis was produced.",
            result.usage,
          );
        }

        const parsed = parseCachedLapAnalysis({ analysis: result.analysis });
        if (
          "error" in parsed ||
          parsed.analysis === null ||
          parsed.analysis === undefined
        ) {
          return unavailableLapAnalysis(
            lapId,
            result.cached,
            "Generated analysis is invalid and cannot be used safely.",
            result.usage,
          );
        }

        return {
          available: true,
          lapId,
          analysis: parsed.analysis,
          readable: parsed.readable,
          cached: result.cached,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      } catch (error) {
        return unavailableLapAnalysis(
          lapId,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
}

export const generateLapAnalysisTool = getGenerateLapAnalysisTool();
