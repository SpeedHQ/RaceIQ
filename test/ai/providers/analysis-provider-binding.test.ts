import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { lapAnalystAgent } from "../../../mastra/agents/lap-analyst";
import { getMastraModelId } from "../../../mastra/model";
import { RESOLVED_AI_MODEL_CONTEXT_KEY } from "../../../server/ai/resolved-ai-internals";

type ModelLookupAgent = {
  getModel(options: { requestContext: RequestContext }): Promise<unknown>;
};

describe("lap analyst provider binding", () => {
  test("uses request-scoped resolved model for structured analysis", async () => {
    const requestModel = getMastraModelId(
      "local",
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
});
