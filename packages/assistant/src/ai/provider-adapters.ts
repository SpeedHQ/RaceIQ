import { Agent } from "@mastra/core/agent";
import { AiProviderError } from "@raceiq/assistant/ai/provider-error";
import { getMastraModelId, type BoundMastraModel } from "../mastra/model";
import {
  runGeminiRequest,
  runOpenAiCompatible,
  type AiResult,
} from "@raceiq/assistant/ai/providers";
import type {
  AiFeature,
  AiProvider,
  ResolvedAi,
  StructuredRequest,
  TextRequest,
} from "@raceiq/assistant/ai/ai-types";
import { baseUrlFor } from "@raceiq/assistant/ai/provider-endpoints";
import { describeCompatibleApiFailure } from "@raceiq/assistant/ai/provider-capabilities";
import { DEFAULT_RETRY_POLICY, isRetryableStatus, parseRetryAfter, retryDelayMs } from "./provider-resilience";
import { setResolvedAiInternals } from "./resolved-ai-internals";

export type ProviderAdapterConfig = {
  feature: AiFeature;
  model: string;
  thinkingBudget?: number | null;
};

function promptFor(input: TextRequest): string {
  return input.system ? `${input.system}\n\n${input.prompt}` : input.prompt;
}

export class GeminiProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "gemini";
  readonly model: string;
  readonly mastraModel: BoundMastraModel;
  readonly #apiKey: string;
  readonly #thinkingBudget: number | null;

  constructor(config: ProviderAdapterConfig & { apiKey: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#apiKey = config.apiKey;
    this.#thinkingBudget = config.thinkingBudget ?? null;
    this.mastraModel = getMastraModelId({
      provider: this.provider,
      model: this.model,
      apiKey: this.#apiKey,
    });
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return runGeminiRequest({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      model: this.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      thinkingBudget: input.thinkingBudget ?? this.#thinkingBudget,
    });
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    return runGeminiRequest({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      model: this.model,
      schema: input.schema as unknown as object,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      thinkingBudget: input.thinkingBudget ?? this.#thinkingBudget,
    });
  }
}

export class OpenAiProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "openai";
  readonly model: string;
  readonly mastraModel: BoundMastraModel;
  readonly #apiKey: string;

  constructor(config: ProviderAdapterConfig & { apiKey: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#apiKey = config.apiKey;
    this.mastraModel = getMastraModelId({
      provider: this.provider,
      model: this.model,
      apiKey: this.#apiKey,
    });
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      model: this.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      model: this.model,
      schema: input.schema as unknown as object,
      schemaName: input.schemaName,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }
}

export class OpenAiCompatibleProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "openai-compatible";
  readonly model: string;
  readonly mastraModel: BoundMastraModel;
  readonly #endpoint: string;
  readonly #apiKey?: string;

  constructor(config: ProviderAdapterConfig & { endpoint: string; apiKey?: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#endpoint = config.endpoint;
    this.#apiKey = config.apiKey;
    this.mastraModel = getMastraModelId({
      provider: this.provider,
      model: this.model,
      localEndpoint: this.#endpoint,
      apiKey: this.#apiKey,
    });
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      endpoint: this.#endpoint,
      model: this.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      endpoint: this.#endpoint,
      model: this.model,
      schema: input.schema as unknown as object,
      schemaName: input.schemaName,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }
}

