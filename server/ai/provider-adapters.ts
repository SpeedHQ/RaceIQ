import { createCodexChatResponse } from "./codex-chat-stream";
import { AiProviderError } from "./provider-error";
import {
  runCodexCli,
  runGeminiRequest,
  runOpenAiCompatible,
  type AiResult,
} from "./providers";
import type {
  AiFeature,
  AiProvider,
  ChatRequest,
  ResolvedAi,
  StructuredRequest,
  TextRequest,
} from "./ai-types";
export { createCodexChatResponse } from "./codex-chat-stream";
export { getCodexStatus, parseCodexJsonl, runCodexCli } from "./providers";
export type { CodexCliOptions, CodexResult, CodexStatus } from "./providers";

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
  readonly #apiKey: string;
  readonly #thinkingBudget: number | null;

  constructor(config: ProviderAdapterConfig & { apiKey: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#apiKey = config.apiKey;
    this.#thinkingBudget = config.thinkingBudget ?? null;
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
  readonly #apiKey: string;

  constructor(config: ProviderAdapterConfig & { apiKey: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#apiKey = config.apiKey;
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

export class LocalProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "local";
  readonly model: string;
  readonly #endpoint: string;

  constructor(config: ProviderAdapterConfig & { endpoint: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#endpoint = config.endpoint;
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      endpoint: this.#endpoint,
      model: this.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    return runOpenAiCompatible({
      prompt: promptFor(input),
      endpoint: this.#endpoint,
      model: this.model,
      schema: input.schema as unknown as object,
      schemaName: input.schemaName,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    });
  }
}

export class CodexProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "codex";
  readonly model: string;

  constructor(config: ProviderAdapterConfig) {
    this.feature = config.feature;
    this.model = config.model;
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return runCodexCli(promptFor(input), this.model);
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    const schema = JSON.stringify(input.schema);
    const prompt = `${promptFor(input)}\n\nReturn only JSON matching this schema:\n${schema}`;
    return runCodexCli(prompt, this.model);
  }

  createChatResponse(input: ChatRequest): Promise<Response> {
    return createCodexChatResponse({
      systemPrompt: input.systemPrompt,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      model: this.model,
    });
  }
}

export type AnyProviderAdapter =
  | GeminiProviderAdapter
  | OpenAiProviderAdapter
  | LocalProviderAdapter
  | CodexProviderAdapter;

export function resolvedAiFromAdapter(adapter: AnyProviderAdapter): ResolvedAi {
  const resolved: ResolvedAi = {
    feature: adapter.feature,
    provider: adapter.provider,
    model: adapter.model,
    generateText: adapter.generateText.bind(adapter),
    generateStructured: adapter.generateStructured.bind(adapter),
  };
  if (adapter instanceof CodexProviderAdapter) {
    resolved.createChatResponse = adapter.createChatResponse.bind(adapter);
  }
  return resolved;
}

export function unsupportedAiOperation(feature: AiFeature, provider: AiProvider, operation: string): never {
  throw new AiProviderError(
    `${operation} is not supported for ${provider} provider on ${feature} feature.`,
    { code: "unsupported-operation", provider },
  );
}
