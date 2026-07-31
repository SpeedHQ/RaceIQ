import { RequestContext } from "@mastra/core/request-context";

import type { AiFeature, ResolvedAi } from "./ai-types";
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
