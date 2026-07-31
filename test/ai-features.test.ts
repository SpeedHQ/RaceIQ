import { describe, expect, mock, test } from "bun:test";

import { loadSettings } from "../server/settings";
import { AI_FEATURES } from "../server/ai/ai-features";

const secrets: Record<string, string> = {};
mock.module("../server/keystore", () => ({
  getSecret: async (key: string) => secrets[key] ?? "",
  setSecret: async (key: string, value: string) => {
    if (value) secrets[key] = value;
    else delete secrets[key];
  },
  deleteSecret: async (key: string) => {
    delete secrets[key];
  },
}));

const { resolveAi } = await import("../server/ai/ai-runtime");
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
  test("resolves compaction from chat settings and carries thinking budget to Gemini", async () => {
    secrets["gemini-api-key"] = "gemini-compaction";
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "compacted response" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const settings = {
        ...loadSettings(),
        aiProvider: "openai" as const,
        aiModel: "analysis-model",
        chatProvider: "gemini" as const,
        chatModel: "gemini-2.5-pro",
        chatThinkingBudget: 123,
      };

      const resolved = await resolveAi("compaction", settings);
      expect(resolved.feature).toBe("compaction");
      expect(resolved.provider).toBe("gemini");
      expect(resolved.model).toBe("gemini-2.5-pro");
      expect(AI_FEATURES[resolved.feature].thinkingBudgetSetting).toBe("chatThinkingBudget");
      expect(settings[AI_FEATURES[resolved.feature].thinkingBudgetSetting]).toBe(123);

      await resolved.generateText({ prompt: "compact this context" });
      expect(requestBody?.generationConfig).toMatchObject({
        thinkingConfig: { thinkingBudget: 123, includeThoughts: false },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
