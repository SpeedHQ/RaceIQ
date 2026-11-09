import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { lapAnalystAgent } from "../../../src/mastra/agents/lap-analyst";
import { getMastraModelId } from "@raceiq/assistant/mastra/model";
import { RESOLVED_AI_MODEL_CONTEXT_KEY } from "@raceiq/assistant/ai/resolved-ai-internals";

type ModelLookupAgent = {
  getModel(options: { requestContext: RequestContext }): Promise<unknown>;
};

describe("lap analyst provider binding", () => {
  test("uses request-scoped resolved model for structured analysis", async () => {
    const requestModel = getMastraModelId(
      "openai-compatible",
      "request-model",
      "http://request-scoped.test/v1",
    );
    const requestContext = new RequestContext();
    requestContext.set(RESOLVED_AI_MODEL_CONTEXT_KEY, requestModel);
    const model = (await (
      lapAnalystAgent as unknown as ModelLookupAgent
    ).getModel({
      requestContext,
    })) as { provider: string; modelId: string };

    expect(model.provider).toBe("openai.chat");
    expect(model.modelId).toBe("request-model");
  });

  test.each([
    ["gemini", "GOOGLE_GENERATIVE_AI_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"],
  ])("rejects inherited %s credentials without a bound key", (provider, name) => {
    const original = process.env[name];
    try {
      process.env[name] = "untrusted-environment-key";
      expect(() => getMastraModelId(provider, "test-model")).toThrow("API key not set");
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });
});