/** Claude models through Mastra's native Anthropic provider. */
export class AnthropicProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "anthropic";
  readonly model: string;
  readonly mastraModel: BoundMastraModel;
  readonly #agent: Agent;

  constructor(config: ProviderAdapterConfig & { apiKey: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#agent = new Agent({
      id: "anthropic-direct",
      name: "Anthropic direct",
      instructions: "Follow the user's instructions.",
      maxRetries: 0,
      model: getMastraModelId({ provider: this.provider, model: this.model, apiKey: config.apiKey }),
    });
    this.mastraModel = getMastraModelId({
      provider: this.provider,
      model: this.model,
      apiKey: config.apiKey,
    });
  }

  private async generate(input: TextRequest, schema?: object): Promise<AiResult> {
    const start = performance.now();
    const modelSettings = {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    };
    const generate = () => schema
      ? this.#agent.generate(promptFor(input), {
          modelSettings,
          structuredOutput: { schema: schema as never },
        })
      : this.#agent.generate(promptFor(input), { modelSettings });
    const result = await (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await generate();
        } catch (error) {
          const candidate = error as { name?: unknown; message?: unknown; statusCode?: unknown; responseHeaders?: Record<string, string> } | null;
          const status = typeof candidate?.statusCode === "number" ? candidate.statusCode : null;
          // The gateway does not expose fetch provenance, so message-only transport errors cannot be retried safely.
          if (candidate?.name === "AbortError" || attempt >= DEFAULT_RETRY_POLICY.maxAttempts ||
              status === null || !isRetryableStatus(status)) throw error;
          const retryAfter = parseRetryAfter(candidate?.responseHeaders?.["retry-after"]);
          if (retryAfter !== null && retryAfter > DEFAULT_RETRY_POLICY.maxRetryAfterMs) throw error;
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, retryDelayMs(attempt, DEFAULT_RETRY_POLICY, Math.random, retryAfter));
          await promise;
        }
      }
    })().catch((error: unknown) => {
      if (error instanceof AiProviderError) throw error;
      if (typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number") {
        const statusCode = error.statusCode;
        throw new AiProviderError(describeCompatibleApiFailure("anthropic", statusCode), {
          code: "upstream",
          provider: "anthropic",
          modelId: this.model,
          statusCode,
          isRetryable: statusCode >= 500 || statusCode === 429,
          responseBody: "responseBody" in error && typeof error.responseBody === "string" ? error.responseBody : undefined,
        });
      }
      throw error;
    });
    const analysis = schema ? JSON.stringify(result.object) : result.text?.trim();
    if (!analysis) throw new AiProviderError("Anthropic returned empty response", { code: "upstream", provider: "anthropic" });
    return {
      analysis,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        costUsd: 0,
        durationMs: Math.round(performance.now() - start),
        model: this.model,
      },
    };
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return this.generate(input);
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    return this.generate(input, input.schema as object);
  }
}

/** DeepSeek through its OpenAI-compatible API at a fixed endpoint. */
export class DeepSeekProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "deepseek";
  readonly model: string;
  readonly mastraModel: BoundMastraModel;
  readonly #apiKey: string;
  readonly #endpoint = baseUrlFor("deepseek") ?? "https://api.deepseek.com";

  constructor(config: ProviderAdapterConfig & { apiKey: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#apiKey = config.apiKey;
    this.mastraModel = getMastraModelId({
      provider: this.provider,
      model: this.model,
      apiKey: this.#apiKey,
    });
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      endpoint: this.#endpoint,
      model: this.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      apiKey: this.#apiKey,
      endpoint: this.#endpoint,
      model: this.model,
      schema: input.schema as unknown as object,
      schemaName: input.schemaName,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }
}

export type AnyProviderAdapter =
  | GeminiProviderAdapter
  | OpenAiProviderAdapter
  | AnthropicProviderAdapter
  | DeepSeekProviderAdapter
  | OpenAiCompatibleProviderAdapter;

export function resolvedAiFromAdapter(adapter: AnyProviderAdapter): ResolvedAi {
  const resolved: ResolvedAi = {
    feature: adapter.feature,
    provider: adapter.provider,
    model: adapter.model,
    generateText: adapter.generateText.bind(adapter),
    generateStructured: adapter.generateStructured.bind(adapter),
  };
  setResolvedAiInternals(resolved, {
    model: "mastraModel" in adapter ? adapter.mastraModel : undefined,
  });
  return resolved;
}
export function unsupportedAiOperation(feature: AiFeature, provider: AiProvider, operation: string): never {
  throw new AiProviderError(
    `${operation} is not supported for ${provider} provider on ${feature} feature.`,
    { code: "unsupported-operation", provider },
  );
}
