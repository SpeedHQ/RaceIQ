import { describe, expect, test } from "bun:test";

import { loadSettings } from "../server/settings";
import { resolveAi } from "../server/ai/ai-runtime";
import { AI_FEATURES } from "../server/ai/ai-features";
describe("AI feature registry", () => {
  test("maps all supported features to their settings", () => {
    expect(AI_FEATURES).toEqual({
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
    });
  });

  test("uses analysis provider and model as auto-tune fallback", () => {
    expect(AI_FEATURES.autoTune.fallbackFeature).toBe("analysis");
    expect(AI_FEATURES.autoTune.providerSetting).not.toBe("aiProvider");
    expect(AI_FEATURES.autoTune.modelSetting).not.toBe("aiModel");
  });

  test("reuses chat settings for compaction", () => {
    expect(AI_FEATURES.compaction).toEqual(AI_FEATURES.chat);
    expect(Object.values(AI_FEATURES).map((config) => config.providerSetting)).not.toContain("compactionProvider");
  });
  test("resolves compaction from chat settings", async () => {
    const settings = {
      ...loadSettings(),
      aiProvider: "openai" as const,
      aiModel: "analysis-model",
      chatProvider: "codex" as const,
      chatModel: "chat-model",
      chatThinkingBudget: 123,
    };

    const resolved = await resolveAi("compaction", settings);
  });
});
