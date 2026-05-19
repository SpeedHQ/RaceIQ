type JsonSchema = Record<string, unknown>;

const DEFAULT_THINKING_CONFIG = { thinkingBudget: 2048, includeThoughts: false } as const;

export function supportsGoogleThinkingBudget(modelId: string): boolean {
  const model = modelId.trim().toLowerCase();
  if (model.length === 0) return true;
  return !model.startsWith("gemma-") && !model.includes("/gemma-");
}

export function buildGoogleProviderOptions(modelId: string, responseSchema: JsonSchema, thinkingBudget: number | null = null) {
  if (!supportsGoogleThinkingBudget(modelId)) {
    return {
      responseMimeType: "application/json",
      responseSchema,
    };
  }

  if (thinkingBudget == null || thinkingBudget <= 0) {
    return {
      responseMimeType: "application/json",
      responseSchema,
    };
  }
  return {
    thinkingConfig: { thinkingBudget, includeThoughts: DEFAULT_THINKING_CONFIG.includeThoughts },
    responseMimeType: "application/json",
    responseSchema,
  };
}
export function buildGoogleThinkingProviderOptions(modelId: string, thinkingBudget: number | null = null) {
  if (!supportsGoogleThinkingBudget(modelId)) return {};
  if (thinkingBudget == null || thinkingBudget <= 0) return {};
  return {
    thinkingConfig: { thinkingBudget, includeThoughts: DEFAULT_THINKING_CONFIG.includeThoughts },
  };
}
