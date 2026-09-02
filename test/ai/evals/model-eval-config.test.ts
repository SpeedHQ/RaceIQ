import { describe, expect, test } from "bun:test";
import { modelEvalModelIds } from "../../../mastra/evals/model-eval-config";

describe("model eval model selection", () => {
  test("includes correctness judge model in candidate test list", () => {
    expect(modelEvalModelIds([], true, "google/gemma-4-12b-qat")).toEqual([
      "prism-ml/bonsai-27b",
      "qwen/qwen3.5-9b",
      "google/gemma-4-12b-qat",
    ]);
  });
});
