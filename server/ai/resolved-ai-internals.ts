import type { BoundMastraModel } from "../../mastra/model";
import type { ResolvedAi } from "./ai-types";

/** RequestContext key owned by the central model resolver. */
export const RESOLVED_AI_MODEL_CONTEXT_KEY = "__raceiq_resolved_ai_model";

export type ResolvedAiInternals = {
  model?: BoundMastraModel;
};

const internalsByResolvedAi = new WeakMap<ResolvedAi, ResolvedAiInternals>();

export function setResolvedAiInternals(ai: ResolvedAi, internals: ResolvedAiInternals): void {
  internalsByResolvedAi.set(ai, internals);
}

export function getResolvedAiInternals(ai: ResolvedAi): ResolvedAiInternals | undefined {
  return internalsByResolvedAi.get(ai);
}
