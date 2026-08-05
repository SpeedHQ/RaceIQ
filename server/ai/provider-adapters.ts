import { AiProviderError } from "./provider-error";
import { getMastraModelId, type BoundMastraModel } from "../../mastra/model";
import {
  runGeminiRequest,
  runOpenAiCompatible,
  type AiResult,
} from "./providers";
import type {
  AiFeature,
  AiProvider,
  ResolvedAi,
  StructuredRequest,
  TextRequest,
} from "./ai-types";
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

export class LocalProviderAdapter {
  readonly feature: AiFeature;
  readonly provider: AiProvider = "local";
  readonly model: string;
  readonly mastraModel: BoundMastraModel;
  readonly #endpoint: string;

  constructor(config: ProviderAdapterConfig & { endpoint: string }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#endpoint = config.endpoint;
    this.mastraModel = getMastraModelId({
      provider: this.provider,
      model: this.model,
      localEndpoint: this.#endpoint,
    });
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


export type AnyProviderAdapter =
  | GeminiProviderAdapter
  | OpenAiProviderAdapter
  | LocalProviderAdapter;

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
