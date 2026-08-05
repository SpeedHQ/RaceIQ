import { describe, expect, test } from "bun:test";
import { extractLmStudioContextLengths } from "../server/ai/providers";

describe("LM Studio context discovery", () => {
  test("uses loaded runtime context instead of model maximum", () => {
    const contexts = extractLmStudioContextLengths({
      models: [
        {
          key: "qwen/qwen3.5-9b",
          max_context_length: 262144,
          loaded_instances: [{ id: "qwen/qwen3.5-9b", config: { context_length: 8192 } }],
        },
      ],
    });

    expect(contexts.get("qwen/qwen3.5-9b")).toBe(8192);
  });
});
