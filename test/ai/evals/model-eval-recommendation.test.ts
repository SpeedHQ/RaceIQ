import { describe, expect, test } from "bun:test";
import { renderModelRecommendationMarkdown } from "../../../mastra/evals/model-eval-recommendation";
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

  test("renders token and throughput metrics in ranked table", () => {
    const summary: ModelRecommendationSummary = {
      modelId: "model", eligible: true, failedGates: [], overallScore: 0.9,
      analystScore: 0.9, compareScore: 0.9, correctnessScore: 1, passRate: 1, validOutputRate: 1,
      meanLatencyMs: 1200, meanInputTokens: 100, meanOutputTokens: 40, meanReasoningTokens: 20,
      meanTotalTokens: 160, meanTokensPerSecond: 50, scorerStats: [],
    };
    const report = {
      schemaVersion: 2, experimentSetId: "set", createdAt: new Date().toISOString(), sourceVersion: "sha",
      datasets: [], experiments: [], summaries: [summary], ranking: ["model"], recommendationIds: ["model"],
      evidence: [], failures: [], comparisons: [],
    } satisfies ModelRecommendationReport;
    const markdown = renderModelRecommendationMarkdown(report);
    expect(markdown).toContain("Input tok | Output tok | Reasoning tok | Total tok | tok/s");
    expect(markdown).toContain("| 1 | model | yes | 0.900 | 0.900 | 0.900 | 1.000 | 100.0% | 1200 ms | 100.0 | 40.0 | 20.0 | 160.0 | 50.0 |");
  });
});
