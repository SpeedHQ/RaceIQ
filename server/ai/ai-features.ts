export type AiFeature = "analysis" | "chat" | "autoTune" | "driverProfile" | "compaction";
export type AiProvider = "gemini" | "openai" | "openai-compatible";

export type AiFeatureConfig = {
  providerSetting: "aiProvider" | "chatProvider" | "autoTuneProvider" | "driverProfileProvider";
  modelSetting: "aiModel" | "chatModel" | "autoTuneModel" | "driverProfileModel";
  thinkingBudgetSetting: "aiThinkingBudget" | "chatThinkingBudget" | "driverProfileThinkingBudget";
  fallbackFeature?: "analysis";
};

/**
 * Single source of truth for which settings drive each AI feature.
 *
 * Auto-tune retains dedicated provider/model fields but falls back to analysis
 * when those fields are empty. Compaction intentionally reuses chat settings.
 */
export const AI_FEATURES: Record<AiFeature, AiFeatureConfig> = {
  analysis: {
    providerSetting: "aiProvider",
    modelSetting: "aiModel",
    thinkingBudgetSetting: "aiThinkingBudget",
  },
  chat: {
    providerSetting: "chatProvider",
    modelSetting: "chatModel",
    thinkingBudgetSetting: "chatThinkingBudget",
  },
  autoTune: {
    providerSetting: "autoTuneProvider",
    modelSetting: "autoTuneModel",
    thinkingBudgetSetting: "aiThinkingBudget",
    fallbackFeature: "analysis",
  },
  driverProfile: {
    providerSetting: "driverProfileProvider",
    modelSetting: "driverProfileModel",
    thinkingBudgetSetting: "driverProfileThinkingBudget",
  },
  compaction: {
    providerSetting: "chatProvider",
    modelSetting: "chatModel",
    thinkingBudgetSetting: "chatThinkingBudget",
  },
};
