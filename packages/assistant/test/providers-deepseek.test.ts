import { describe, expect, test } from "bun:test";

import { getProviders } from "@raceiq/assistant/ai/providers";
import { AI_PROVIDERS } from "@raceiq/assistant/ai/ai-features";
import { resolveAi } from "@raceiq/assistant/ai/ai-runtime";
import { configureAiProviderEnvironment } from "@raceiq/assistant/ai/openai-compatible-provider";
import { getMastraModelId } from "@raceiq/assistant/mastra/model";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";

describe("provider registry — DeepSeek", () => {
  test("includes DeepSeek", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toContain("deepseek");
  });

  test("uses DeepSeek as the display name", () => {
    const deepseek = getProviders().find((p) => p.id === "deepseek");
    expect(deepseek?.name).toBe("DeepSeek");
  });

  test("preserves existing providers", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["gemini", "openai", "anthropic", "openai-compatible"]),
    );
  });
});

describe("provider dispatch", () => {
  test("rejects unknown providers instead of selecting another model", async () => {
    expect(() => getMastraModelId("unregistered", "test")).toThrow("Unsupported AI provider: unregistered");
    await expect(configureAiProviderEnvironment("unregistered" as never)).rejects.toMatchObject({
      code: "unsupported-provider",
      provider: "unregistered",
    });
    await expect(resolveAi("autoTune", {
      ...loadSettings(),
      autoTuneProvider: "unregistered" as never,
      autoTuneModel: "test",
    })).rejects.toMatchObject({ code: "unsupported-provider", provider: "unregistered" });
  });

  test("exposes a label and environment mapping for every registered provider", () => {
    for (const [id, provider] of Object.entries(AI_PROVIDERS)) {
      expect(provider.label).toBeTruthy();
      expect(id === "openai-compatible" ? provider.environmentKey === null : Boolean(provider.environmentKey)).toBe(true);
    }
  });
});
