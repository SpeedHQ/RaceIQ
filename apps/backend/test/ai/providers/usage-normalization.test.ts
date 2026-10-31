import { expect, test } from "bun:test";
import { normalizeAiUsage } from "@raceiq/backend-core/ai/usage";
import { runGeminiRequest, runOpenAiCompatible } from "@raceiq/backend-core/ai/providers";

test("usage normalization preserves unknowns and real zeros with measured duration fallback", () => {
  expect(normalizeAiUsage({ inputTokens: null, outputTokens: 0, costUsd: null }, "test-model", 17)).toEqual({ inputTokens: null, outputTokens: 0, costUsd: null, durationMs: 17, model: "test-model" });
});

test("usage aliases preserve reported zeros while invalid metrics stay unavailable", () => {
  expect(normalizeAiUsage({ inputTokens: -1, promptTokens: 0, outputTokens: 1.5, completionTokens: 42, costUsd: NaN, durationMs: Infinity }, "test-model", 0)).toEqual({
    inputTokens: 0,
    outputTokens: 42,
    costUsd: null,
    durationMs: 0,
    model: "test-model",
  });
  expect(normalizeAiUsage(undefined, "test-model", -1)).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, durationMs: null, model: "test-model" });
});

test.each(["gemini", "openai-compatible"] as const)("%s does not invent missing provider counters or monetary cost", async (provider) => {
  const original = globalThis.fetch;
  let reported = false;
  globalThis.fetch = new Proxy(original, {
    apply: () =>
      Promise.resolve(
        Response.json(
          provider === "gemini"
            ? { candidates: [{ content: { parts: [{ text: "fixture" }] } }], usageMetadata: reported ? { promptTokenCount: 0, candidatesTokenCount: 0 } : undefined }
            : { choices: [{ message: { content: "fixture" } }], usage: reported ? { prompt_tokens: 0, completion_tokens: 0 } : undefined },
        ),
      ),
  });
  try {
    const generate = () =>
      provider === "gemini"
        ? runGeminiRequest({ prompt: "fixture", apiKey: "fixture-key", model: "fixture-model" })
        : runOpenAiCompatible({ prompt: "fixture", endpoint: "http://fixture.invalid/v1", model: "fixture-model" });
    const result = await generate();
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
    reported = true;
    expect((await generate()).usage).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null });
  } finally {
    globalThis.fetch = original;
  }
});
