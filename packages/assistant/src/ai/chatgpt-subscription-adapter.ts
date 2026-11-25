import { Agent } from "@mastra/core/agent";
import { AiProviderError } from "@raceiq/assistant/ai/provider-error";
import type { AiFeature, AiResult, StructuredRequest, TextRequest } from "@raceiq/assistant/ai/ai-types";
import { z } from "zod";
import { bindMastraModel } from "../mastra/model";
import type { ChatGptAccountBinding } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { createChatGptSubscriptionModel } from "./chatgpt-subscription-model";
import { consumeMastraGeneration } from "./stream-mastra-generation";

const usageSchema = z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() });

export class ChatGptSubscriptionAdapter {
  readonly provider = "chatgpt-subscription";
  readonly feature: AiFeature;
  readonly model: string;
  readonly mastraModel;

  constructor(
    feature: AiFeature,
    model: string,
    binding: ChatGptAccountBinding,
    modelOptions?: Parameters<typeof createChatGptSubscriptionModel>[3],
  ) {
    this.feature = feature;
    this.model = model;
    this.mastraModel = bindMastraModel(createChatGptSubscriptionModel(model, async () => ({
      accessToken: await binding.token(), signal: binding.signal,
    }), undefined, modelOptions));
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return this.#generate(input);
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    return this.#generate(input, input.schema);
  }

  async #generate(input: TextRequest, schema?: unknown): Promise<AiResult> {
    const started = performance.now();
    const agent = new Agent({ id: "chatgpt-subscription", name: "ChatGPT subscription", instructions: "", model: this.mastraModel });
    const options = { system: input.system, modelSettings: { maxRetries: 0 } };
    const stream = schema === undefined
      ? agent.stream(input.prompt, options)
      : agent.stream(input.prompt, { ...options, structuredOutput: { schema: schema as never, jsonPromptInjection: false } });
    const result = await consumeMastraGeneration(stream, schema !== undefined);
    const analysis = schema === undefined ? result.text : JSON.stringify(result.object);
    if (!analysis) throw new AiProviderError("ChatGPT returned no output. Try again.", { code: "upstream", provider: this.provider, modelId: this.model });
    const usage = usageSchema.safeParse(result.usage);
    return {
      analysis,
      usage: {
        inputTokens: usage.success ? usage.data.inputTokens ?? 0 : 0,
        outputTokens: usage.success ? usage.data.outputTokens ?? 0 : 0,
        costUsd: 0,
        durationMs: Math.round(performance.now() - started),
        model: this.model,
      },
    };
  }
}
