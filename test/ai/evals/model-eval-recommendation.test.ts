import { describe, expect, test } from "bun:test";
import type { ModelRecommendationReport, ModelRecommendationSummary } from "../../../mastra/evals/model-eval-recommendation";

describe("native model-eval recommendation contract", () => {
  test("requires persisted report schema and complete summary fields", () => {
    const summary: ModelRecommendationSummary = {
      modelId: "model", eligible: false, failedGates: ["correctness judge disabled"], overallScore: null,
      analystScore: null, compareScore: null, correctnessScore: null, passRate: null, validOutputRate: 0,
      meanLatencyMs: null, meanInputTokens: null, meanOutputTokens: null, meanReasoningTokens: null,
      meanTotalTokens: null, meanTokensPerSecond: null, scorerStats: [],
    };
    const report = { schemaVersion: 2, experimentSetId: "set", createdAt: new Date().toISOString(), sourceVersion: "sha", datasets: [], experiments: [], summaries: [summary], ranking: [], recommendationIds: [], evidence: [], failures: [], comparisons: [] } satisfies ModelRecommendationReport;
    expect(report.schemaVersion).toBe(2);
    expect(report.summaries[0].failedGates).toContain("correctness judge disabled");
  });
});
