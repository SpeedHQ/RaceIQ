import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getOrComputeLapInsights } from "@raceiq/backend-core/lap-analysis/metrics-store";

const LapInsightsInput = z.object({ lapId: z.number().int().positive() });
const insightSchema = z.object({
  id: z.string(),
  category: z.enum(["suspension", "tires", "driving", "mechanical"]),
  severity: z.enum(["info", "warning", "critical"]),
  label: z.string(),
  detail: z.string(),
  frameIndices: z.array(z.number().int()),
  evidenceSource: z.enum(["native", "inferred"]).optional(),
  timeLossS: z.number().optional(),
});
const outputSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  lapId: z.number().int().positive(),
  warning: z.string(),
  findings: z.array(insightSchema),
});

type Loader = typeof getOrComputeLapInsights;

export function getLapInsightsToolFor(loadInsights: Loader = getOrComputeLapInsights) {
  return createTool({
    id: "get_lap_insights",
    description: "Retrieve deterministic automated lap findings for this lap. These are unverified hints, not confirmed faults; use as evidence, not as diagnosis certainty. Always retrieve for current-turn diagnosis, improvement, technique, or setup recommendations. An empty available result means no findings were detected; unavailable means analysis could not be produced.",
    inputSchema: LapInsightsInput,
    outputSchema,
    execute: async ({ lapId }) => {
      const warning = "Automated detections are unverified hints, not confirmed faults.";
      try {
        const findings = await loadInsights(lapId);
        if (findings == null) {
          return { available: false, reason: "lap not found or telemetry unavailable", lapId, warning, findings: [] };
        }
        return { available: true, lapId, warning, findings };
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : "insight analysis failed",
          lapId,
          warning,
          findings: [],
        };
      }
    },
  });
}

export const getLapInsightsTool = getLapInsightsToolFor();
