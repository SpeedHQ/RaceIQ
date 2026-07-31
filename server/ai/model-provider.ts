import { RequestContext } from "@mastra/core/request-context";

import type {
  AiFeature,
  AiResult,
  ChatRequest,
  ResolvedAi,
  StructuredRequest,
} from "./ai-types";
import { resolveAi } from "./ai-runtime";
import { AiProviderError } from "./provider-error";
import {
  getResolvedAiInternals,
  RESOLVED_AI_MODEL_CONTEXT_KEY,
} from "./resolved-ai-internals";
import {
  modelFromRequestContext,
  type BoundMastraModel,
  type MastraRequestContext,
} from "../../mastra/model";

/**
 * Resolve the Mastra model for one feature. A model already bound to this
 * request wins so request-scoped credentials and endpoints remain intact.
 */
export async function getModel(
  feature: AiFeature,
  requestContext?: MastraRequestContext,
): Promise<BoundMastraModel> {
  const boundModel = modelFromRequestContext(requestContext);
  if (boundModel !== undefined) return boundModel;

  const ai = await resolveAi(feature);
  const model = getResolvedAiInternals(ai)?.model;
  if (model !== undefined) return model;

  throw new AiProviderError(
    `Mastra model is not supported for ${ai.provider} provider on ${feature} feature.`,
    {
      code: "unsupported-operation",
      provider: ai.provider,
      modelId: ai.model,
    },
  );
}

/**
 * Bind a resolved provider model to a request context without exposing
 * provider credentials or configuration to Mastra agents.
 */
export function createModelContext(
  ai: ResolvedAi,
  context?: RequestContext,
): RequestContext | undefined {
  const model = getResolvedAiInternals(ai)?.model;
  if (model === undefined) return undefined;

  const requestContext = context ?? new RequestContext();
  requestContext.set(RESOLVED_AI_MODEL_CONTEXT_KEY, model);
  return requestContext;
}

type MastraResult = {
  analysis?: unknown;
  text?: unknown;
  object?: unknown;
  usage?: unknown;
};

function usageFor(result: MastraResult["usage"], model: string): AiResult["usage"] {
  const usage = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const numberFor = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof usage[key] === "number") return usage[key] as number;
    }
    return 0;
  };
  return {
    inputTokens: numberFor("inputTokens", "promptTokens"),
    outputTokens: numberFor("outputTokens", "completionTokens"),
    costUsd: numberFor("costUsd"),
    durationMs: numberFor("durationMs"),
    model,
  };
}

function textFor(result: MastraResult): string {
  if (typeof result.analysis === "string") return result.analysis;
  if (typeof result.text === "string") return result.text;
  if (result.object !== undefined) {
    return typeof result.object === "string" ? result.object : JSON.stringify(result.object) ?? "";
  }
  return "";
}

export async function runAiChat(
  ai: ResolvedAi,
  input: ChatRequest,
  runMastra: (context: RequestContext) => Promise<Response>,
): Promise<Response> {
  const nativeChat = getResolvedAiInternals(ai)?.createChatResponse;
  if (nativeChat) return nativeChat(input);

  const context = createModelContext(ai);
  if (!context) {
    throw new AiProviderError(
      `Chat is not supported for ${ai.provider} provider on ${ai.feature} feature.`,
      { code: "unsupported-operation", provider: ai.provider, modelId: ai.model },
    );
  }
  return runMastra(context);
}

export async function runAiStructured(
  ai: ResolvedAi,
  input: StructuredRequest<unknown>,
  runMastra: (context: RequestContext) => Promise<unknown>,
): Promise<AiResult> {
  const internals = getResolvedAiInternals(ai);
  if (!internals?.model) return ai.generateStructured(input);

  const context = createModelContext(ai);
  if (!context) {
    throw new AiProviderError(
      `Structured generation is not supported for ${ai.provider} provider on ${ai.feature} feature.`,
      { code: "unsupported-operation", provider: ai.provider, modelId: ai.model },
    );
  }
  const result = await runMastra(context) as MastraResult;
  if (
    typeof result.analysis === "string"
    && result.usage
    && typeof result.usage === "object"
    && "costUsd" in result.usage
    && "durationMs" in result.usage
    && "model" in result.usage
  ) {
    return result as AiResult;
  }
  return {
    analysis: textFor(result),
    usage: usageFor(result.usage, ai.model),
  };
}
