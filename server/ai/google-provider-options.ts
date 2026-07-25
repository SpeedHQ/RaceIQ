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

// Setup Engineer tune chat variant: always ask Gemini for thought summaries
// (includeThoughts) so the chat can stream a live "thinking" block. Budget stays
// user-controlled (null → Gemini's own dynamic default). Kept separate from
// buildGoogleThinkingProviderOptions on purpose — flipping thoughts on here must
// not light up reasoning in the main chat panel / lap analysis, which share the
// includeThoughts:false DEFAULT_THINKING_CONFIG.
export function buildGoogleReasoningProviderOptions(modelId: string, thinkingBudget: number | null = null) {
  if (!supportsGoogleThinkingBudget(modelId)) return {};
  const thinkingConfig: { includeThoughts: true; thinkingBudget?: number } = { includeThoughts: true };
  if (thinkingBudget != null && thinkingBudget > 0) thinkingConfig.thinkingBudget = thinkingBudget;
  return { thinkingConfig };
}
