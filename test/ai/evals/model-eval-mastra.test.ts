import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import { Mastra } from "@mastra/core";
import { MastraScorer } from "@mastra/core/evals";
import { MastraCompositeStore } from "@mastra/core/storage";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";
import { Observability, DefaultExporter } from "@mastra/observability";
import { RESOLVED_AI_MODEL_CONTEXT_KEY } from "../../../server/ai/resolved-ai-internals";
import { modelFromRequestContext, type MastraRequestContext } from "../../../mastra/model";

// @mastra/core's bundled mock imports Vitest as a side effect. Bun's module
// mocking lets this test use the real Mastra mock model without adding Vitest.
mock.module("vitest", () => ({
  vi: {
    fn: (implementation?: Function) => implementation ?? (() => undefined),
  },
}));
// Load after mock.module so bundled Vitest side effect resolves under Bun.
const { createMockModel } = await import("@mastra/core/test-utils/llm-mock");
const deterministicModel = createMockModel({
  mockText: "persistence test passed.",
});
const { lapAnalystAgent } = await import("../../../mastra/agents/lap-analyst");
const originalLapAnalystModel = (lapAnalystAgent as unknown as { model: unknown }).model;
// Keep transport deterministic while exercising production agent registration.
(lapAnalystAgent as unknown as { model: unknown }).model = () => deterministicModel;

  test("runner-shaped context resolves local model through production resolver", () => {
    const requestContext = {
      [RESOLVED_AI_MODEL_CONTEXT_KEY]: {
        provider: "local",
        model: "local-model",
        localEndpoint: "http://localhost:1234/v1",
      },
    } as unknown as MastraRequestContext;
    const model = modelFromRequestContext(requestContext);
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });
test("model-eval runner imports native fixture registry", async () => {
  const source = await Bun.file(new URL("../../../scripts/quality/run-model-eval.ts", import.meta.url)).text();
  expect(source).toMatch(/import \{[^}]*MODEL_EVAL_FIXTURES[^}]*\} from "\.\.\/\.\.\/mastra\/evals\/model-eval-datasets";/);
});
describe("Mastra native evaluation targets", () => {
  test("persists production agent experiment result, trace, and score", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-mastra-test-"));
    try {
      const scorer = new MastraScorer({
        id: "native-test-deterministic",
        description: "Deterministic persistence test scorer",
      })
        .generateScore(() => 1)
        .generateReason(() => "deterministic pass");
      const mastra = new Mastra({
        agents: { "lap-analyst": lapAnalystAgent },
        scorers: { [scorer.id]: scorer },
        storage: new MastraCompositeStore({
          id: "native-test-composite",
          default: new LibSQLStore({
            id: "native-test-storage",
            url: `file:${join(directory, "mastra.db")}`,
          }),
          domains: {
            observability: await new DuckDBStore({
              path: join(directory, "observability.duckdb"),
            }).getStore("observability"),
          },
        }),
        observability: new Observability({
          configs: {
            default: { serviceName: "native-test", exporters: [new DefaultExporter()] },
          },
        }),
      });
      const dataset = await mastra.datasets.create({
        id: "native-lap-analyst-test",
        name: "Native lap analyst persistence test",
        targetType: "agent",
        targetIds: ["lap-analyst"],
        scorerIds: [scorer.id],
      });
      const item = await dataset.addItem({
        externalId: "native-test-item",
        input: "Reply with exactly: persistence test passed.",
      });
      const requestContext = {
        get: (key: string) => key === RESOLVED_AI_MODEL_CONTEXT_KEY ? deterministicModel : undefined,
        [RESOLVED_AI_MODEL_CONTEXT_KEY]: deterministicModel,
      };
      const summary = await dataset.startExperiment({
        targetType: "agent",
        targetId: "lap-analyst",
        scorers: [scorer.id],
        requestContext,
        maxConcurrency: 1,
        maxRetries: 0,
      });
      expect(summary.status).toBe("completed");

      const persisted = await dataset.listExperimentResults({
        experimentId: summary.experimentId,
        page: 0,
        perPage: 10,
      });
      expect(persisted.results).toHaveLength(1);
      const result = persisted.results[0];
      expect(result.itemId).toBe(item.id);
      expect(result.traceId).toEqual(expect.any(String));
      expect(result.traceId).not.toBe("");

      const storage = await mastra.getStorage();
      const scores = await storage?.getStore("scores");
      expect(scores).toBeDefined();
      const persistedScores = await scores!.listScoresByRunId({
        runId: summary.experimentId,
        pagination: { page: 0, perPage: 10 },
      });
      expect(persistedScores.scores).toHaveLength(1);
      expect(persistedScores.scores[0]?.score).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
      (lapAnalystAgent as unknown as { model: unknown }).model = originalLapAnalystModel;
    }
  });
});
