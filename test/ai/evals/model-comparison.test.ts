import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { buildEvalCompareEngineerAgent, buildEvalLapAnalystAgent } from "../../../mastra/evals/eval-agents";
import { buildModelComparisonReport, rankModelSummaries, renderModelComparisonMarkdown, summariseModelResults, type ModelEvalObservation } from "../../../mastra/evals/model-comparison";
import { getMastraModelId } from "../../../mastra/model";

type ModelLookupAgent = { getModel(options: { requestContext: RequestContext }): Promise<unknown> };
const caseOf = (id: string, agent: "lap-analyst" | "compare-engineer") => ({ id, agent, input: "", groundTruth: { trackCorners: [], units: "metric" as const } });
const obs = (modelId: string, caseId: string, agent: "lap-analyst" | "compare-engineer", scores: number[], repeat = 1, latencyMs = 1000): ModelEvalObservation => ({ modelId, caseId, agent, repeat, latencyMs, output: `output-${modelId}-${caseId}`, scores: scores.map((score, i) => ({ id: agent === "lap-analyst" ? ["output-shape", "corner-coverage", "numeric-grounding", "unit-consistency"][i] : ["compare-directionality", "unit-consistency"][i], score, reason: "proof" })) });

describe("model comparison aggregation", () => {
  test("weights analyst and compare families equally", () => {
    const observations = [obs("m", "a", "lap-analyst", [1, 1, 0, 0]), obs("m", "c", "compare-engineer", [1, 1])];
    const summary = summariseModelResults("m", observations, [], ["a", "c"], 1);
    expect(summary.analystScore).toBe(0.5); expect(summary.compareScore).toBe(1); expect(summary.overallScore).toBe(0.75);
  });
  test("uses population standard deviation and scorer thresholds", () => {
    const summary = summariseModelResults("m", [obs("m", "a", "lap-analyst", [0, 1, 1, 1], 1), obs("m", "a", "lap-analyst", [1, 1, 1, 1], 2)], [], ["a"], 2);
    expect(summary.scorers.find((s) => s.id === "output-shape")).toMatchObject({ mean: 0.5, standardDeviation: 0.5, passed: 1, total: 2 });
    expect(summary.scorers.find((s) => s.id === "unit-consistency")).toMatchObject({ mean: 1, passed: 2 });
  });
  test("quality outranks latency and co-recommends close leaders", () => {
    const a = { modelId: "a", complete: true, overallScore: 0.9, analystScore: 0.9, compareScore: 0.9, passRate: 1, meanLatencyMs: 1000, scorers: [] };
    const b = { ...a, modelId: "b", overallScore: 0.89, meanLatencyMs: 10 };
    expect(rankModelSummaries([b, a]).ranking).toEqual(["a", "b"]);
    expect(rankModelSummaries([{ ...a }, { ...a, modelId: "b", overallScore: 0.891 }]).recommendationIds).toEqual(["a", "b"]);
  });
  test("incomplete duplicate, missing, or failed model cannot be recommended", () => {
    const partial = summariseModelResults("partial", [obs("partial", "a", "lap-analyst", [0.99, 0.99, 0.99, 0.99])], [{ modelId: "partial", caseId: "c", repeat: 1, stage: "generation", message: "failed" }], ["a", "c"], 1);
    const complete = { ...partial, modelId: "complete", complete: true, overallScore: 0.8 };
    expect(summariseModelResults("missing", [obs("missing", "a", "lap-analyst", [1, 1, 1, 1])], [], ["a", "c"], 1).complete).toBe(false);
    expect(summariseModelResults("dup", [obs("dup", "a", "lap-analyst", [1, 1, 1, 1]), obs("dup", "a", "lap-analyst", [1, 1, 1, 1])], [], ["a"], 1).complete).toBe(false);
    expect(rankModelSummaries([partial, complete]).recommendationIds).toEqual(["complete"]);
  });
  test("output-shape score below exact threshold fails", () => {
    const summary = summariseModelResults("m", [obs("m", "a", "lap-analyst", [0.99, 1, 1, 1])], [], ["a"], 1);
    expect(summary.scorers.find((s) => s.id === "output-shape")).toMatchObject({ passed: 0, total: 1 });
  });
  test("renders dynamic dataset, failures, and preserves report JSON contract", () => {
    const failure = { modelId: "m", caseId: "c", repeat: 1, stage: "scoring" as const, message: "scorer failed", output: "partial output" };
    const report = buildModelComparisonReport({ createdAt: "2026-01-01T00:00:00Z", endpoint: "http://comparison.test/v1", repeatCount: 1, modelIds: ["m"], dataset: { id: "iracing-x", label: "iRacing Road America", fixturePath: "fixture.bin", gameId: "iracing" as never, units: "imperial", temperatureUnit: "F", analystLap: 7, compareLaps: [6, 7] }, caseIds: ["a", "c"], observations: [obs("m", "a", "lap-analyst", [1, 1, 1, 1]), obs("m", "c", "compare-engineer", [1, 1])], failures: [failure] });
    const markdown = renderModelComparisonMarkdown(report);
    expect(markdown).toContain("| Rank | Model | Overall | Analyst | Compare | Pass rate | Mean latency | Recommendation |");
    expect(markdown).toContain("| m | c | 1 | scoring | scorer failed |");
    const serialized = JSON.parse(JSON.stringify(report));
    expect(serialized.schemaVersion).toBe(1);
    expect(serialized.dataset.id).toBe("iracing-x");
    expect(serialized.failures[0].output).toBe("partial output");
    expect(serialized.observations[0].scores[0].reason).toBe("proof");
  });
});

describe("eval factory model injection", () => {
  test("binds injected local model for both factories", async () => {
    const requestContext = new RequestContext();
    for (const agent of [buildEvalLapAnalystAgent(getMastraModelId({ provider: "local", model: "comparison-test-model", localEndpoint: "http://comparison.test/v1" })), buildEvalCompareEngineerAgent("metric", getMastraModelId({ provider: "local", model: "comparison-test-model", localEndpoint: "http://comparison.test/v1" }))]) {
      const model = await (agent as unknown as ModelLookupAgent).getModel({ requestContext }) as { provider: string; modelId: string };
      expect(model).toMatchObject({ provider: "openai.chat", modelId: "comparison-test-model" });
    }
  });
});
