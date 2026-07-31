import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";

import { loadSettings, saveSettings, type AppSettings } from "../server/settings";
import { resolveAi } from "../server/ai/ai-runtime";
import { OpenAiProviderAdapter } from "../server/ai/provider-adapters";
import { createModelContext, getModel } from "../server/ai/model-provider";
import { modelFromRequestContext } from "../mastra/model";

const originalSettings = loadSettings();

function settings(overrides: Partial<AppSettings>): AppSettings {
  return {
    ...originalSettings,
    aiProvider: "local",
    aiModel: "analysis-model",
    chatProvider: "local",
    chatModel: "chat-model",
    autoTuneProvider: "local",
    autoTuneModel: "auto-tune-model",
    driverProfileProvider: "local",
    driverProfileModel: "driver-profile-model",
    ...overrides,
  };
}

describe("settings-aware model provider", () => {
  beforeEach(() => {
    saveSettings(originalSettings);
  });

  afterEach(() => {
    saveSettings(originalSettings);
  });

  test("reuses model already bound to request context", async () => {
    const ai = await resolveAi("analysis", settings({}));
    const boundContext = createModelContext(ai, new RequestContext());
    const boundModel = modelFromRequestContext(boundContext);

    expect(boundModel).toBeDefined();
    expect(await getModel("chat", boundContext)).toBe(boundModel);
  });

  test("resolves model directly from feature settings", async () => {
    saveSettings(settings({ aiModel: "resolved-analysis-model" }));
    const resolved = await getModel("analysis");

    expect(resolved).toBeDefined();
  });

  test("selects independent model for each feature", async () => {
    const analysis = await resolveAi("analysis", settings({ aiModel: "analysis-model" }));
    const chat = await resolveAi("chat", settings({ chatModel: "chat-model" }));
    const analysisContext = createModelContext(analysis, new RequestContext());
    const chatContext = createModelContext(chat, new RequestContext());

    expect(modelFromRequestContext(analysisContext)).not.toBe(modelFromRequestContext(chatContext));
  });

  test("binds explicit provider credentials to Mastra model", () => {
    const adapter = new OpenAiProviderAdapter({
      feature: "analysis",
      model: "gpt-test",
      apiKey: "request-scoped-key",
    });

    expect(adapter.mastraModel).toBeDefined();
    expect(typeof adapter.mastraModel).toBe("object");
  });

  test("returns no Mastra context for Codex", async () => {
    const codex = await resolveAi("chat", settings({ chatProvider: "codex", chatModel: "codex-model" }));

    expect(createModelContext(codex)).toBeUndefined();
  });

  test("rejects Codex when Mastra model is requested", async () => {
    saveSettings(settings({ chatProvider: "codex", chatModel: "codex-model" }));
    const codexSettingsContext = new RequestContext();

    await expect(getModel("chat", codexSettingsContext)).rejects.toMatchObject({
      code: "unsupported-operation",
      provider: "codex",
    });
  });
});
