import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { getAnalysis } from "@raceiq/backend-core/db/analysis-queries";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { getTuneById } from "@raceiq/backend-core/db/tune-queries";
import { getGame } from "@raceiq/shared/games/registry";
import { sanitizeAnalystOutput, parseAnalystOutput, type SetupValidationContext } from "@raceiq/backend-core/ai/schemas";
import { linkedTuneSetupForLap, setupContextForLap } from "../../ai/lap-setup-context";
import type {
  AnalysisUsage,
  LapAnalysisResult,
} from "../../ai/generate-lap-analysis";

export type ParsedLapAnalysis =
  { analysis: unknown; readable: string } | { error: string; readable: string };
export function parseCachedLapAnalysis(
  row: { analysis: string },
  context?: SetupValidationContext,
): ParsedLapAnalysis {
  try {
    const parsed = context
      ? sanitizeAnalystOutput(row.analysis, context, { requireMatchingProvenance: true })
      : parseAnalystOutput(row.analysis);
    if (!parsed.success) {
      let invalidJson = false;
      try {
        JSON.parse(row.analysis);
      } catch {
        invalidJson = true;
      }
      return {
        error: invalidJson
          ? "Cached analysis is invalid JSON"
          : "Cached analysis failed schema validation",
        readable: invalidJson
          ? "Cached analysis is invalid and cannot be used safely."
          : "Cached analysis has an invalid structure and cannot be used safely.",
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
  readLap: typeof getLapById = getLapById,
  readTune: typeof getTuneById = getTuneById,
  resolveGame: typeof getGame = getGame,
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

        const lap = await readLap(lapId);
        if (!lap) {
          return {
            available: false,
            lapId,
            readable: `Lap ${lapId} is unavailable; cached analysis cannot be validated safely.`,
            model: row.model,
            error: "Lap not found",
          };
        }
        const linkedTune = await linkedTuneSetupForLap(lap, readTune);
        const context = setupContextForLap(lap, resolveGame, linkedTune);
        const parsed = parseCachedLapAnalysis(row, context);
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
    await import("../../ai/generate-lap-analysis");
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
